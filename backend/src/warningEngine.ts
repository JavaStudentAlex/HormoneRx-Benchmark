/**
 * Warning lifecycle reconciliation and result-state derivation (spec §17, §18).
 *
 * A warning is a derived graph object. It is created only from a deterministic
 * evidence match over eligible patient assertions, is updated when its
 * provenance improves, and is visibly retracted — never silently dropped —
 * when the context that created it stops holding.
 */
import { EvidenceIndex } from './evidenceIndex.ts';
import { GraphState, findMatches } from './graphReducer.ts';
import {
  EvidenceMatch,
  MentionCategory,
  MentionStatus,
  NormalizationStatus,
  Predicate,
  ResultState,
  SubjectRole,
  TranscriptTurn,
  WarningContext,
  WarningRecord,
  newId,
  utcnow,
} from './models.ts';

export const DISPLAY_LABEL_ACTIVE = 'Potentially relevant evidence found';
export const DISPLAY_LABEL_PROPOSED =
  'Potentially relevant evidence for the proposed medication combination';

export const NO_MATCH_PRIMARY = 'No matching record was found in the current prototype evidence dataset.';
export const NO_MATCH_SECONDARY = 'This does not establish that no interaction exists.';

export class ReconcileOutcome {
  warnings: WarningRecord[] = [];
  created: WarningRecord[] = [];
  updated: WarningRecord[] = [];
  retracted: WarningRecord[] = [];
  matches: EvidenceMatch[] = [];
  result_state: ResultState = ResultState.LISTENING;
  lookup_reason = '';
  missing_information: string[] = [];
  excluded_notes: string[] = [];
  conflict_notes: string[] = [];
  messages: string[] = [];
}

export class WarningEngine {
  constructor(private index: EvidenceIndex) {}

  // -- lifecycle -----------------------------------------------------------

  reconcile(
    previousWarnings: WarningRecord[],
    state: GraphState,
    latestTurn: TranscriptTurn | null,
  ): ReconcileOutcome {
    const outcome = new ReconcileOutcome();
    const matches = findMatches(state, this.index);
    outcome.matches = matches;

    const keyOfMatch = (m: EvidenceMatch): string =>
      `${m.record_id}|${m.hormonal_concept_id}|${m.medication_concept_id}`;
    const keyOfWarning = (w: WarningRecord): string =>
      `${w.evidence_record_id}|${w.hormonal_concept_id}|${w.medication_concept_id}`;

    const matchesByKey = new Map<string, EvidenceMatch>();
    for (const m of matches) {
      // An active combination outranks a proposed one for the same pair.
      const existing = matchesByKey.get(keyOfMatch(m));
      if (!existing || existing.context === 'proposed_combination') {
        matchesByKey.set(keyOfMatch(m), m);
      }
    }

    const carried: WarningRecord[] = [];
    const previousActive = previousWarnings.filter((w) => w.state === 'active' || w.state === 'updated');
    const previousRetracted = previousWarnings.filter((w) => w.state === 'retracted');

    for (const warning of previousActive) {
      const match = matchesByKey.get(keyOfWarning(warning));
      matchesByKey.delete(keyOfWarning(warning));
      if (!match) {
        const reason = this.retractionReason(warning, state, latestTurn);
        const retracted: WarningRecord = {
          ...warning,
          state: 'retracted',
          retracted_at: utcnow(),
          updated_at: utcnow(),
          retraction_reason: reason,
          retracted_by_turn_id: latestTurn ? latestTurn.turn_id : null,
        };
        outcome.retracted.push(retracted);
        carried.push(retracted);
        continue;
      }
      const newTriggers = [match.hormonal_assertion_id, match.medication_assertion_id];
      const triggersChanged =
        newTriggers.length !== warning.trigger_assertion_ids.length ||
        newTriggers.some((t, i) => t !== warning.trigger_assertion_ids[i]);
      if (triggersChanged || match.context !== warning.context) {
        const updated: WarningRecord = {
          ...warning,
          state: 'updated',
          trigger_assertion_ids: newTriggers,
          context: match.context,
          display_label:
            match.context === 'proposed_combination' ? DISPLAY_LABEL_PROPOSED : DISPLAY_LABEL_ACTIVE,
          updated_at: utcnow(),
        };
        outcome.updated.push(updated);
        carried.push(updated);
      } else {
        carried.push(warning);
      }
    }

    for (const match of matchesByKey.values()) {
      const warning: WarningRecord = {
        warning_id: newId('warn'),
        state: 'active',
        display_label:
          match.context === 'proposed_combination' ? DISPLAY_LABEL_PROPOSED : DISPLAY_LABEL_ACTIVE,
        evidence_record_id: match.record_id,
        context: match.context,
        verification_status: this.index.verificationStatus(match.record_id),
        hormonal_concept_id: match.hormonal_concept_id,
        medication_concept_id: match.medication_concept_id,
        trigger_assertion_ids: [match.hormonal_assertion_id, match.medication_assertion_id],
        created_at: utcnow(),
        updated_at: utcnow(),
        retracted_at: null,
        retraction_reason: null,
        retracted_by_turn_id: null,
      };
      outcome.created.push(warning);
      carried.push(warning);
    }

    outcome.warnings = [...carried, ...previousRetracted];
    this.deriveResult(outcome, state);
    return outcome;
  }

