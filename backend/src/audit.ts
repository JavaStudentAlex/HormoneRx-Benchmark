/**
 * Synthetic session audit export (spec §29).
 *
 * The export answers: what was heard, what was extracted, what graph state was
 * created, which record matched, and why a warning changed — with schema and
 * model versions. Raw audio is never included.
 */
import { EncounterRuntime } from './encounterService.ts';
import { EventType, SCHEMA_VERSION } from './models.ts';

export function buildAuditExport(runtime: EncounterRuntime, extractorLabel: string): Record<string, unknown> {
  const snapshot = runtime.snapshot;
  return {
    audit_version: '0.3.0',
    schema_version: SCHEMA_VERSION,
    extraction_model: extractorLabel,
    encounter: {
      encounter_id: runtime.encounter_id,
      synthetic_demo: runtime.synthetic_demo,
      status: snapshot.status,
      started_at: snapshot.started_at,
      stopped_at: snapshot.stopped_at,
      created_at: runtime.created_at,
    },
    final_transcript_turns: snapshot.turns,
    extracted_mentions: snapshot.mentions,
    graph_assertions: snapshot.assertions,
    proposals: snapshot.proposals,
    evidence_matches: snapshot.matches,
    warning_lifecycle: snapshot.warnings,
    result: {
      state: snapshot.result_state,
      lookup_reason: snapshot.lookup_reason,
      missing_information: snapshot.missing_information,
      excluded_notes: snapshot.excluded_notes,
    },
    latency_measurements: snapshot.latencies,
    event_log: runtime.store.events.filter(
      (e) => e.event_type !== EventType.TRANSCRIPT_PARTIAL_RECEIVED,
    ),
    processing_errors: runtime.store.eventsOf(EventType.EXTRACTION_FAILED, EventType.TRANSCRIPTION_FAILED),
  };
}
