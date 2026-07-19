/**
 * Per-encounter runtime: event routing, the graph update algorithm (spec §14),
 * warning reconciliation, latency measurement, and state publication.
 *
 * Concurrency: one mutex per encounter serializes finalized-turn processing so
 * two turns can never interleave graph updates (spec §19.5).
 * Idempotency: duplicate event IDs / provider item IDs are rejected before any
 * state changes (spec §19.6).
 */
import { Settings } from './config.ts';
import { DeterministicExtractor } from './deterministicExtractor.ts';
import { EncounterEventStore } from './eventStore.ts';
import { EvidenceIndex } from './evidenceIndex.ts';
import { ExtractionError, MedicationContextExtractor } from './extractor.ts';
import { EncounterGraphReducer, GraphState } from './graphReducer.ts';
import { GraphValidator } from './graphValidator.ts';
import {
  EncounterSnapshot,
  EventType,
  PrescriptionProposal,
  ResultState,
  Speaker,
  TranscriptTurn,
  TurnLatency,
  WarningRecord,
  activeAssertions,
  activeWarnings,
  makeEncounterSnapshot,
  newId,
  utcnow,
} from './models.ts';
import { ConceptNormalizer } from './normalizer.ts';
import { ReconcileOutcome, WarningEngine } from './warningEngine.ts';

export class DuplicateEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateEventError';
  }
}

/** Serializes async critical sections per encounter (asyncio.Lock equivalent). */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Minimal WebSocket-ish subscriber contract used for broadcasting. */
export interface JsonSubscriber {
  send(data: string): void;
}

export class EncounterRuntime {
  store: EncounterEventStore;
  lock = new Mutex();
  snapshot: EncounterSnapshot;
  warnings: WarningRecord[] = [];
  latencies: TurnLatency[] = [];
  subscribers = new Set<JsonSubscriber>();
  active_speaker: Speaker = Speaker.PATIENT;
  created_at = utcnow();

  constructor(
    public encounter_id: string,
    public synthetic_demo: boolean = true,
  ) {
    this.store = new EncounterEventStore(encounter_id);
    this.snapshot = makeEncounterSnapshot({ encounter_id, synthetic_demo });
  }
}

export class EncounterService {
  fallbackExtractor: DeterministicExtractor;
  normalizer: ConceptNormalizer;
  reducer: EncounterGraphReducer;
  validator: GraphValidator;
  warningEngine: WarningEngine;
  encounters = new Map<string, EncounterRuntime>();

  constructor(
    public settings: Settings,
    public index: EvidenceIndex,
    public extractor: MedicationContextExtractor,
  ) {
    this.fallbackExtractor = new DeterministicExtractor(index);
    this.normalizer = new ConceptNormalizer(index);
    this.reducer = new EncounterGraphReducer(index);
    this.validator = new GraphValidator(index);
    this.warningEngine = new WarningEngine(index);
  }

  // -- lifecycle -----------------------------------------------------------

  createEncounter(syntheticDemo = true): EncounterRuntime {
    const encounterId = newId('enc');
    const runtime = new EncounterRuntime(encounterId, syntheticDemo);
    this.encounters.set(encounterId, runtime);
    return runtime;
  }

  get(encounterId: string): EncounterRuntime {
    const runtime = this.encounters.get(encounterId);
    if (!runtime) {
      throw new Error(`unknown encounter ${encounterId}`);
    }
    return runtime;
  }

  async startSession(runtime: EncounterRuntime): Promise<void> {
    await runtime.lock.run(async () => {
      runtime.store.append(EventType.SESSION_STARTED, { synthetic_demo: runtime.synthetic_demo });
      await this.recompute(runtime, null);
    });
  }

  async stopSession(runtime: EncounterRuntime): Promise<void> {
    await runtime.lock.run(async () => {
      runtime.store.append(EventType.SESSION_STOPPED, {});
      await this.recompute(runtime, null);
    });
  }

  async resetEncounter(runtime: EncounterRuntime): Promise<void> {
    await runtime.lock.run(async () => {
      runtime.store.append(EventType.SESSION_RESET, {});
      runtime.warnings = [];
      runtime.latencies = [];
      await this.recompute(runtime, null);
    });
  }