  // -- retraction explanations ---------------------------------------------

  private retractionReason(
    warning: WarningRecord,
    state: GraphState,
    latestTurn: TranscriptTurn | null,
  ): string {
    const medName = this.index.ontology.canonicalName(warning.medication_concept_id);
    const horName = this.index.ontology.canonicalName(warning.hormonal_concept_id);
    for (const proposal of state.proposals.values()) {
      if (proposal.concept_id === warning.medication_concept_id && proposal.status === 'cancelled') {
        return `The proposed prescription of ${medName} was cancelled.`;
      }
    }
    for (const [conceptId, name] of [
      [warning.medication_concept_id, medName],
      [warning.hormonal_concept_id, horName],
    ] as Array<[string, string]>) {
      const assertions = [...state.assertions.values()].filter(
        (a) => a.concept_id === conceptId && a.subject === SubjectRole.PATIENT,
      );
      const active = assertions.filter((a) => a.is_active);
      if (active.some((a) => a.predicate === Predicate.HISTORICALLY_USED)) {
        return `Current use of ${name} was corrected to past (historical) use.`;
      }
      if (active.some((a) => a.predicate === Predicate.NEGATED_USE_OF)) {
        return `Use of ${name} was negated by a later statement.`;
      }
      if (assertions.length && !active.length) {
        return `The assertion about ${name} was superseded or cancelled.`;
      }
    }
    if (latestTurn !== null) {
      return 'The medication context changed after a later finalized turn.';
    }
    return 'The triggering context is no longer present in the encounter graph.';
  }

  // -- result-state derivation (spec §17) ----------------------------------

