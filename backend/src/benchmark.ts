/**
 * Reproducible benchmark runner (spec §25, §26).
 *
 * Layers:
 *   text      — Layer A: standalone snippets, one finalized turn each.
 *   streaming — Layer B: event sequences with an expected state after every event.
 *   audio     — Layer C: requires recorded synthetic audio + live transcription;
 *               reported as skipped (never fabricated) when prerequisites are absent.
 *
 * Gold labels are read-only inputs. Results are written to
 * backend/data/benchmark_results.json and a UI copy of the streaming summary to
 * src/data/streaming_benchmark_results.json. Real numbers only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeGeneratedArtifacts } from '../ingest/build_index.ts';
import { BACKEND_DIR, getSettings } from './config.ts';
import { DeterministicExtractor, EXTRACTOR_VERSION } from './deterministicExtractor.ts';
import { DuplicateEventError, EncounterService } from './encounterService.ts';
import { EvidenceIndex, pairKey } from './evidenceIndex.ts';
import { type DistressFlag, Speaker, activeWarnings, newId } from './models.ts';
import { SoundAgent } from './soundAgent.ts';
import {
  ElevenLabsAffectModel,
  OpenAiAudioAffectModel,
  type SerResponse,
  type SerSegmentInput,
  runSidecarSer,
  serSidecarAvailable,
} from './soundAgentModels.ts';
import { synthElevenLabsTts, synthOpenAiTts } from './tts.ts';
import { NO_MATCH_PRIMARY, NO_MATCH_SECONDARY } from './warningEngine.ts';

const REPO_DIR = path.resolve(BACKEND_DIR, '..');

const ALLOWED_MESSAGES = new Set([NO_MATCH_PRIMARY, NO_MATCH_SECONDARY]);

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0.0 : a / b;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function buildService(): EncounterService {
  const settings = getSettings();
  const index = new EvidenceIndex(settings.evidence_path, settings.synonym_path, {
    strict: true,
    allowPendingVerification: settings.evidence_allow_pending_verification,
  });
  return new EncounterService(settings, index, new DeterministicExtractor(index));
}

// ---------------------------------------------------------------------------
// Layer A — text
// ---------------------------------------------------------------------------

interface TextCase {
  id: string;
  category: string;
  input: string;
  expectedResultState: string;
  expectedEvidenceRecordId: string | null;
  expectedAbstention: boolean;
  expectedMedication?: string | null;
  expectedMedicationStatus?: string | null;
  [key: string]: unknown;
}

export async function runTextLayer(service: EncounterService): Promise<Record<string, unknown>> {
  const cases = (
    JSON.parse(readFileSync(path.join(BACKEND_DIR, 'data', 'benchmark_cases.json'), 'utf8')) as {
      cases: TextCase[];
    }
  ).cases;
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let retrievalCorrect = 0;
  let abstExpected = 0, abstCorrect = 0;
  let negTotal = 0, negCorrect = 0, histTotal = 0, histCorrect = 0;
  let expectedPositive = 0, citedCorrect = 0;
  let unsupported = 0;
  let statusTotal = 0, statusCorrect = 0;
  let passCount = 0;
  const results: Array<Record<string, unknown>> = [];

  for (const testCase of cases) {
    const runtime = service.createEncounter();
    const snapshot = await service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: testCase.input,
      speaker: Speaker.DOCTOR,
    });
    const actualState = snapshot.result_state;
    const active = activeWarnings(snapshot);
    const actualRecord =
      active.length === 1
        ? active[0].evidence_record_id
        : active.length === 0
          ? null
          : [...active.map((w) => w.evidence_record_id)].sort().join(',');
    const stateOk = actualState === testCase.expectedResultState;
    const recordOk = actualRecord === testCase.expectedEvidenceRecordId;
    const passed = stateOk && recordOk;
    if (passed) passCount++;

    const expPos = testCase.expectedResultState === 'EVIDENCE_FOUND';
    const actPos = actualState === 'EVIDENCE_FOUND';
    if (expPos) expectedPositive++;
    if (actPos && expPos && recordOk) tp++;
    else if (actPos && (!expPos || !recordOk)) fp++;
    if (expPos && (!actPos || !recordOk)) fn++;
    if (!actPos && !expPos) tn++;
    if (recordOk) retrievalCorrect++;
    if (testCase.expectedAbstention) {
      abstExpected++;
      if (!actPos) abstCorrect++;
    }
    if (testCase.category === 'explicit_negation') {
      negTotal++;
      if (stateOk) negCorrect++;
    }
    if (testCase.category === 'historical_use') {
      histTotal++;
      if (stateOk) histCorrect++;
    }
    if (actPos) {
      const record = service.index.getRecord(active[0].evidence_record_id);
      if (recordOk && String(record.sourceUrl).trim() && String(record.sourceSection).trim()) {
        citedCorrect++;
      }
    }
    for (const message of snapshot.messages) {
      if (!ALLOWED_MESSAGES.has(message)) unsupported++;
    }
    // Medication status accuracy for the interacting medication, when labeled.
    const expectedStatus = testCase.expectedMedicationStatus;
    if (expectedStatus && testCase.expectedMedication) {
      statusTotal++;
      const interacting = snapshot.assertions.filter(
        (a) =>
          a.category === 'other_medication' && a.concept_id in service.index.ontology.medication_concepts,
      );
      if (interacting.some((a) => a.status === expectedStatus)) statusCorrect++;
    }

    results.push({
      id: testCase.id,
      category: testCase.category,
      input: testCase.input,
      expectedResultState: testCase.expectedResultState,
      actualResultState: actualState,
      expectedEvidenceRecordId: testCase.expectedEvidenceRecordId,
      actualEvidenceRecordId: actualRecord,
      pass: passed,
      lookupReason: snapshot.lookup_reason,
    });
  }

  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  return {
    layer: 'A-text',
    caseCount: cases.length,
    metrics: {
      passRate: round4(safeDiv(passCount, cases.length)),
      triggerPrecision: round4(precision),
      triggerRecall: round4(recall),
      triggerF1: round4(safeDiv(2 * precision * recall, precision + recall)),
      retrievalAccuracy: round4(safeDiv(retrievalCorrect, cases.length)),
      correctAbstentionRate: round4(safeDiv(abstCorrect, abstExpected)),
      negationAccuracy: round4(safeDiv(negCorrect, negTotal)),
      historicalContextAccuracy: round4(safeDiv(histCorrect, histTotal)),
      citationCoverage: round4(safeDiv(citedCorrect, expectedPositive)),
      medicationStatusAccuracy: round4(safeDiv(statusCorrect, statusTotal)),
      falsePositiveCount: fp,
      unsupportedClaimCount: unsupported,
    },
    confusion: { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn },
    counts: { passCount, total: cases.length },
    cases: results,
  };
}

// ---------------------------------------------------------------------------
// Layer B — streaming
// ---------------------------------------------------------------------------

interface StreamingEvent {
  type: string;
  sequence?: number;
  text?: string;
  speaker?: string;
  event_id?: string;
  medication_surface_text?: string;
  cancelsEventOfSequence?: number;
  isDuplicateReplay?: boolean;
  expectedResultStates: string[];
  expectedEvidenceRecordIds: string[];
  expectedActiveWarningCount: number;
  expectRetractionWithReason?: boolean;
  expectedWarningContext?: string;
}

interface StreamingCase {
  id: string;
  category: string;
  events: StreamingEvent[];
}

export async function runStreamingLayer(service: EncounterService): Promise<Record<string, unknown>> {
  const data = JSON.parse(
    readFileSync(path.join(BACKEND_DIR, 'data', 'streaming_benchmark_cases.json'), 'utf8'),
  ) as { cases: StreamingCase[] };
  const cases = data.cases;
  let eventTotal = 0, eventCorrect = 0;
  let finalCorrect = 0;
  let retrievalEvents = 0, retrievalCorrect = 0;
  let retractionExpected = 0, retractionCorrect = 0;
  let prematureWarnings = 0;
  let duplicateWarnings = 0;
  let citationEvents = 0, citationCorrect = 0;
  let unsupported = 0;
  const retractionLatencyTurns: number[] = [];
  const caseResults: Array<Record<string, unknown>> = [];

  for (const testCase of cases) {
    const runtime = service.createEncounter();
    const proposalBySequence = new Map<number, string>();
    const eventResults: Array<Record<string, unknown>> = [];
    const warningCreatedAtEvent = new Map<string, number>();
    for (let eventIndex = 0; eventIndex < testCase.events.length; eventIndex++) {
      const event = testCase.events[eventIndex];
      try {
        if (event.type === 'transcript.final') {
          await service.processFinalTurn(runtime, {
            event_id: event.event_id || newId('evt'),
            text: event.text ?? '',
            speaker: event.speaker as Speaker,
            sequence: event.sequence,
          });
        } else if (event.type === 'prescription.proposed') {
          const snapshot = await service.proposePrescription(runtime, {
            event_id: newId('evt'),
            surface_text: event.medication_surface_text ?? '',
          });
          proposalBySequence.set(
            event.sequence as number,
            snapshot.proposals[snapshot.proposals.length - 1].proposal_id,
          );
        } else if (event.type === 'prescription.cancelled') {
          const ref = event.cancelsEventOfSequence as number;
          await service.cancelPrescription(runtime, {
            event_id: newId('evt'),
            proposal_id: proposalBySequence.get(ref) as string,
          });
        }
      } catch (err) {
        if (!(err instanceof DuplicateEventError) || !event.isDuplicateReplay) throw err;
      }

      const snapshot = runtime.snapshot;
      const active = activeWarnings(snapshot);
      const activeRecords = [...new Set(active.map((w) => w.evidence_record_id))].sort();
      const stateOk = event.expectedResultStates.includes(snapshot.result_state);
      const expectedSorted = [...event.expectedEvidenceRecordIds].sort();
      const recordsOk =
        activeRecords.length === expectedSorted.length &&
        activeRecords.every((r, i) => r === expectedSorted[i]);
      const countOk = active.length === event.expectedActiveWarningCount;
      let retractionOk = true;
      if (event.expectRetractionWithReason) {
        retractionExpected++;
        const retracted = snapshot.warnings.filter((w) => w.state === 'retracted');
        retractionOk = retracted.length > 0 && retracted.every((w) => Boolean(w.retraction_reason));
        if (retractionOk) retractionCorrect++;
        for (const w of retracted) {
          const createdAt = warningCreatedAtEvent.get(w.warning_id);
          if (createdAt !== undefined) {
            retractionLatencyTurns.push(eventIndex - createdAt);
            warningCreatedAtEvent.delete(w.warning_id);
          }
        }
      }
      let contextOk = true;
      if (event.expectedWarningContext) {
        contextOk = active.length > 0 && active.every((w) => w.context === event.expectedWarningContext);
      }
      for (const w of active) {
        if (!warningCreatedAtEvent.has(w.warning_id)) {
          warningCreatedAtEvent.set(w.warning_id, eventIndex);
        }
      }
      if (event.expectedEvidenceRecordIds.length) {
        retrievalEvents++;
        if (recordsOk) retrievalCorrect++;
        citationEvents += active.length;
        for (const w of active) {
          const record = service.index.getRecord(w.evidence_record_id);
          if (String(record.sourceUrl).trim() && String(record.sourceSection).trim()) {
            citationCorrect++;
          }
        }
      }
      if (event.expectedActiveWarningCount === 0 && active.length) {
        prematureWarnings += active.length;
      }
      if (active.length > event.expectedActiveWarningCount) {
        duplicateWarnings += active.length - event.expectedActiveWarningCount;
      }
      for (const message of snapshot.messages) {
        if (!ALLOWED_MESSAGES.has(message)) unsupported++;
      }

      const ok = stateOk && recordsOk && countOk && retractionOk && contextOk;
      eventTotal++;
      if (ok) eventCorrect++;
      eventResults.push({
        sequence: event.sequence ?? null,
        type: event.type,
        expectedResultStates: event.expectedResultStates,
        actualResultState: snapshot.result_state,
        expectedEvidenceRecordIds: event.expectedEvidenceRecordIds,
        actualEvidenceRecordIds: activeRecords,
        pass: ok,
      });
    }
    const finalOk = eventResults[eventResults.length - 1].pass as boolean;
    if (finalOk) finalCorrect++;
    caseResults.push({
      id: testCase.id,
      category: testCase.category,
      pass: eventResults.every((e) => e.pass),
      events: eventResults,
    });
  }

  const latencies: number[] = [];
  for (const runtime of service.encounters.values()) {
    for (const latency of runtime.latencies) {
      latencies.push(latency.total_ms);
    }
  }
  let latencySummary: Record<string, unknown> | null = null;
  if (latencies.length) {
    const sorted = [...latencies].sort((a, b) => a - b);
    latencySummary = {
      samples: sorted.length,
      medianMs: round4(median(sorted)),
      p90Ms: round4(sorted[Math.floor(0.9 * (sorted.length - 1))]),
      maxMs: round4(sorted[sorted.length - 1]),
      note: 'Backend pipeline only (final transcript received -> result computed), deterministic extractor, no network. Live-mode model latency is not included and must be measured separately.',
    };
  }

  return {
    layer: 'B-streaming',
    caseCount: cases.length,
    metrics: {
      casePassRate: round4(safeDiv(caseResults.filter((c) => c.pass).length, cases.length)),
      perEventStateAccuracy: round4(safeDiv(eventCorrect, eventTotal)),
      finalStateAccuracy: round4(safeDiv(finalCorrect, cases.length)),
      retrievalAccuracy: round4(safeDiv(retrievalCorrect, retrievalEvents)),
      warningRetractionAccuracy: round4(safeDiv(retractionCorrect, retractionExpected)),
      meanRetractionLatencyEvents: retractionLatencyTurns.length
        ? round4(safeDiv(retractionLatencyTurns.reduce((a, b) => a + b, 0), retractionLatencyTurns.length))
        : 0.0,
      prematureWarningCount: prematureWarnings,
      duplicateWarningCount: duplicateWarnings,
      citationCoverage: round4(safeDiv(citationCorrect, citationEvents)),
      unsupportedClaimCount: unsupported,
    },
    counts: { events: eventTotal, eventsCorrect: eventCorrect },
    processingLatency: latencySummary,
    cases: caseResults,
  };
}

// ---------------------------------------------------------------------------
// Layer C — audio (prerequisite-gated; never fabricated)
// ---------------------------------------------------------------------------

export function runAudioLayer(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(path.join(BACKEND_DIR, 'data', 'audio_benchmark_manifest.json'), 'utf8'),
  ) as { cases: Array<{ file: string }> };
  const settings = getSettings();
  const missingFiles = manifest.cases
    .map((c) => c.file)
    .filter((file) => !existsSync(path.join(BACKEND_DIR, 'data', file)));
  const reasons: string[] = [];
  if (missingFiles.length) {
    reasons.push(`${missingFiles.length} audio files not recorded yet`);
  }
  if (!settings.openai_api_key) {
    reasons.push('no OPENAI_API_KEY for live transcription');
  }
  if (reasons.length) {
    return {
      layer: 'C-audio',
      status: 'SKIPPED',
      reason: reasons.join('; '),
      caseCount: manifest.cases.length,
      note: 'Results are only reported for runs that actually happened. Record the manifest audio and set OPENAI_API_KEY to execute this layer.',
    };
  }
  return {
    layer: 'C-audio',
    status: 'NOT_IMPLEMENTED_IN_THIS_RUNNER_VERSION',
    note: 'Transcribe each file through the realtime pipeline and evaluate against the manifest gold labels.',
  };
}

// ---------------------------------------------------------------------------
// Index layer — offline-build scale + runtime lookup latency (this experiment)
// ---------------------------------------------------------------------------

/** Deterministic LCG so the microbenchmark's query mix is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function percentile(sortedNs: number[], q: number): number {
  if (!sortedNs.length) return 0;
  return sortedNs[Math.min(sortedNs.length - 1, Math.floor(q * (sortedNs.length - 1)))];
}

/**
 * Time `iterations` lookups against a Map, querying an even mix of present keys
 * (round-robin) and absent keys (misses). Returns nanosecond stats and throughput.
 */