  async changeSpeaker(runtime: EncounterRuntime, speaker: Speaker): Promise<void> {
    runtime.active_speaker = speaker;
    runtime.store.append(EventType.SPEAKER_CHANGED, { speaker }, { speaker });
  }

  // -- transcript events ---------------------------------------------------

  /** Partials update captions only. They never touch the graph (spec §7.4). */
  recordPartial(runtime: EncounterRuntime, text: string, speaker: Speaker): void {
    if (this.settings.store_transcripts) {
      runtime.store.append(EventType.TRANSCRIPT_PARTIAL_RECEIVED, { text }, { speaker });
    }
  }

  async processFinalTurn(
    runtime: EncounterRuntime,
    args: {
      event_id: string;
      text: string;
      speaker: Speaker;
      sequence?: number | null;
      provider_item_id?: string | null;
      started_at_ms?: number | null;
      ended_at_ms?: number | null;
    },
  ): Promise<EncounterSnapshot> {
    return runtime.lock.run(async () => {
      if (runtime.store.hasEventId(args.event_id)) {
        throw new DuplicateEventError(`duplicate event_id ${args.event_id}`);
      }
      if (args.provider_item_id && runtime.store.hasProviderItem(args.provider_item_id)) {
        throw new DuplicateEventError(`duplicate provider_item_id ${args.provider_item_id}`);
      }
      if (!args.text.trim()) {
        throw new RangeError('final transcript text is empty');
      }
      if (runtime.snapshot.status === 'stopped') {
        return runtime.snapshot;
      }

      const receivedAt = utcnow();
      const t0 = performance.now();

      const seq = args.sequence ?? runtime.store.nextSequence();
      const arrivedLate = runtime.store
        .eventsOf(EventType.TRANSCRIPT_FINAL_RECEIVED)
        .some((e) => e.sequence > seq);
      const turn: TranscriptTurn = {
        turn_id: `turn-${seq}`,
        provider_item_id: args.provider_item_id ?? null,
        sequence: seq,
        speaker: args.speaker,
        text: args.text,
        is_final: true,
        started_at_ms: args.started_at_ms ?? null,
        ended_at_ms: args.ended_at_ms ?? null,
        received_at: receivedAt,
        arrived_late: arrivedLate,
      };
      runtime.store.append(
        EventType.TRANSCRIPT_FINAL_RECEIVED,
        { turn },
        {
          eventId: args.event_id,
          providerItemId: args.provider_item_id ?? null,
          speaker: args.speaker,
          sequence: seq,
        },
      );

      // Realtime feedback: the UI shows the turn as in-analysis until the
      // recompute publishes the next result (matters for live-model latency).
      this.broadcast(runtime, {
        type: 'result.processing',
        turn_id: turn.turn_id,
        speaker: args.speaker,
      });

      // Structured extraction with validated output; deterministic fallback on failure.
      let extraction;
      try {
        extraction = await this.extractor.extract(turn);
      } catch (err) {
        if (!(err instanceof ExtractionError)) throw err;
        runtime.store.append(
          EventType.EXTRACTION_FAILED,
          { turn_id: turn.turn_id, error: String(err.message) },
          { speaker: args.speaker },
        );
        if (this.settings.extraction_fallback_deterministic) {
          extraction = await this.fallbackExtractor.extract(turn);
          extraction = { ...extraction, extraction_method: 'deterministic_fallback' };
        } else {
          const snapshot = this.snapshotWithError(runtime);
          this.broadcast(runtime, {
            type: 'processing.error',
            detail:
              'Extraction failed for the last turn. The transcript is retained; no medical content was generated.',
          });
          return snapshot;
        }
      }

      const normalized = this.normalizer.normalize(extraction.mentions);
      const t1 = performance.now();

      runtime.store.append(
        EventType.MENTIONS_EXTRACTED,
        {
          turn_id: turn.turn_id,
          extraction_method: extraction.extraction_method,
          extraction_model: extraction.extraction_model,
          normalized_mentions: normalized,
          corrections: extraction.corrections,
          missing_information: extraction.missing_information,
        },
        { speaker: args.speaker },
      );

      return this.recompute(runtime, turn, [t0, t1]);
    });
  }

