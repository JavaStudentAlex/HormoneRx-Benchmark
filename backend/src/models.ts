/**
 * Data model for the HormoneRx real-time encounter engine (TypeScript port of
 * the v0.2.x Python backend — same field names, same JSON wire format).
 *
 * The extraction model may only ever produce TurnExtraction-shaped data
 * (mentions, corrections, missing information). It never produces interactions,
 * consequences, mechanisms, severity, citations, or advice — those exist only
 * in the curated evidence dataset and are attached by deterministic code.
 */
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = '1.0';

/** ISO-8601 UTC timestamp string; all dates are serialized strings end to end. */
export type IsoDateTime = string;

export function utcnow(): IsoDateTime {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export const Speaker = {
  DOCTOR: 'doctor',
  PATIENT: 'patient',
  OTHER_PERSON: 'other_person',
  UNKNOWN: 'unknown',
} as const;
export type Speaker = (typeof Speaker)[keyof typeof Speaker];
export const SPEAKER_VALUES: readonly string[] = Object.values(Speaker);

export const SubjectRole = {
  PATIENT: 'patient',
  DOCTOR: 'doctor',
  OTHER_PERSON: 'other_person',
  UNKNOWN: 'unknown',
} as const;
export type SubjectRole = (typeof SubjectRole)[keyof typeof SubjectRole];

export const MentionCategory = {
  HORMONAL_PRODUCT: 'hormonal_product',
  OTHER_MEDICATION: 'other_medication',
} as const;
export type MentionCategory = (typeof MentionCategory)[keyof typeof MentionCategory];

export const MentionStatus = {
  CURRENT: 'current',
  HISTORICAL: 'historical',
  PLANNED: 'planned',
  NEGATED: 'negated',
  UNCERTAIN: 'uncertain',
} as const;
export type MentionStatus = (typeof MentionStatus)[keyof typeof MentionStatus];

export const Certainty = {
  EXPLICIT: 'explicit',
  INFERRED: 'inferred',
  UNCERTAIN: 'uncertain',
} as const;
export type Certainty = (typeof Certainty)[keyof typeof Certainty];

export const NormalizationStatus = {
  NORMALIZED: 'normalized',
  AMBIGUOUS: 'ambiguous',
  NON_INTERACTING: 'non_interacting',
  UNKNOWN: 'unknown',
} as const;
export type NormalizationStatus = (typeof NormalizationStatus)[keyof typeof NormalizationStatus];

export const ResultState = {
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  EVIDENCE_FOUND: 'EVIDENCE_FOUND',
  NO_VALIDATED_MATCH: 'NO_VALIDATED_MATCH',
  MORE_INFORMATION_REQUIRED: 'MORE_INFORMATION_REQUIRED',
  EXCLUDED_CONTEXT: 'EXCLUDED_CONTEXT',
  RETRACTED: 'RETRACTED',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
} as const;
export type ResultState = (typeof ResultState)[keyof typeof ResultState];

export const EventType = {
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_STOPPED: 'SESSION_STOPPED',
  TRANSCRIPT_PARTIAL_RECEIVED: 'TRANSCRIPT_PARTIAL_RECEIVED',
  TRANSCRIPT_FINAL_RECEIVED: 'TRANSCRIPT_FINAL_RECEIVED',
  MENTIONS_EXTRACTED: 'MENTIONS_EXTRACTED',
  ASSERTION_ADDED: 'ASSERTION_ADDED',
  ASSERTION_SUPERSEDED: 'ASSERTION_SUPERSEDED',
  ASSERTION_RETRACTED: 'ASSERTION_RETRACTED',
  PRESCRIPTION_PROPOSED: 'PRESCRIPTION_PROPOSED',
  PRESCRIPTION_CANCELLED: 'PRESCRIPTION_CANCELLED',
  SPEAKER_CHANGED: 'SPEAKER_CHANGED',
  GRAPH_RECOMPUTED: 'GRAPH_RECOMPUTED',
  EVIDENCE_MATCH_CREATED: 'EVIDENCE_MATCH_CREATED',
  EVIDENCE_MATCH_REMOVED: 'EVIDENCE_MATCH_REMOVED',
  WARNING_CREATED: 'WARNING_CREATED',
  WARNING_UPDATED: 'WARNING_UPDATED',
  WARNING_RETRACTED: 'WARNING_RETRACTED',
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  SESSION_RESET: 'SESSION_RESET',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export const Predicate = {
  CURRENTLY_USES: 'CURRENTLY_USES',
  CURRENTLY_TAKES: 'CURRENTLY_TAKES',
  HISTORICALLY_USED: 'HISTORICALLY_USED',
  PLANS_TO_TAKE: 'PLANS_TO_TAKE',
  NEGATED_USE_OF: 'NEGATED_USE_OF',
} as const;
export type Predicate = (typeof Predicate)[keyof typeof Predicate];

export const WarningContext = {
  ACTIVE_COMBINATION: 'active_combination',
  PROPOSED_COMBINATION: 'proposed_combination',
} as const;
export type WarningContext = (typeof WarningContext)[keyof typeof WarningContext];

export const VerificationStatus = {
  PHYSICIAN_VERIFIED: 'physician_verified',
  SIGN_OFF_PENDING: 'physician_sign_off_pending',
} as const;
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];

// ---------------------------------------------------------------------------
// Event envelope (append-only log entries), spec §10.3
// ---------------------------------------------------------------------------

export interface EncounterEvent {
  event_id: string;
  encounter_id: string;
  event_type: EventType;
  occurred_at: IsoDateTime;
  sequence: number;
  provider_item_id: string | null;
  speaker: Speaker | null;
  payload: Record<string, unknown>;
  schema_version: string;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptTurn {
  turn_id: string;
  provider_item_id: string | null;
  sequence: number;
  speaker: Speaker;
  text: string;
  is_final: boolean;
  started_at_ms: number | null;
  ended_at_ms: number | null;
  received_at: IsoDateTime;
  arrived_late: boolean;
}

export function makeTranscriptTurn(
  init: Pick<TranscriptTurn, 'turn_id' | 'sequence' | 'speaker' | 'text' | 'is_final'> &
    Partial<TranscriptTurn>,
): TranscriptTurn {
  return {
    provider_item_id: null,
    started_at_ms: null,
    ended_at_ms: null,
    received_at: utcnow(),
    arrived_late: false,
    ...init,
  };
}

// ---------------------------------------------------------------------------
// Extraction contract (the ONLY model-producible structure), spec §12
// ---------------------------------------------------------------------------

export interface ExtractedMention {
  mention_id: string;
  surface_text: string;
  normalized_candidate: string | null;
  category: MentionCategory;
  status: MentionStatus;
  subject: SubjectRole;
  certainty: Certainty;
  source_turn_id: string;
  span_start: number | null;
  span_end: number | null;
  route_if_explicit: string | null;
  dose_if_explicit: string | null;
}

export function makeExtractedMention(
  init: Pick<ExtractedMention, 'surface_text' | 'category' | 'status' | 'subject' | 'certainty'> &
    Partial<ExtractedMention>,
): ExtractedMention {
  return {
    mention_id: newId('m'),
    normalized_candidate: null,
    source_turn_id: '',
    span_start: null,
    span_end: null,
    route_if_explicit: null,
    dose_if_explicit: null,
    ...init,
  };
}

export interface Correction {
  target_surface_text: string | null;
  replacement_surface_text: string | null;
  note: string | null;
}

export interface TurnExtraction {
  turn_id: string;
  speaker: SubjectRole;
  mentions: ExtractedMention[];
  corrections: Correction[];
  missing_information: string[];
  should_recompute_graph: boolean;
  extraction_method: string;
  extraction_model: string;
}

export interface NormalizedMention {
  mention: ExtractedMention;
  concept_id: string | null;
  canonical_name: string | null;
  normalization_status: NormalizationStatus;
  normalization_method: string;
  missing_information: string | null;
  candidate_concept_ids: string[];
}

export function makeNormalizedMention(
  init: Pick<NormalizedMention, 'mention' | 'normalization_status'> & Partial<NormalizedMention>,
): NormalizedMention {
  return {
    concept_id: null,
    canonical_name: null,
    normalization_method: 'approved_synonym_index/0.2.0',
    missing_information: null,
    candidate_concept_ids: [],
    ...init,
  };
}

// ---------------------------------------------------------------------------
// Encounter graph
// ---------------------------------------------------------------------------

export interface GraphAssertion {
  assertion_id: string;
  subject: SubjectRole;
  predicate: Predicate;
  concept_id: string;
  canonical_name: string;
  category: MentionCategory;
  status: MentionStatus;
  source_turn_id: string;
  mention_id: string | null;
  certainty: Certainty;
  is_active: boolean;
  valid_from: IsoDateTime;
  valid_to: IsoDateTime | null;
  normalization_method: string;
  supersedes_assertion_id: string | null;
  superseded_by_assertion_id: string | null;
  origin: 'speech' | 'ui_proposal';
  proposal_id: string | null;
}

export interface PrescriptionProposal {
  proposal_id: string;
  surface_text: string;
  concept_id: string | null;
  canonical_name: string | null;
  route_if_explicit: string | null;
  dose_if_explicit: string | null;
  status: 'planned' | 'cancelled';
  source_event_id: string;
  created_at: IsoDateTime;
  cancelled_at: IsoDateTime | null;
}

export interface EvidenceMatch {
  record_id: string;
  hormonal_concept_id: string;
  medication_concept_id: string;
  hormonal_assertion_id: string;
  medication_assertion_id: string;
  context: WarningContext;
}

export interface WarningRecord {
  warning_id: string;
  state: 'active' | 'updated' | 'retracted';
  display_label: string;
  evidence_record_id: string;
  context: WarningContext;
  verification_status: VerificationStatus;
  hormonal_concept_id: string;
  medication_concept_id: string;
  trigger_assertion_ids: string[];
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  retracted_at: IsoDateTime | null;
  retraction_reason: string | null;
  retracted_by_turn_id: string | null;
}

export interface TurnLatency {
  turn_id: string;
  received_to_extraction_ms: number;
  extraction_to_graph_ms: number;
  graph_to_result_ms: number;
  total_ms: number;
}

export interface EncounterSnapshot {
  encounter_id: string;
  version: number;
  status: string; // created | listening | stopped | reset
  synthetic_demo: boolean;
  schema_version: string;
  started_at: IsoDateTime | null;
  stopped_at: IsoDateTime | null;
  turns: TranscriptTurn[];
  mentions: NormalizedMention[];
  assertions: GraphAssertion[];
  proposals: PrescriptionProposal[];
  matches: EvidenceMatch[];
  warnings: WarningRecord[];
  result_state: ResultState;
  lookup_reason: string;
  missing_information: string[];
  excluded_notes: string[];
  conflict_notes: string[];
  messages: string[];
  latencies: TurnLatency[];
}

export function makeEncounterSnapshot(
  init: Pick<EncounterSnapshot, 'encounter_id'> & Partial<EncounterSnapshot>,
): EncounterSnapshot {
  return {
    version: 0,
    status: 'created',
    synthetic_demo: true,
    schema_version: SCHEMA_VERSION,
    started_at: null,
    stopped_at: null,
    turns: [],
    mentions: [],
    assertions: [],
    proposals: [],
    matches: [],
    warnings: [],
    result_state: ResultState.LISTENING,
    lookup_reason: 'No finalized medication context has been analyzed yet.',
    missing_information: [],
    excluded_notes: [],
    conflict_notes: [],
    messages: [],
    latencies: [],
    ...init,
  };
}

export function activeAssertions(snapshot: EncounterSnapshot): GraphAssertion[] {
  return snapshot.assertions.filter((a) => a.is_active);
}

export function activeWarnings(snapshot: EncounterSnapshot): WarningRecord[] {
  return snapshot.warnings.filter((w) => w.state === 'active' || w.state === 'updated');
}
