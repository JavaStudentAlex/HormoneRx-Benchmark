/**
 * Deterministic rule-based extractor (demo mode and live-mode fallback).
 *
 * Performs ONLY the permitted extraction task: locating hormonal-product and
 * medication surface forms from the approved vocabulary, classifying temporal
 * status / negation / subject from cue words in the surrounding clause, and
 * flagging explicit corrections. It contains no medical knowledge beyond the
 * approved vocabulary lists and never produces interaction content.
 */
import { EvidenceIndex } from './evidenceIndex.ts';
import {
  Certainty,
  Correction,
  ExtractedMention,
  MentionCategory,
  MentionStatus,
  Speaker,
  SubjectRole,
  TranscriptTurn,
  TurnExtraction,
  makeExtractedMention,
} from './models.ts';

export const EXTRACTOR_VERSION = 'deterministic-rule-extractor/0.2.0';

const NEGATION_CUES = [
  'not taking', 'not on', 'is not', "isn't", 'not currently', 'denies', 'denied',
  'no use of', 'without', 'never taken', 'never used', 'no longer taking',
  "don't take", 'do not take', "doesn't take", 'does not take', 'not using',
  "don't use", 'do not use', 'stopped taking it before it started', 'has never',
];

const HISTORICAL_CUES = [
  'stopped', 'discontinued', 'no longer', 'previously', 'used to', 'in the past',
  'years ago', 'year ago', 'months ago', 'month ago', 'former', 'had been on',
  'was on', 'came off', 'quit',
];

const PLANNED_CUES = [
  'planning to start', 'plans to start', 'planning to begin', 'will start',
  'about to start', 'going to start', 'intends to start', 'intend to start',
  'due to start', 'next month', 'next week', 'considering starting',
  'thinking about starting', 'we will start', "i'm going to prescribe",
  'i am going to prescribe', "i'll prescribe", 'i will prescribe',
  'going to put you on', "let's start", "we'll start", 'start you on',
];

const OTHER_PERSON_CUES = [
  'my sister', 'my brother', 'my mother', 'my father', 'my mum', 'my mom',
  'my dad', 'my friend', 'my partner', 'my husband', 'my wife', 'my son',
  'my daughter', 'her partner', 'her husband', 'his wife', 'her wife',
  'his husband', 'her son', 'her daughter', 'her mother', 'her father',
  'her sister', 'his sister', 'her brother', 'his brother', 'family member',
  'someone else', 'a friend',
];

const DISCUSSION_CUES = [
  'explained what', 'explained how', 'told me about', 'told her about',
  'asked about', 'asked whether', 'asked if', 'talked about', 'discussed',
  'what is', 'heard about', 'read about',
];

const HORMONAL_UNCERTAIN_CUES = [
  'method is unclear', 'method unclear', 'unclear which', 'some form of',
  'might be using', 'may be using', 'possibly using', 'not sure which',
];

const MEDICATION_UNCERTAIN_CUES = [
  'cannot recall', "can't recall", 'cannot remember', "can't remember",
  'not sure what', 'something for', 'unnamed', 'name is unknown',
  'name unknown', 'forgotten the name',
];

const CORRECTION_CUES = [
  'sorry, i meant', 'sorry i meant', 'i meant', 'actually, i meant',
  'actually i meant', 'no, i meant', 'correction', 'i misspoke',
  "that's wrong, it's", "it's actually",
];

const BOUNDARY_TOKENS = [
  '. ', '; ', ', ', ' but ', ' and ', ' who ', ' although ', ' though ',
  ' however ', ' whereas ',
];

/** Highest start index i such that the full token fits within text[0, end). */
function rfindWithin(text: string, token: string, end: number): number {
  if (end < token.length) return -1;
  return text.lastIndexOf(token, end - token.length);
}