  // -- proposals -----------------------------------------------------------

  async proposePrescription(
    runtime: EncounterRuntime,
    args: { event_id: string; surface_text: string },
  ): Promise<EncounterSnapshot> {
    return runtime.lock.run(async () => {
      if (runtime.store.hasEventId(args.event_id)) {
        throw new DuplicateEventError(`duplicate event_id ${args.event_id}`);
      }
      const conceptId = this.index.alias_to_medication[args.surface_text.toLowerCase().trim()] ?? null;
      const proposal: PrescriptionProposal = {
        proposal_id: newId('prop'),
        surface_text: args.surface_text,
        concept_id: conceptId,
        canonical_name: conceptId ? this.index.ontology.canonicalName(conceptId) : null,
        route_if_explicit: null,
        dose_if_explicit: null,
        status: 'planned',
        source_event_id: args.event_id,
        created_at: utcnow(),
        cancelled_at: null,
      };
      runtime.store.append(EventType.PRESCRIPTION_PROPOSED, { proposal }, { eventId: args.event_id });
      return this.recompute(runtime, null);
    });
  }

  async cancelPrescription(
    runtime: EncounterRuntime,
    args: { event_id: string; proposal_id: string },
  ): Promise<EncounterSnapshot> {
    return runtime.lock.run(async () => {
      if (runtime.store.hasEventId(args.event_id)) {
        throw new DuplicateEventError(`duplicate event_id ${args.event_id}`);
      }
      runtime.store.append(
        EventType.PRESCRIPTION_CANCELLED,
        { proposal_id: args.proposal_id },
        { eventId: args.event_id },
      );
      return this.recompute(runtime, null);
    });
  }

  // -- core recompute (spec §14) -------------------------------------------

  private async recompute(
    runtime: EncounterRuntime,
    latestTurn: TranscriptTurn | null,
    timings?: [number, number],
  ): Promise<EncounterSnapshot> {
    const state: GraphState = this.reducer.rebuild(runtime.store.events);
    const t2 = performance.now();

    const outcome: ReconcileOutcome = this.warningEngine.reconcile(runtime.warnings, state, latestTurn);

    const violations = this.validator.validate(state, outcome.warnings);
    if (violations.length) {
      console.error(`graph invariant violations in ${runtime.encounter_id}:`, violations);
      runtime.store.append(EventType.GRAPH_RECOMPUTED, { violations });
      const snapshot = this.snapshotWithError(runtime);
      this.broadcast(runtime, {
        type: 'processing.error',
        detail: 'Internal graph consistency check failed. No result is shown for this state.',
      });
      return snapshot;
    }

    runtime.warnings = outcome.warnings;
    for (const w of outcome.created) {
      runtime.store.append(EventType.WARNING_CREATED, { warning: w });
    }
    for (const w of outcome.updated) {
      runtime.store.append(EventType.WARNING_UPDATED, { warning: w });
    }
    for (const w of outcome.retracted) {
      runtime.store.append(EventType.WARNING_RETRACTED, { warning: w });
    }
    runtime.store.append(EventType.GRAPH_RECOMPUTED, {
      active_assertions: state.active().length,
      matches: outcome.matches,
      result_state: outcome.result_state,
    });

    const t3 = performance.now();
    if (timings && latestTurn) {
      const [t0, t1] = timings;
      const latency: TurnLatency = {
        turn_id: latestTurn.turn_id,
        received_to_extraction_ms: round2(t1 - t0),
        extraction_to_graph_ms: round2(t2 - t1),
        graph_to_result_ms: round2(t3 - t2),
        total_ms: round2(t3 - t0),
      };
      runtime.latencies.push(latency);
    }

    const snapshot = makeEncounterSnapshot({
      encounter_id: runtime.encounter_id,
      version: runtime.snapshot.version + 1,
      status: state.status,
      synthetic_demo: runtime.synthetic_demo,
      started_at: state.started_at,
      stopped_at: state.stopped_at,
      turns: state.turns,
      mentions: state.mentions,
      assertions: [...state.assertions.values()].sort((a, b) =>
        a.valid_from.localeCompare(b.valid_from),
      ),
      proposals: [...state.proposals.values()],
      matches: outcome.matches,
      warnings: runtime.warnings,
      result_state: outcome.result_state,
      lookup_reason: outcome.lookup_reason,
      missing_information: outcome.missing_information,
      excluded_notes: outcome.excluded_notes,
      conflict_notes: outcome.conflict_notes,
      messages: outcome.messages,
      latencies: runtime.latencies,
    });
    runtime.snapshot = snapshot;

    this.publishUpdate(runtime, outcome);
    return snapshot;
  }

