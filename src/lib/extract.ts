import type { ExtractionResult, ExtractedEntity, MedicationStatus } from './types';
import { hormonalIndex, medicationIndex } from './evidence';

// Deterministic, rule-based extractor used in DEMO mode and by the benchmark runner.
// It performs ONLY the permitted extraction task: identifying a hormonal product and
// another medication, normalizing surface forms via documented synonyms, and
// classifying temporality/negation. It never produces medical content.

// Small closed lexicon of common NON-interacting drug names, so the demo pipeline can
// recognize "a medication is named but is not in the evidence dataset" (true negative)
// versus "no medication named" (needs clarification). Documented in docs/EVALUATION.md.
const NON_INTERACTING_DRUGS = [
  'paracetamol',
  'acetaminophen',
  'ibuprofen',
  'sertraline',
  'amlodipine',
  'ramipril',
  'aspirin',
  'omeprazole',
  'metformin',
  'atorvastatin',
];

const NEGATION_CUES = [
  'not taking',
  'not on',
  'is not',
  "isn't",
  'not currently',
  'denies',
  'denied',
  'no use of',
  'without',
  'never taken',
  'never used',
  'no longer taking',
];

const HISTORICAL_CUES = [
  'stopped',
  'discontinued',
  'no longer',
  'previously',
  'used to',
  'in the past',
  'years ago',
  'year ago',
  'months ago',
  'month ago',
  'former',
  'had been on',
  'was on',
];

const PLANNED_CUES = [
  'planning to start',
  'plans to start',
  'planning to begin',
  'will start',
  'about to start',
  'going to start',
  'intends to start',
  'intend to start',
  'due to start',
  'next month',
  'next week',
];

const OTHER_PERSON_CUES = [
  'her partner',
  'her husband',
  'his wife',
  'her wife',
  'his husband',
  'her son',
  'her daughter',
  'her mother',
  'her father',
  'family member',
  'someone else',
  'a friend',
];

const HORMONAL_UNCERTAIN_CUES = [
  'method is unclear',
  'method unclear',
  'unclear which',
  'some form of',
  'might be using',
  'may be using',
  'possibly using',
  'not sure which',
  'uses contraception',
  'using contraception',
  'on contraception',
];

const MEDICATION_UNCERTAIN_CUES = [
  'cannot recall',
  "can't recall",
  'cannot remember',
  "can't remember",
  'not sure what',
  'something for',
  'unnamed',
  'name is unknown',
  'name unknown',
  'forgotten the name',
];

interface Boundary {
  start: number;
  end: number;
}

// Determine the clause window around a matched entity: from the last clause boundary
// before the entity to the next boundary after it. Negation/temporality cues are only
// considered if they fall within this window, so a cue binds to the nearest entity.
const BOUNDARY_TOKENS = ['. ', '; ', ', ', ' but ', ' and ', ' who ', ' although ', ' though ', ' however ', ' whereas '];