function timeLookups(
  map: Map<string, string[]>,
  keys: string[],
  iterations: number,
  sampleForPercentiles = 50_000,
): Record<string, number> {
  const rand = lcg(0x9e3779b9);
  const missKeys = keys.map((_, i) => `absent_h${i} absent_m${i}`);
  // Warm up.
  for (let i = 0; i < Math.min(10_000, iterations); i++) map.get(keys[i % keys.length]);

  const start = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < iterations; i++) {
    const useHit = rand() < 0.7;
    const k = useHit ? keys[i % keys.length] : missKeys[i % missKeys.length];
    const v = map.get(k);
    sink += v ? 1 : 0;
  }
  const totalNs = Number(process.hrtime.bigint() - start);
  void sink;

  // Per-call samples for percentiles (higher variance; indicative only).
  const samples: number[] = [];
  const n = Math.min(sampleForPercentiles, iterations);
  for (let i = 0; i < n; i++) {
    const k = i % 2 === 0 ? keys[i % keys.length] : missKeys[i % missKeys.length];
    const t0 = process.hrtime.bigint();
    map.get(k);
    samples.push(Number(process.hrtime.bigint() - t0));
  }
  samples.sort((a, b) => a - b);

  return {
    iterations,
    avgNsPerLookup: round4(totalNs / iterations),
    throughputPerSec: Math.round(iterations / (totalNs / 1e9)),
    p50Ns: percentile(samples, 0.5),
    p90Ns: percentile(samples, 0.9),
    p99Ns: percentile(samples, 0.99),
    maxNs: percentile(samples, 1),
  };
}

