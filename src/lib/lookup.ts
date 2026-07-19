import type { EvidenceRecord, ExtractionResult, PipelineResult } from './types';
import { evidenceRecords } from './evidence';

// Fixed, non-medical UI strings for the abstention states. No medical content here.
export const NO_MATCH_PRIMARY = 'No matching record was found in the current prototype evidence dataset.';
export const NO_MATCH_SECONDARY = 'This does not establish that no interaction exists.';

function surfaceSet(record: EvidenceRecord, kind: 'hormonal' | 'medication'): string[] {
  if (kind === 'hormonal') return [record.hormonalProduct, ...record.hormonalSynonyms].map((s) => s.toLowerCase());
  return [record.interactingMedication, ...record.medicationSynonyms].map((s) => s.toLowerCase());
}

// Deterministic retrieval: a record matches when the extracted hormonal surface form is a
// documented synonym of the record's hormonal product AND the extracted medication surface
// form is a documented synonym of the record's interacting medication.
export function findMatchingRecord(extraction: ExtractionResult): EvidenceRecord | null {
  const hormonalSurface = extraction.hormonalProduct.raw?.toLowerCase() ?? null;
  const medicationSurface = extraction.otherMedication.raw?.toLowerCase() ?? null;
  if (!hormonalSurface || !medicationSurface) return null;
  for (const record of evidenceRecords) {
    const hormonalOk = surfaceSet(record, 'hormonal').includes(hormonalSurface);
    const medicationOk = surfaceSet(record, 'medication').includes(medicationSurface);
    if (hormonalOk && medicationOk) return record;
  }
  return null;
}

export function runLookup(extraction: ExtractionResult): PipelineResult {
  const hormonal = extraction.hormonalProduct;
  const medication = extraction.otherMedication;

  const base = {
    matchedRecord: null as EvidenceRecord | null,
    messages: [] as string[],
    missingInformation: extraction.missingInformation,
    extraction,
  };

  // 1. Hormonal method not identifiable -> need more information.
  if (hormonal.normalized === null) {
    return {
      ...base,
      state: 'MORE_INFORMATION_REQUIRED',
      lookupReason: 'The hormonal contraceptive method was not identifiable from the input.',
      missingInformation: dedupe([...extraction.missingInformation, 'Specific hormonal contraceptive method is required to look up evidence.']),
    };
  }

  // 2. Medication excluded by context.
  if (medication.status === 'negated') {
    return { ...base, state: 'EXCLUDED_CONTEXT', lookupReason: 'The interacting medication was explicitly negated and excluded from retrieval.' };
  }
  if (medication.status === 'historical') {
    return { ...base, state: 'EXCLUDED_CONTEXT', lookupReason: 'The interacting medication was described as past (historical) use and excluded from retrieval.' };
  }
  if (medication.status === 'other_person') {
    return {
      ...base,
      state: 'NO_VALIDATED_MATCH',
      lookupReason: 'The medication appears to belong to another person and is not attributed to the patient.',
      messages: [NO_MATCH_PRIMARY, NO_MATCH_SECONDARY],
    };
  }
  if (medication.status === 'planned') {
    return {
      ...base,
      state: 'MORE_INFORMATION_REQUIRED',
      lookupReason: 'The interacting medication is planned but not yet current.',
      missingInformation: dedupe([...extraction.missingInformation, 'Confirm whether the planned medication has been started before assessing an active interaction.']),
    };
  }
  if (medication.status === 'uncertain' || medication.raw === null) {
    return {
      ...base,
      state: 'MORE_INFORMATION_REQUIRED',
      lookupReason: 'A current interacting medication was not clearly identified.',
      missingInformation: dedupe([...extraction.missingInformation, 'A specific, current medication is required to look up evidence.']),
    };
  }

  // 3. Medication is current. If it is not in the dataset vocabulary, no validated match.
  if (medication.normalized === null) {
    return {
      ...base,
      state: 'NO_VALIDATED_MATCH',
      lookupReason: 'A current medication was identified but it is not present in the prototype evidence dataset.',
      messages: [NO_MATCH_PRIMARY, NO_MATCH_SECONDARY],
    };
  }

  // 4. Deterministic retrieval on normalized identifiers + documented synonyms.
  const record = findMatchingRecord(extraction);
  if (record) {
    return {
      ...base,
      state: 'EVIDENCE_FOUND',
      matchedRecord: record,
      lookupReason: `A record was matched on hormonal product and interacting medication (record ${record.id}).`,
    };
  }
  return {
    ...base,
    state: 'NO_VALIDATED_MATCH',
    lookupReason: 'No record matched the identified hormonal product and medication combination.',
    messages: [NO_MATCH_PRIMARY, NO_MATCH_SECONDARY],
  };
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
