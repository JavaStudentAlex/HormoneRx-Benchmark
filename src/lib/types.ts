// Shared types for the HormoneRx Benchmark pipeline.
// The language model (live mode) may ONLY produce values of type ExtractionResult.
// It may never generate interactions, consequences, mechanisms, evidence levels,
// citations, severity, or any treatment/dosing advice. All medical content shown to
// the user is loaded from evidence_records.json.

export type MedicationStatus =
  | 'current'
  | 'historical'
  | 'planned'
  | 'negated'
  | 'uncertain'
  | 'other_person';

export interface EvidenceRecord {
  id: string;
  hormonalProduct: string;
  hormonalSynonyms: string[];
  interactingMedication: string;
  medicationSynonyms: string[];
  interactionDirection: string;
  potentialConsequence: string;
  clinicianConsideration: string;
  evidenceLevel: string;
  population: string;
  sourceTitle: string;
  sourceOrganization: string;
  sourceUrl: string;
  sourceSection: string;
  jurisdiction: string;
  lastVerified: string;
  physicianVerified: boolean;
  limitations: string;
}

export interface EvidenceDataset {
  datasetVersion: string;
  generatedNote: string;
  records: EvidenceRecord[];
}

export interface ExtractedEntity {
  raw: string | null;
  normalized: string | null;
  status: MedicationStatus | null;
  sourceSpan: string | null;
}

// The ONLY structured output the model is permitted to produce.
export interface ExtractionResult {
  hormonalProduct: ExtractedEntity;
  otherMedication: ExtractedEntity;
  missingInformation: string[];
  shouldSearchEvidence: boolean;
  reason: string;
}

export type ResultState =
  | 'EVIDENCE_FOUND'
  | 'NO_VALIDATED_MATCH'
  | 'MORE_INFORMATION_REQUIRED'
  | 'EXCLUDED_CONTEXT'
  | 'ERROR';

export interface PipelineResult {
  state: ResultState;
  // Populated ONLY when state === 'EVIDENCE_FOUND'. Content comes verbatim from a record.
  matchedRecord: EvidenceRecord | null;
  // Human-readable, non-medical explanation of why this state was reached.
  lookupReason: string;
  // Non-medical UI messages (fixed strings, no generated medical content).
  messages: string[];
  missingInformation: string[];
  extraction: ExtractionResult;
}

export type PipelineMode = 'demo' | 'live';
