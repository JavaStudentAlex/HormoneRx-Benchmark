import type { EvidenceDataset, EvidenceRecord } from './types';
import raw from '../data/evidence_records.json';

const dataset = raw as EvidenceDataset;

export const evidenceDataset: EvidenceDataset = dataset;
export const evidenceRecords: EvidenceRecord[] = dataset.records;
export const evidenceVersion: string = dataset.datasetVersion;

export interface SynonymEntry {
  canonical: string;
  synonym: string; // lowercased
}

function buildIndex(getCanonical: (r: EvidenceRecord) => string, getSynonyms: (r: EvidenceRecord) => string[]) {
  const entries: SynonymEntry[] = [];
  const seen = new Set<string>();
  for (const record of evidenceRecords) {
    const canonical = getCanonical(record);
    const terms = [canonical, ...getSynonyms(record)];
    for (const term of terms) {
      const key = `${canonical}::${term.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ canonical, synonym: term.toLowerCase() });
    }
  }
  // Longer synonyms first so we match the most specific surface form.
  entries.sort((a, b) => b.synonym.length - a.synonym.length);
  return entries;
}

export const hormonalIndex = buildIndex(
  (r) => r.hormonalProduct,
  (r) => r.hormonalSynonyms,
);

export const medicationIndex = buildIndex(
  (r) => r.interactingMedication,
  (r) => r.medicationSynonyms,
);

// A flat set of every medication surface form that appears in the dataset,
// used to decide whether an extracted medication is "known" to the dataset.
export const knownMedicationTerms: SynonymEntry[] = medicationIndex;
