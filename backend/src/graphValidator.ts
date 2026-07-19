/**
 * Graph consistency validation (spec §16.4).
 *
 * Violations indicate an engine bug; they raise in tests and are logged and
 * converted to PROCESSING_ERROR at runtime rather than silently continuing.
 */
import { EvidenceIndex } from './evidenceIndex.ts';
import { GraphState } from './graphReducer.ts';
import { Predicate, SubjectRole, WarningRecord } from './models.ts';

export class GraphInvariantViolation extends Error {
  violations: string[];
  constructor(violations: string[]) {
    super(violations.join('; '));
    this.name = 'GraphInvariantViolation';
    this.violations = violations;
  }
}

export class GraphValidator {
  constructor(private index: EvidenceIndex) {}

  validate(state: GraphState, warnings: WarningRecord[] = []): string[] {
    const violations: string[] = [];
    const turnIds = new Set(state.turns.map((t) => t.turn_id));
    const assertionIds = new Set(state.assertions.keys());

    for (const a of state.assertions.values()) {
      if (a.is_active) {
        // 1. Every active assertion has a source transcript turn or UI event.
        if (a.origin === 'speech' && !turnIds.has(a.source_turn_id)) {
          violations.push(`active assertion ${a.assertion_id} has no source turn`);
        }
        if (a.origin === 'ui_proposal' && !a.proposal_id) {
          violations.push(`active UI assertion ${a.assertion_id} has no proposal id`);
        }
        // 6. Negated and historical assertions are not "active current" state.
        if (
          (a.predicate === Predicate.HISTORICALLY_USED || a.predicate === Predicate.NEGATED_USE_OF) &&
          a.status === 'current'
        ) {
          violations.push(`assertion ${a.assertion_id} predicate/status mismatch`);
        }
      }
      // 8. A superseded assertion cannot remain active.
      if (a.superseded_by_assertion_id && a.is_active) {
        violations.push(`assertion ${a.assertion_id} superseded but still active`);
      }
      if (a.supersedes_assertion_id && !assertionIds.has(a.supersedes_assertion_id)) {
        violations.push(`assertion ${a.assertion_id} supersedes unknown assertion`);
      }
    }

    // 2. Every mention links to one normalized concept or is explicitly unknown.
    for (const nm of state.mentions) {
      if (nm.normalization_status === 'normalized' && !nm.concept_id) {
        violations.push(`mention ${nm.mention.mention_id} normalized without concept id`);
      }
    }

    for (const w of warnings) {
      if (w.state === 'active' || w.state === 'updated') {
        // 3. Every warning links to active trigger assertions.
        for (const aid of w.trigger_assertion_ids) {
          const assertion = state.assertions.get(aid);
          if (!assertion || !assertion.is_active) {
            violations.push(`warning ${w.warning_id} references inactive assertion ${aid}`);
          }
        }
        // 4./5. Warnings only from runtime-eligible records.
        const report = this.index.reports[w.evidence_record_id];
        if (!report || !report.runtime_eligible) {
          violations.push(`warning ${w.warning_id} references ineligible record ${w.evidence_record_id}`);
        }
        // 7. Other-person assertions never enter the patient pair set.
        for (const aid of w.trigger_assertion_ids) {
          const assertion = state.assertions.get(aid);
          if (assertion && assertion.subject !== SubjectRole.PATIENT) {
            violations.push(`warning ${w.warning_id} triggered by non-patient assertion ${aid}`);
          }
        }
      }
    }

    return violations;
  }

  validateOrRaise(state: GraphState, warnings: WarningRecord[] = []): void {
    const violations = this.validate(state, warnings);
    if (violations.length) {
      throw new GraphInvariantViolation(violations);
    }
  }
}