  private deriveResult(outcome: ReconcileOutcome, state: GraphState): void {
    const activeWarnings = outcome.warnings.filter((w) => w.state === 'active' || w.state === 'updated');

    const patientActive = state.active().filter((a) => a.subject === SubjectRole.PATIENT);
    const hormonalCurrent = patientActive.filter(
      (a) =>
        a.category === MentionCategory.HORMONAL_PRODUCT &&
        (a.predicate === Predicate.CURRENTLY_USES || a.predicate === Predicate.PLANS_TO_TAKE),
    );
    const medicationCurrentOrPlanned = patientActive.filter(
      (a) =>
        a.category === MentionCategory.OTHER_MEDICATION &&
        (a.predicate === Predicate.CURRENTLY_TAKES || a.predicate === Predicate.PLANS_TO_TAKE),
    );

    const missing: string[] = [];
    const excluded: string[] = [];
    outcome.conflict_notes = [...state.conflict_notes];

    // Mutually exclusive product groups (e.g. the three oral-pill concepts):
    // if two are simultaneously active for the patient, warnings still stand on
    // both (cautious), but the conflict is surfaced as a clarification question.
    for (const [groupName, members] of Object.entries(this.index.ontology.mutually_exclusive_groups)) {
      const activeMembers = [
        ...new Set(
          hormonalCurrent.filter((a) => members.includes(a.concept_id)).map((a) => a.canonical_name),
        ),
      ].sort();
      if (activeMembers.length > 1) {
        missing.push(
          `Multiple ${groupName.replace(/_/g, ' ')} products are recorded for the patient ` +
            `(${activeMembers.join(' and ')}) — confirm which one is in use.`,
        );
      }
    }

    // Ambiguous / unknown / uncertain mentions drive clarification requests.
    for (const nm of state.mentions) {
      const mention = nm.mention;
      if (mention.status === MentionStatus.NEGATED) continue;
      if (
        nm.normalization_status === NormalizationStatus.AMBIGUOUS ||
        nm.normalization_status === NormalizationStatus.UNKNOWN
      ) {
        const slotFilled =
          mention.category === MentionCategory.HORMONAL_PRODUCT
            ? hormonalCurrent
            : medicationCurrentOrPlanned;
        if (nm.missing_information && !slotFilled.length) {
          missing.push(nm.missing_information);
        }
      } else if (
        mention.status === MentionStatus.UNCERTAIN &&
        nm.normalization_status === NormalizationStatus.NORMALIZED
      ) {
        excluded.push(`${nm.canonical_name} was discussed but not stated as a patient medication.`);
      }
    }
    for (const note of state.contradiction_notes) {
      missing.push(note);
    }

    // Uncertain-surface mentions raised by the extractor itself.
    for (const nm of state.mentions) {
      const m = nm.mention;
      if (m.certainty === 'uncertain' && m.surface_text.endsWith('(name not stated)')) {
        if (!medicationCurrentOrPlanned.length) {
          missing.push('Specific medication name is not stated.');
        }
      }
      if (m.certainty === 'uncertain' && m.surface_text.startsWith('contraception (')) {
        if (!hormonalCurrent.length) {
          missing.push('Specific hormonal contraceptive method is not stated.');
        }
      }
    }

    // Unknown-subject current mentions block attribution.
    for (const nm of state.mentions) {
      if (
        nm.mention.subject === SubjectRole.UNKNOWN &&
        nm.mention.status === MentionStatus.CURRENT &&
        nm.normalization_status === NormalizationStatus.NORMALIZED
      ) {
        missing.push(`It is unclear whether ${nm.canonical_name} refers to the patient.`);
      }
    }

    // Excluded-context assertions (negated / historical / other person / cancelled).
    for (const a of state.assertions.values()) {
      const name = a.canonical_name;
      if (a.subject === SubjectRole.OTHER_PERSON && a.is_active) {
        excluded.push(`${name} appears to belong to another person, not the patient.`);
      } else if (a.subject === SubjectRole.PATIENT && a.is_active && a.predicate === Predicate.NEGATED_USE_OF) {
        excluded.push(`Use of ${name} was explicitly negated.`);
      } else if (a.subject === SubjectRole.PATIENT && a.is_active && a.predicate === Predicate.HISTORICALLY_USED) {
        excluded.push(`${name} was described as past (historical) use.`);
      }
    }
    for (const p of state.proposals.values()) {
      if (p.status === 'cancelled') {
        excluded.push(`The proposed prescription of ${p.canonical_name ?? p.surface_text} was cancelled.`);
      }
    }

    outcome.missing_information = dedupe(missing);
    outcome.excluded_notes = dedupe(excluded);

    const hormonalRelevantMissing = [...outcome.missing_information];

    if (activeWarnings.length) {
      outcome.result_state = ResultState.EVIDENCE_FOUND;
      const recordIds = [...new Set(activeWarnings.map((w) => w.evidence_record_id))].sort();
      outcome.lookup_reason =
        'A verified-record lookup matched the current encounter graph ' +
        `(record ${recordIds.join(', ')}).`;
      return;
    }

    if (outcome.retracted.length) {
      outcome.result_state = ResultState.RETRACTED;
      outcome.lookup_reason =
        outcome.retracted[outcome.retracted.length - 1].retraction_reason ??
        'A previously shown warning was retracted.';
      return;
    }

    if (hormonalRelevantMissing.length) {
      outcome.result_state = ResultState.MORE_INFORMATION_REQUIRED;
      outcome.lookup_reason =
        'The encounter graph does not yet contain enough unambiguous context for a deterministic lookup.';
      return;
    }

    const hormonalFilled = Boolean(hormonalCurrent.length);
    const medicationFilled = Boolean(medicationCurrentOrPlanned.length);

    if (outcome.excluded_notes.length && !(hormonalFilled && medicationFilled)) {
      outcome.result_state = ResultState.EXCLUDED_CONTEXT;
      outcome.lookup_reason = 'A relevant-sounding mention is excluded from matching by its context.';
      return;
    }

    if (hormonalFilled && medicationFilled) {
      outcome.result_state = ResultState.NO_VALIDATED_MATCH;
      outcome.lookup_reason =
        'The medication context is clear but no record in the prototype evidence dataset matches this combination.';
      outcome.messages = [NO_MATCH_PRIMARY, NO_MATCH_SECONDARY];
      return;
    }

    if (hormonalFilled && !medicationFilled) {
      outcome.result_state = ResultState.MORE_INFORMATION_REQUIRED;
      outcome.missing_information = dedupe([
        ...outcome.missing_information,
        'No current or proposed patient medication has been identified yet.',
      ]);
      outcome.lookup_reason = 'A hormonal product is known but no other patient medication has been identified.';
      return;
    }

    if (medicationFilled && !hormonalFilled) {
      outcome.result_state = ResultState.MORE_INFORMATION_REQUIRED;
      outcome.missing_information = dedupe([
        ...outcome.missing_information,
        'The hormonal contraceptive method (if any) is not yet known.',
      ]);
      outcome.lookup_reason = 'A patient medication is known but the hormonal product context is not.';
      return;
    }

    if (outcome.excluded_notes.length) {
      outcome.result_state = ResultState.EXCLUDED_CONTEXT;
      outcome.lookup_reason = 'A relevant-sounding mention is excluded from matching by its context.';
      return;
    }

    outcome.result_state = ResultState.LISTENING;
    outcome.lookup_reason = 'No medication-relevant finalized turn has been analyzed yet.';
  }
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