function clauseWindow(text: string, start: number, end: number): string {
  let clauseStart = 0;
  for (const token of BOUNDARY_TOKENS) {
    const idx = rfindWithin(text, token, Math.max(start, 0));
    if (idx !== -1) {
      const boundaryEnd = idx + token.length;
      if (boundaryEnd <= start && boundaryEnd > clauseStart) {
        clauseStart = boundaryEnd;
      }
    }
  }
  let clauseEnd = text.length;
  for (const token of BOUNDARY_TOKENS) {
    const idx = text.indexOf(token, end);
    if (idx !== -1 && idx < clauseEnd) {
      clauseEnd = idx;
    }
  }
  return text.slice(clauseStart, clauseEnd);
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function isBoundaryChar(ch: string): boolean {
  return !/\p{L}/u.test(ch);
}

interface SurfaceMatch {
  surface: string;
  index: number;
  category: MentionCategory;
}

/** Rule-based extractor over the approved vocabulary only. */
export class DeterministicExtractor {
  private hormonalTerms: string[];
  private medicationTerms: string[];

  constructor(private index: EvidenceIndex) {
    const onto = index.ontology;
    const hormonalTerms = new Set([
      ...Object.keys(index.alias_to_hormonal),
      ...Object.keys(onto.ambiguous_hormonal_aliases),
    ]);
    const medicationTerms = new Set([
      ...Object.keys(index.alias_to_medication),
      ...Object.keys(onto.ambiguous_medication_aliases),
      ...onto.non_interacting_medications,
    ]);
    // Longest surface form first so the most specific term wins.
    this.hormonalTerms = [...hormonalTerms].sort((a, b) => b.length - a.length);
    this.medicationTerms = [...medicationTerms].sort((a, b) => b.length - a.length);
  }

  async extract(turn: TranscriptTurn): Promise<TurnExtraction> {
    return this.extractSync(turn);
  }

  extractSync(turn: TranscriptTurn): TurnExtraction {
    const text = turn.text;
    const lower = text.toLowerCase();
    const missing: string[] = [];
    const mentions: ExtractedMention[] = [];

    for (const m of this.findMatches(lower)) {
      const window = clauseWindow(lower, m.index, m.index + m.surface.length);
      const status = classifyStatus(window);
      const subject = this.classifySubject(window, lower, turn.speaker, status);
      const certainty = status === MentionStatus.UNCERTAIN ? Certainty.UNCERTAIN : Certainty.EXPLICIT;
      mentions.push(
        makeExtractedMention({
          surface_text: text.slice(m.index, m.index + m.surface.length),
          category: m.category,
          status,
          subject,
          certainty,
          source_turn_id: turn.turn_id,
          span_start: m.index,
          span_end: m.index + m.surface.length,
        }),
      );
    }

    const hasHormonal = mentions.some((m) => m.category === MentionCategory.HORMONAL_PRODUCT);
    if (!hasHormonal && containsAny(lower, HORMONAL_UNCERTAIN_CUES)) {
      // "some form of hormonal contraception" style statements without a
      // matched vocabulary surface still record an uncertain hormonal mention.
      mentions.push(
        makeExtractedMention({
          surface_text: 'contraception (method unspecified)',
          category: MentionCategory.HORMONAL_PRODUCT,
          status: MentionStatus.UNCERTAIN,
          subject: defaultSubject(turn.speaker),
          certainty: Certainty.UNCERTAIN,
          source_turn_id: turn.turn_id,
        }),
      );
      missing.push('Specific hormonal contraceptive method is not stated.');
    }

    const hasMedication = mentions.some((m) => m.category === MentionCategory.OTHER_MEDICATION);
    if (!hasMedication && containsAny(lower, MEDICATION_UNCERTAIN_CUES)) {
      mentions.push(
        makeExtractedMention({
          surface_text: 'medication (name not stated)',
          category: MentionCategory.OTHER_MEDICATION,
          status: MentionStatus.UNCERTAIN,
          subject: defaultSubject(turn.speaker),
          certainty: Certainty.UNCERTAIN,
          source_turn_id: turn.turn_id,
        }),
      );
      missing.push('Specific medication name is not stated.');
    }

    const corrections = detectCorrections(lower, mentions);

    return {
      turn_id: turn.turn_id,
      speaker: turn.speaker as string as SubjectRole,
      mentions,
      corrections,
      missing_information: missing,
      should_recompute_graph: Boolean(mentions.length || corrections.length),
      extraction_method: 'deterministic',
      extraction_model: EXTRACTOR_VERSION,
    };
  }

  // -- matching ------------------------------------------------------------

  private findMatches(lower: string): SurfaceMatch[] {
    const found: SurfaceMatch[] = [];
    const used: Array<[number, number]> = [];

    const scan = (terms: string[], category: MentionCategory): void => {
      for (const term of terms) {
        let start = 0;
        for (;;) {
          const idx = lower.indexOf(term, start);
          if (idx === -1) break;
          const end = idx + term.length;
          const before = idx === 0 ? ' ' : lower[idx - 1];
          const after = end >= lower.length ? ' ' : lower[end];
          const overlaps = used.some(([s, e]) => idx < e && end > s);
          if (isBoundaryChar(before) && isBoundaryChar(after) && !overlaps) {
            found.push({ surface: term, index: idx, category });
            used.push([idx, end]);
          }
          start = idx + 1;
        }
      }
    };

    scan(this.hormonalTerms, MentionCategory.HORMONAL_PRODUCT);
    scan(this.medicationTerms, MentionCategory.OTHER_MEDICATION);
    return found.sort((a, b) => a.index - b.index);
  }

  // -- classification ------------------------------------------------------

  private classifySubject(
    window: string,
    fullLower: string,
    speaker: Speaker,
    status: MentionStatus,
  ): SubjectRole {
    if (containsAny(window, OTHER_PERSON_CUES)) {
      return SubjectRole.OTHER_PERSON;
    }
    if (speaker === Speaker.DOCTOR) {
      // A doctor's planned-prescription statement or an explicit statement
      // about the patient ("you take") is attributed to the patient. A pure
      // question or discussion without those anchors is not a patient assertion.
      if (/\bi (take|use|am on)\b|\bi'm on\b/.test(window)) {
        return SubjectRole.DOCTOR;
      }
      if (status === MentionStatus.PLANNED) {
        return SubjectRole.PATIENT;
      }
      if (/\byou\b|\byour\b|the patient|she takes|he takes|she uses|he uses|she is on|he is on/.test(window)) {
        if (fullLower.includes('?') && !/she takes|he takes|she uses|he uses|the patient/.test(window)) {
          return SubjectRole.UNKNOWN;
        }
        return SubjectRole.PATIENT;
      }
      if (containsAny(window, DISCUSSION_CUES) || fullLower.includes('?')) {
        return SubjectRole.UNKNOWN;
      }
      return SubjectRole.PATIENT;
    }
    if (speaker === Speaker.OTHER_PERSON) {
      return SubjectRole.OTHER_PERSON;
    }
    // Patient speech and unknown speakers: first-person and third-person
    // clinical-note phrasing both describe the patient by default.
    if (speaker === Speaker.UNKNOWN) {
      return /\bi\b|\bshe\b|\bhe\b|the patient|\bmy\b/.test(fullLower)
        ? SubjectRole.PATIENT
        : SubjectRole.UNKNOWN;
    }
    return SubjectRole.PATIENT;
  }
}

function classifyStatus(window: string): MentionStatus {
  // Precedence: negated > historical > planned > uncertain-discussion > current.
  if (containsAny(window, NEGATION_CUES)) return MentionStatus.NEGATED;
  if (containsAny(window, HISTORICAL_CUES)) return MentionStatus.HISTORICAL;
  if (containsAny(window, PLANNED_CUES)) return MentionStatus.PLANNED;
  if (containsAny(window, DISCUSSION_CUES)) return MentionStatus.UNCERTAIN;
  return MentionStatus.CURRENT;
}

function defaultSubject(speaker: Speaker): SubjectRole {
  if (speaker === Speaker.OTHER_PERSON) return SubjectRole.OTHER_PERSON;
  return SubjectRole.PATIENT;
}

function detectCorrections(lower: string, mentions: ExtractedMention[]): Correction[] {
  if (!containsAny(lower, CORRECTION_CUES)) return [];
  // The replacement is the current-status mention in the correcting turn —
  // a medication ("I meant lamotrigine") or a hormonal product
  // ("I meant the combined pill"). The reducer supersedes the latest prior
  // assertion of the same category.
  let replacement: string | null = null;
  for (const category of [MentionCategory.OTHER_MEDICATION, MentionCategory.HORMONAL_PRODUCT]) {
    for (const m of mentions) {
      if (m.category === category && m.status === MentionStatus.CURRENT) {
        replacement = m.surface_text;
        break;
      }
    }
    if (replacement) break;
  }
  return [
    {
      target_surface_text: null, // resolved by the reducer: latest prior assertion of same category
      replacement_surface_text: replacement,
      note: 'explicit correction cue in turn',
    },
  ];
}