/** Build a synthetic pair index of `size` entries for the flat-latency stress test. */
function syntheticIndex(size: number): { map: Map<string, string[]>; keys: string[] } {
  const map = new Map<string, string[]>();
  const keys: string[] = [];
  for (let i = 0; i < size; i++) {
    const k = pairKey(`h_${i}`, `m_${i}`);
    keys.push(k);
    map.set(k, [`SYN-${i}`]);
  }
  return { map, keys };
}

export function runIndexLayer(): Record<string, unknown> {
  const settings = getSettings();

  // Frozen control index (6-record curated tier).
  const baseIndex = new EvidenceIndex(settings.evidence_path, settings.synonym_path, {
    strict: true,
    allowPendingVerification: settings.evidence_allow_pending_verification,
  });

  // Offline build → expanded, license-tagged index.
  const { manifest, problems } = writeGeneratedArtifacts();
  const genDir = path.join(BACKEND_DIR, 'data', 'generated');
  const expandedIndex = new EvidenceIndex(
    path.join(genDir, 'evidence_records.json'),
    path.join(genDir, 'synonym_index.json'),
    { strict: true, allowPendingVerification: true },
  );

  // Superset non-regression: every runtime pair the control resolved must persist.
  const basePairs = [...baseIndex.pair_index.keys()];
  const expandedKeys = new Set(expandedIndex.pair_index.keys());
  const missingFromExpanded = basePairs.filter((k) => !expandedKeys.has(k));

  // Microbenchmark on the real expanded index.
  const realKeys = [...expandedIndex.pair_index.keys()];
  const realLatency = timeLookups(expandedIndex.pair_index, realKeys, 1_000_000);

  // Synthetic stress test — prove lookup stays flat (O(1)) as the store grows.
  const stress: Record<string, unknown> = {};
  for (const size of [1_000, 10_000, 100_000]) {
    const { map, keys } = syntheticIndex(size);
    stress[String(size)] = timeLookups(map, keys, 1_000_000);
  }

  return {
    layer: 'D-index',
    metrics: {
      baseRecordCount: Object.keys(baseIndex.records).length,
      expandedRecordCount: manifest.recordCount,
      generatedRecordCount: manifest.generatedRecordCount,
      basePairCount: baseIndex.pair_index.size,
      expandedPairCount: expandedIndex.pair_index.size,
      pairGrowthFactor: round4(safeDiv(expandedIndex.pair_index.size, baseIndex.pair_index.size)),
      commercialSafeRecords: manifest.commercialSafeRecords,
      supersetOk: missingFromExpanded.length === 0,
      realAvgNsPerLookup: realLatency.avgNsPerLookup,
      realThroughputPerSec: realLatency.throughputPerSec,
      stress100kAvgNsPerLookup: (stress['100000'] as Record<string, number>).avgNsPerLookup,
      buildProblemCount: problems.length,
    },
    build: manifest,
    realIndexLatency: realLatency,
    syntheticStressLatency: stress,
    supersetCheck: {
      controlPairCount: basePairs.length,
      missingFromExpanded,
      ok: missingFromExpanded.length === 0,
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// Sound-agent layer — summarize -> same deterministic warnings + advisory affect
// ---------------------------------------------------------------------------

interface AudioCase {
  id: string;
  referenceTranscript: Array<{ speaker: string; text: string }>;
  criticalEntities: string[];
  expectedFinalState: string | string[];
  expectedEvidenceRecordId: string | null;
  expectedWarningLifecycle: string[];
}

export async function runSoundAgentLayer(): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(
    readFileSync(path.join(BACKEND_DIR, 'data', 'audio_benchmark_manifest.json'), 'utf8'),
  ) as { cases: AudioCase[] };
  const agent = new SoundAgent(null); // Layer-1 text-only; no GPU model wired here

  let statePass = 0;
  let recordPass = 0;
  let lifecyclePass = 0;
  let casePass = 0;
  let affectSegments = 0;
  let distressFlagged = 0;
  let unsupported = 0;
  let advisoryInvariantHeld = true;
  const emittedEvents: Array<Record<string, unknown>> = [];
  const caseResults: Array<Record<string, unknown>> = [];
  const serInputs: SerSegmentInput[] = [];
  const speakerBySeg = new Map<string, Speaker>();

  for (const testCase of manifest.cases) {
    const service = buildService();
    const runtime = service.createEncounter();
    const turnsForRelational: Array<{ speaker: Speaker; text: string; distress: DistressFlag }> = [];
    const caseAffectIds = new Set<string>();
    let sawCreated = false;
    let sawRetracted = false;
    let sequence = 0;

    for (const turn of testCase.referenceTranscript) {
      const snapshot = await service.processFinalTurn(runtime, {
        event_id: newId('evt'),
        text: turn.text,
        speaker: turn.speaker as Speaker,
        sequence: sequence++,
      });
      const lastTurnId = snapshot.turns[snapshot.turns.length - 1]?.turn_id ?? newId('turn');
      // Sound agent emits its advisory affect segment for this finalized turn.
      const affect = await agent.affectFor(runtime.snapshot.encounter_id, {
        turn_id: lastTurnId,
        speaker: turn.speaker as Speaker,
        text: turn.text,
      });
      affectSegments++;
      caseAffectIds.add(affect.segment_id);
      serInputs.push({ segment_id: affect.segment_id, transcript: turn.text, audio_path: null });
      speakerBySeg.set(affect.segment_id, turn.speaker as Speaker);
      if (affect.distress_flag.level !== 'none') distressFlagged++;
      turnsForRelational.push({ speaker: turn.speaker as Speaker, text: turn.text, distress: affect.distress_flag });
      emittedEvents.push({
        case: testCase.id,
        event_type: 'AFFECT_SEGMENT_RECEIVED',
        segment_id: affect.segment_id,
        speaker: affect.speaker,
        distress_level: affect.distress_flag.level,
        distress_basis: affect.distress_flag.basis,
        advisory: affect.advisory,
      });

      if (activeWarnings(snapshot).length) sawCreated = true;
      if (snapshot.warnings.some((w) => w.state === 'retracted')) sawRetracted = true;
      for (const message of snapshot.messages) {
        if (!ALLOWED_MESSAGES.has(message)) unsupported++;
      }
      // Advisory invariant: no warning may reference an affect segment id, and
      // every non-retracted warning must trace to a real evidence record.
      for (const w of snapshot.warnings) {
        const fields = JSON.stringify(w);
        for (const id of caseAffectIds) if (fields.includes(id)) advisoryInvariantHeld = false;
        if (w.state !== 'retracted' && !service.index.getRecord(w.evidence_record_id)) {
          advisoryInvariantHeld = false;
        }
      }
    }

    const relational = agent.relationalSignal(
      runtime.snapshot.encounter_id,
      turnsForRelational.map((t) => ({ speaker: t.speaker, text: t.text, distress: t.distress })),
    );
    emittedEvents.push({
      case: testCase.id,
      event_type: 'RELATIONAL_SIGNAL_RECEIVED',
      clinician_talk_ratio: relational.clinician_talk_ratio,
      possible_dismissal: relational.possible_dismissal,
      confidence: relational.confidence,
    });

    const finalSnapshot = runtime.snapshot;
    const active = activeWarnings(finalSnapshot);
    const actualRecord =
      active.length === 1
        ? active[0].evidence_record_id
        : active.length === 0
          ? null
          : [...active.map((w) => w.evidence_record_id)].sort().join(',');
    const expectedStates = Array.isArray(testCase.expectedFinalState)
      ? testCase.expectedFinalState
      : [testCase.expectedFinalState];
    const stateOk = expectedStates.includes(finalSnapshot.result_state);
    const recordOk = actualRecord === testCase.expectedEvidenceRecordId;
    const expectCreated = testCase.expectedWarningLifecycle.includes('created');
    const expectRetracted = testCase.expectedWarningLifecycle.includes('retracted');
    const lifecycleOk = sawCreated === expectCreated && sawRetracted === expectRetracted;

    if (stateOk) statePass++;
    if (recordOk) recordPass++;
    if (lifecycleOk) lifecyclePass++;
    if (stateOk && recordOk && lifecycleOk) casePass++;

    caseResults.push({
      id: testCase.id,
      expectedFinalState: testCase.expectedFinalState,
      actualResultState: finalSnapshot.result_state,
      expectedEvidenceRecordId: testCase.expectedEvidenceRecordId,
      actualEvidenceRecordId: actualRecord,
      lifecycleOk,
      pass: stateOk && recordOk && lifecycleOk,
    });
  }

  // ---- Layer 2 affect model — CLOUD FIRST; local GPU only when explicitly asked ----
  const requested = (process.env.AFFECT_BACKEND || 'auto').toLowerCase();
  const settings = getSettings();
  const openaiKey = settings.openai_api_key;
  const elevenKey = process.env.ELEVENLABS_API_KEY || null;

  let affectProvider: 'openai' | 'elevenlabs' | 'sidecar' | 'text';
  if (requested === 'openai' || requested === 'elevenlabs' || requested === 'sidecar' || requested === 'text') {
    affectProvider = requested;
  } else {
    // auto: prefer cloud; never auto-prefer the local GPU.
    affectProvider = openaiKey ? 'openai' : elevenKey ? 'elevenlabs' : 'text';
  }

  const affectSampleResults: Array<Record<string, unknown>> = [];
  const affectErrors: string[] = [];
  const affectLatencies: number[] = [];
  let ttsCalls = 0;
  let ttsOk = 0;
  let affectCalls = 0;
  let affectOk = 0;
  let serDevice: string | null = null;
  let ttsProviderUsed: string | null = null;

  if (affectProvider === 'sidecar') {
    // Local GPU path — deprioritized; runs only when AFFECT_BACKEND=sidecar.
    const ser: SerResponse = serSidecarAvailable()
      ? runSidecarSer(serInputs)
      : { ok: false, error: 'sidecar unavailable' };
    serDevice = ser.device ?? null;
    if (ser.ok && ser.results) {
      affectCalls = ser.results.length;
      affectOk = ser.results.length;
      for (const r of ser.results) affectLatencies.push(r.latency_ms);
      for (const r of ser.results.slice(0, 6)) {
        affectSampleResults.push({ segment_id: r.segment_id, provider: 'sidecar', label: r.label, latency_ms: r.latency_ms });
      }
    } else {
      affectErrors.push(String(ser.error));
    }
  } else if (affectProvider === 'openai' || affectProvider === 'elevenlabs') {
    // Cloud path: TTS synth -> affect model, per segment (uses credits).
    const ttsProvider: 'openai' | 'elevenlabs' | null = openaiKey ? 'openai' : elevenKey ? 'elevenlabs' : null;
    ttsProviderUsed = ttsProvider;
    if (!ttsProvider) {
      affectErrors.push('no OPENAI/ELEVENLABS key in run env for TTS audio synthesis');
    } else if ((affectProvider === 'openai' && !openaiKey) || (affectProvider === 'elevenlabs' && !elevenKey)) {
      affectErrors.push(`AFFECT_BACKEND=${affectProvider} but its key is not present in the run env`);
    } else {
      const audioDir = path.join(BACKEND_DIR, 'data', 'tts_tmp');
      mkdirSync(audioDir, { recursive: true });
      const affectModel =
        affectProvider === 'openai'
          ? new OpenAiAudioAffectModel({ apiKey: openaiKey as string, baseUrl: settings.openai_base_url })
          : new ElevenLabsAffectModel({ apiKey: elevenKey as string });
      for (const seg of serInputs) {
        const speaker = speakerBySeg.get(seg.segment_id) ?? Speaker.PATIENT;
        const outPath = path.join(audioDir, `${seg.segment_id}.wav`);
        const viaOpenAi = () =>
          synthOpenAiTts({
            apiKey: openaiKey as string,
            baseUrl: settings.openai_base_url,
            voice: speaker === Speaker.DOCTOR ? 'onyx' : 'nova',
            text: seg.transcript,
            outPath,
          });
        const viaEleven = () =>
          synthElevenLabsTts({
            apiKey: elevenKey as string,
            voiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
            text: seg.transcript,
            outPath,
          });
        let tts = ttsProvider === 'openai' ? await viaOpenAi() : await viaEleven();
        // Fall back to the other provider if the preferred TTS is gated/unavailable.
        if (!tts.ok && ttsProvider === 'openai' && elevenKey) tts = await viaEleven();
        else if (!tts.ok && ttsProvider === 'elevenlabs' && openaiKey) tts = await viaOpenAi();
        ttsCalls++;
        if (!tts.ok) {
          affectErrors.push(`tts ${seg.segment_id}: ${tts.error}`);
          continue;
        }
        ttsOk++;
        if (tts.provider !== `${ttsProvider}-tts`) ttsProviderUsed = `${ttsProvider}->${tts.provider}`;
        const t0 = Date.now();
        try {
          const out = await affectModel.infer({ transcript: seg.transcript, audioPath: outPath });
          affectCalls++;
          affectOk++;
          affectLatencies.push(Date.now() - t0);
          if (affectSampleResults.length < 6) {
            affectSampleResults.push({
              segment_id: seg.segment_id,
              provider: affectProvider,
              emotion: out.categorical_emotion?.label ?? null,
              events: out.events ?? [],
            });
          }
        } catch (e) {
          affectCalls++;
          affectErrors.push(`affect ${seg.segment_id}: ${String(e).slice(0, 160)}`);
        }
      }
    }
  }
  // affectProvider === 'text' -> Layer-1 text affect only (already computed above).

  const affectMeanLatencyMs = affectLatencies.length
    ? round4(affectLatencies.reduce((a, b) => a + b, 0) / affectLatencies.length)
    : 0;
  // Cloud/GPU affect output is advisory too: it enriches affect events, never a warning.

  const n = manifest.cases.length;
  return {
    layer: 'E-soundagent',
    caseCount: n,
    metrics: {
      casePassRate: round4(safeDiv(casePass, n)),
      finalStateAccuracy: round4(safeDiv(statePass, n)),
      recordAccuracy: round4(safeDiv(recordPass, n)),
      warningLifecycleAccuracy: round4(safeDiv(lifecyclePass, n)),
      affectSegmentsProduced: affectSegments,
      distressFlaggedSegments: distressFlagged,
      affectAdvisoryInvariantHeld: advisoryInvariantHeld,
      unsupportedClaimCount: unsupported,
      affectBackendRequested: requested,
      affectProvider,
      openaiKeyPresent: Boolean(openaiKey),
      elevenlabsKeyPresent: Boolean(elevenKey),
      ttsProviderUsed,
      ttsCalls,
      ttsOk,
      affectCalls,
      affectOk,
      affectMeanLatencyMs,
      affectErrorCount: affectErrors.length,
      serDevice,
    },
    note:
      'Cloud-first affect. auto = OpenAI gpt-4o-audio (primary) -> ElevenLabs Scribe -> Layer-1 text; local GPU sidecar runs ONLY with AFFECT_BACKEND=sidecar. Cloud path: TTS-synthesized speech (OpenAI/ElevenLabs) -> affect model. Affect stays advisory; the summarize->deterministic-warning path (state/record/lifecycle vs gold) is unchanged and above. Keys read from env server-side only.',
    affectSampleResults,
    affectErrorsSample: affectErrors.slice(0, 8),
    emittedEventsSample: emittedEvents,
    cases: caseResults,
  };
}

// ---------------------------------------------------------------------------

export async function main(layers: string[]): Promise<void> {
  const service = buildService();
  const output: Record<string, any> = {
    metadata: {
      benchmarkVersion: '0.3.0',
      evidenceVersion: service.index.dataset_version,
      engine: 'hormonerx-backend-ts/0.3.0',
      extractionModel: EXTRACTOR_VERSION,
      mode: 'demo-deterministic',
      evalTimestamp: new Date().toISOString(),
      deterministic: true,
      runtimeEligibleRecords: service.index.runtimeEligibleIds(),
      pendingPhysicianSignOff: Object.entries(service.index.reports)
        .filter(([, rep]) => rep.eligible_via_pending_override)
        .map(([rid]) => rid),
    },
    layers: {},
  };
  if (layers.includes('text')) {
    output.layers.text = await runTextLayer(service);
  }
  if (layers.includes('streaming')) {
    output.layers.streaming = await runStreamingLayer(service);
  }
  if (layers.includes('audio')) {
    output.layers.audio = runAudioLayer();
  }
  if (layers.includes('index')) {
    output.layers.index = runIndexLayer();
  }
  if (layers.includes('soundagent')) {
    output.layers.soundagent = await runSoundAgentLayer();
  }

  const resultsPath = path.join(BACKEND_DIR, 'data', 'benchmark_results.json');
  writeFileSync(resultsPath, JSON.stringify(output, null, 2) + '\n');

  const uiCopy = path.join(REPO_DIR, 'src', 'data', 'streaming_benchmark_results.json');
  writeFileSync(uiCopy, JSON.stringify(output, null, 2) + '\n');

  for (const [name, layer] of Object.entries(output.layers) as Array<[string, any]>) {
    if (layer.status === 'SKIPPED') {
      console.log(`[${name}] SKIPPED: ${layer.reason}`);
      continue;
    }
    const casePrefix = layer.caseCount !== undefined ? `cases=${layer.caseCount} ` : '';
    console.log(`[${name}] ${casePrefix}metrics=${JSON.stringify(layer.metrics)}`);
    if (layer.processingLatency) {
      console.log(`[${name}] processingLatency=${JSON.stringify(layer.processingLatency)}`);
    }
    const failing = (layer.cases ?? []).filter((c: any) => !(c.pass ?? true)).map((c: any) => c.id);
    if (failing.length) {
      console.log(`[${name}] FAILING: ${JSON.stringify(failing)}`);
    }
  }
  console.log(`Results written to ${resultsPath} and ${uiCopy}`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const layerArgs: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--layer' && process.argv[i + 1]) {
      layerArgs.push(process.argv[++i]);
    }
  }
  let selected = layerArgs.length ? layerArgs : ['all'];
  if (selected.includes('all')) {
    selected = ['text', 'streaming', 'audio', 'index', 'soundagent'];
  }
  main(selected).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