function clauseWindow(text: string, matchStart: number, matchEnd: number): string {
  let clauseStart = 0;
  for (const token of BOUNDARY_TOKENS) {
    let idx = text.lastIndexOf(token, matchStart - 1);
    if (idx !== -1) {
      const boundaryEnd = idx + token.length;
      if (boundaryEnd <= matchStart && boundaryEnd > clauseStart) clauseStart = boundaryEnd;
    }
  }
  let clauseEnd = text.length;
  for (const token of BOUNDARY_TOKENS) {
    const idx = text.indexOf(token, matchEnd);
    if (idx !== -1 && idx < clauseEnd) clauseEnd = idx;
  }
  return text.slice(clauseStart, clauseEnd);
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function classifyStatus(window: string): MedicationStatus {
  // Precedence: other person > negated > historical > planned > current.
  if (containsAny(window, OTHER_PERSON_CUES)) return 'other_person';
  if (containsAny(window, NEGATION_CUES)) return 'negated';
  if (containsAny(window, HISTORICAL_CUES)) return 'historical';
  if (containsAny(window, PLANNED_CUES)) return 'planned';
  return 'current';
}

interface SurfaceMatch {
  surface: string;
  normalized: string;
  index: number;
}

// Find the most specific (longest) synonym occurrence in the text.
function findSurfaceMatches(lowerText: string, index: { canonical: string; synonym: string }[]): SurfaceMatch[] {
  const matches: SurfaceMatch[] = [];
  const usedRanges: Boundary[] = [];
  for (const entry of index) {
    let from = 0;
    while (true) {
      const idx = lowerText.indexOf(entry.synonym, from);
      if (idx === -1) break;
      const end = idx + entry.synonym.length;
      // Word-ish boundary check to avoid matching inside longer words.
      const before = idx === 0 ? ' ' : lowerText[idx - 1];
      const after = end >= lowerText.length ? ' ' : lowerText[end];
      const isBoundary = /[^a-z]/.test(before) && /[^a-z]/.test(after);
      const overlaps = usedRanges.some((r) => idx < r.end && end > r.start);
      if (isBoundary && !overlaps) {
        matches.push({ surface: entry.synonym, normalized: entry.canonical, index: idx });
        usedRanges.push({ start: idx, end });
      }
      from = idx + 1;
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}

export function extractDeterministic(text: string): ExtractionResult {
  const lower = text.toLowerCase();
  const missingInformation: string[] = [];

  // ---- Hormonal product ----
  const hormonalMatches = findSurfaceMatches(lower, hormonalIndex);
  let hormonal: ExtractedEntity;
  if (hormonalMatches.length > 0) {
    const m = hormonalMatches[0];
    const window = clauseWindow(lower, m.index, m.index + m.surface.length);
    const status = classifyStatus(window);
    hormonal = {
      raw: text.substr(m.index, m.surface.length),
      normalized: m.normalized,
      status: status === 'other_person' ? 'other_person' : status,
      sourceSpan: text.substr(m.index, m.surface.length),
    };
  } else if (containsAny(lower, HORMONAL_UNCERTAIN_CUES)) {
    hormonal = { raw: 'contraception (method unspecified)', normalized: null, status: 'uncertain', sourceSpan: null };
    missingInformation.push('Specific hormonal contraceptive method is not stated.');
  } else {
    hormonal = { raw: null, normalized: null, status: null, sourceSpan: null };
  }

  // ---- Other medication ----
  const interactingMatches = findSurfaceMatches(lower, medicationIndex);
  // Non-interacting named drugs (recognized but not in the evidence dataset).
  const nonInteractingMatches: SurfaceMatch[] = [];
  for (const drug of NON_INTERACTING_DRUGS) {
    const idx = lower.indexOf(drug);
    if (idx !== -1) {
      const end = idx + drug.length;
      const before = idx === 0 ? ' ' : lower[idx - 1];
      const after = end >= lower.length ? ' ' : lower[end];
      if (/[^a-z]/.test(before) && /[^a-z]/.test(after)) {
        nonInteractingMatches.push({ surface: drug, normalized: drug, index: idx });
      }
    }
  }

  let medication: ExtractedEntity;
  let medicationIsInteracting = false;
  let medicationIsKnownDrug = false;

  // Evaluate interacting candidates with status; prefer a current one.
  const interactingWithStatus = interactingMatches.map((m) => ({
    m,
    status: classifyStatus(clauseWindow(lower, m.index, m.index + m.surface.length)),
  }));
  const currentInteracting = interactingWithStatus.find((c) => c.status === 'current');
  const anyInteracting = interactingWithStatus[0];

  if (currentInteracting) {
    const { m, status } = currentInteracting;
    medication = { raw: text.substr(m.index, m.surface.length), normalized: m.normalized, status, sourceSpan: text.substr(m.index, m.surface.length) };
    medicationIsInteracting = true;
    medicationIsKnownDrug = true;
  } else if (anyInteracting) {
    const { m, status } = anyInteracting;
    medication = { raw: text.substr(m.index, m.surface.length), normalized: m.normalized, status, sourceSpan: text.substr(m.index, m.surface.length) };
    medicationIsInteracting = true;
    medicationIsKnownDrug = true;
  } else if (nonInteractingMatches.length > 0) {
    const m = nonInteractingMatches[0];
    const status = classifyStatus(clauseWindow(lower, m.index, m.index + m.surface.length));
    medication = { raw: text.substr(m.index, m.surface.length), normalized: null, status, sourceSpan: text.substr(m.index, m.surface.length) };
    medicationIsKnownDrug = true;
  } else if (containsAny(lower, MEDICATION_UNCERTAIN_CUES)) {
    medication = { raw: 'medication (name not stated)', normalized: null, status: 'uncertain', sourceSpan: null };
    missingInformation.push('Specific medication name is not stated.');
  } else {
    medication = { raw: null, normalized: null, status: null, sourceSpan: null };
  }

  // ---- Decide whether deterministic lookup should run ----
  const shouldSearchEvidence =
    hormonal.normalized !== null &&
    medicationIsInteracting &&
    medication.status === 'current';

  const reason = buildReason(hormonal, medication, medicationIsInteracting, medicationIsKnownDrug, shouldSearchEvidence);

  return {
    hormonalProduct: hormonal,
    otherMedication: medication,
    missingInformation,
    shouldSearchEvidence,
    reason,
  };
}

function buildReason(
  hormonal: ExtractedEntity,
  medication: ExtractedEntity,
  isInteracting: boolean,
  isKnownDrug: boolean,
  shouldSearch: boolean,
): string {
  if (shouldSearch) {
    return 'A hormonal product and a current interacting medication were identified; deterministic evidence lookup will run.';
  }
  if (hormonal.normalized === null) {
    return 'The hormonal contraceptive method could not be identified, so evidence lookup is withheld.';
  }
  if (medication.status === 'negated') {
    return 'The medication was explicitly negated, so it is excluded from evidence lookup.';
  }
  if (medication.status === 'historical') {
    return 'The medication was described as past use, so it is excluded from evidence lookup.';
  }
  if (medication.status === 'other_person') {
    return 'The medication appears to belong to another person, so it is not attributed to the patient.';
  }
  if (medication.status === 'planned') {
    return 'The medication is planned but not yet current, so it is not treated as an active interaction.';
  }
  if (medication.status === 'uncertain' || medication.raw === null) {
    return 'A current interacting medication was not clearly identified, so evidence lookup is withheld.';
  }
  if (isKnownDrug && !isInteracting) {
    return 'A medication was identified but it is not part of the prototype evidence dataset; lookup will find no record.';
  }
  return 'Evidence lookup will not run for this input.';
}