  private snapshotWithError(runtime: EncounterRuntime): EncounterSnapshot {
    const snapshot: EncounterSnapshot = {
      ...runtime.snapshot,
      version: runtime.snapshot.version + 1,
      result_state: ResultState.PROCESSING_ERROR,
      lookup_reason:
        'A processing error occurred. The transcript is retained and no medical content is shown for this state.',
    };
    runtime.snapshot = snapshot;
    return snapshot;
  }

  // -- websocket publication -----------------------------------------------

  private publishUpdate(runtime: EncounterRuntime, outcome: ReconcileOutcome): void {
    const snapshot = runtime.snapshot;
    const graphEvent = {
      type: 'graph.updated',
      encounter_id: runtime.encounter_id,
      version: snapshot.version,
      status: snapshot.status,
      turns: snapshot.turns,
      active_assertions: activeAssertions(snapshot),
      inactive_assertions: snapshot.assertions.filter((a) => !a.is_active),
      proposals: snapshot.proposals,
    };
    const resultEvent = {
      type: 'result.updated',
      encounter_id: runtime.encounter_id,
      version: snapshot.version,
      result: this.resultPayload(runtime),
    };
    this.broadcast(runtime, graphEvent);
    for (const w of outcome.created) {
      this.broadcast(runtime, { type: 'warning.created', warning: this.warningPayload(w) });
    }
    for (const w of outcome.updated) {
      this.broadcast(runtime, { type: 'warning.updated', warning: this.warningPayload(w) });
    }
    for (const w of outcome.retracted) {
      this.broadcast(runtime, { type: 'warning.retracted', warning: this.warningPayload(w) });
    }
    this.broadcast(runtime, resultEvent);
  }

  /** Warning + the full verbatim evidence record it references. */
  warningPayload(warning: WarningRecord): Record<string, unknown> {
    return {
      ...warning,
      evidence_record: this.index.getRecord(warning.evidence_record_id),
    };
  }

  resultPayload(runtime: EncounterRuntime): Record<string, unknown> {
    const snapshot = runtime.snapshot;
    return {
      state: snapshot.result_state,
      lookup_reason: snapshot.lookup_reason,
      missing_information: snapshot.missing_information,
      excluded_notes: snapshot.excluded_notes,
      conflict_notes: snapshot.conflict_notes,
      messages: snapshot.messages,
      active_warnings: activeWarnings(snapshot).map((w) => this.warningPayload(w)),
      warning_history: snapshot.warnings
        .filter((w) => w.state === 'retracted')
        .map((w) => this.warningPayload(w)),
      latency_ms: snapshot.latencies.length ? snapshot.latencies[snapshot.latencies.length - 1] : null,
    };
  }

  snapshotPayload(runtime: EncounterRuntime): Record<string, unknown> {
    const snapshot = runtime.snapshot;
    return {
      type: 'encounter.snapshot',
      encounter_id: runtime.encounter_id,
      version: snapshot.version,
      status: snapshot.status,
      active_speaker: runtime.active_speaker,
      turns: snapshot.turns,
      active_assertions: activeAssertions(snapshot),
      inactive_assertions: snapshot.assertions.filter((a) => !a.is_active),
      proposals: snapshot.proposals,
      result: this.resultPayload(runtime),
    };
  }

  broadcast(runtime: EncounterRuntime, message: unknown): void {
    const data = JSON.stringify(message);
    const dead: JsonSubscriber[] = [];
    for (const ws of runtime.subscribers) {
      try {
        ws.send(data);
      } catch {
        dead.push(ws);
      }
    }
    for (const ws of dead) {
      runtime.subscribers.delete(ws);
    }
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
