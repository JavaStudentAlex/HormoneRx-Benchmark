/**
 * Tier 2 — danger-condition specialists (w06–w10).
 *
 * Each specialist owns one hazard (or one hormonal product) and watches the
 * graph for it after every commit. Specialists can escalate visibility and ask
 * clarifying questions; they can never author medical text (only verbatim
 * quotes from evidence records), never create or suppress warnings, and never
 * touch the evidence dataset.
 */
import { Settings } from '../config.ts';
import { EvidenceIndex } from '../evidenceIndex.ts';
import {
  MentionCategory,
  MentionStatus,
  Predicate,
  SubjectRole,
  activeWarnings,
} from '../models.ts';
import { FindingDraft, FleetWorker, WorkerContext, WorkerRunResult } from './core.ts';

const LAMOTRIGINE = 'lamotrigine';
const ESTROGEN_CONCEPTS = new Set([
  'estrogen_containing_oral_contraceptive',
  'combined_hormonal_contraceptive',
]);
const POTENT_INDUCERS = new Set(['rifampicin', 'rifabutin']);
const PILL_FREE = /\b(pill[- ]free|hormone[- ]free|break week|seven[- ]day break)\b/i;
const SUPPLEMENT_TALK = /\b(supplements?|herbal|herbs|over[- ]the[- ]counter|otc|vitamins?)\b/i;

/** Return the verbatim sentence of a record field that contains `needle`. */
function verbatimSentence(
  index: EvidenceIndex,
  recordId: string,
  field: string,
  needle: string,
): string | null {
  const text = String(index.getRecord(recordId)?.[field] ?? '');
  const sentence = text
    .split(/(?<=\.)\s+/)
    .find((s) => s.toLowerCase().includes(needle.toLowerCase()));
  return sentence ?? null;
}

export function seizureRiskSpecialist(): FleetWorker {
  return {
    id: 'w06-seizure-risk',
    name: 'Seizure-risk specialist (lamotrigine)',
    tier: 2,
    cadence: 'commit',
    agentic: false,
    enabled: true,
    description:
      'Owns record INT-005, the only record whose consequence is loss of disease control ' +
      '(reduced lamotrigine exposure → seizure-control risk) rather than reduced ' +
      'contraceptive efficacy — the fleet\'s "deadly condition" watch. Behavior, per commit: ' +
      '(1) whenever a warning for INT-005 is active it is escalated to an alert finding so ' +
      'it always sits at the top of review; (2) near-miss watch: if lamotrigine AND an ' +
      'estrogen-containing product both appear anywhere in the graph (any status, including ' +
      'historical/negated/uncertain) but statuses do not currently trigger INT-005, it asks ' +
      'for both statuses to be confirmed verbally rather than letting the pair pass ' +
      'silently; (3) it scans the transcript for pill-free/hormone-free-interval phrases ' +
      'while lamotrigine is in the graph and, when found, quotes the record\'s own verbatim ' +
      'sentence about hormone-free intervals. It never states a consequence in its own words.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const findings: FindingDraft[] = [];
      const active = activeWarnings(ctx.snapshot);
      for (const w of active) {
        if (w.evidence_record_id !== 'INT-005') continue;
        findings.push({
          severity: 'alert',
          kind: 'seizure-risk-active',
          message:
            'Highest-priority review: warning INT-005 (estrogen-containing oral contraceptive × lamotrigine) is active. ' +
            'This record is reversed-direction — the concern is the interacting medication\'s exposure, not contraceptive efficacy.',
          refs: { warning_id: w.warning_id, record_id: 'INT-005' },
          dedupe_key: `active:${w.warning_id}`,
        });
      }

      const lamoPresent =
        ctx.snapshot.assertions.some((a) => a.concept_id === LAMOTRIGINE) ||
        ctx.snapshot.mentions.some((nm) => nm.concept_id === LAMOTRIGINE);
      const estrogenPresent =
        ctx.snapshot.assertions.some((a) => ESTROGEN_CONCEPTS.has(a.concept_id)) ||
        ctx.snapshot.mentions.some((nm) => nm.concept_id !== null && ESTROGEN_CONCEPTS.has(nm.concept_id));
      const int005Active = active.some((w) => w.evidence_record_id === 'INT-005');
      if (lamoPresent && estrogenPresent && !int005Active) {
        findings.push({
          severity: 'attention',
          kind: 'seizure-risk-nearmiss',
          message:
            'Lamotrigine and an estrogen-containing contraceptive were both mentioned in this encounter, but their ' +
            'current statuses do not trigger record INT-005. Confirm both statuses verbally before relying on that.',
          refs: { record_id: 'INT-005' },
          dedupe_key: 'nearmiss',
        });
      }

      if (lamoPresent) {
        const pillFreeTurn = ctx.snapshot.turns.find((t) => PILL_FREE.test(t.text));
        if (pillFreeTurn) {
          const quote = verbatimSentence(ctx.index, 'INT-005', 'potentialConsequence', 'hormone-free');
          findings.push({
            severity: 'attention',
            kind: 'pill-free-interval',
            message:
              `A pill-free/hormone-free interval was mentioned (${pillFreeTurn.turn_id}) while lamotrigine is in the graph.` +
              (quote ? ` Record INT-005 states: "${quote}"` : ' See record INT-005.'),
            refs: { turn_id: pillFreeTurn.turn_id, record_id: 'INT-005' },
            dedupe_key: `pillfree:${pillFreeTurn.turn_id}`,
          });
        }
      }
      return { findings };
    },
  };
}

export function potentInducerSpecialist(): FleetWorker {
  return {
    id: 'w07-potent-inducer',
    name: 'Potent-inducer specialist (rifampicin/rifabutin)',
    tier: 2,
    cadence: 'commit',
    agentic: false,
    enabled: true,
    description:
      'Owns record INT-002 — rifampicin/rifabutin, the potent enzyme inducers that the ' +
      'guidance singles out (US-MEC category 3; the two-pill workaround is explicitly ' +
      'excepted for them). Behavior, per commit: (1) when a potent inducer is a current or ' +
      'planned patient medication together with a combined/estrogen-containing product, it ' +
      'verifies the INT-002 warning is actually active — a missing expected warning is an ' +
      'integrity alert; (2) when a potent inducer is recorded but no hormonal context is ' +
      'known yet, it echoes the engine\'s request to establish the contraception context; ' +
      '(3) it checks that no (record, hormone, medication) pair ever carries two ' +
      'simultaneous active warnings (duplicate-warning integrity).',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const findings: FindingDraft[] = [];
      const patientActive = ctx.snapshot.assertions.filter(
        (a) => a.is_active && a.subject === SubjectRole.PATIENT,
      );
      const potent = patientActive.filter(
        (a) =>
          POTENT_INDUCERS.has(a.concept_id) &&
          (a.predicate === Predicate.CURRENTLY_TAKES || a.predicate === Predicate.PLANS_TO_TAKE),
      );
      const hormonal = patientActive.filter(
        (a) =>
          a.category === MentionCategory.HORMONAL_PRODUCT &&
          (a.predicate === Predicate.CURRENTLY_USES || a.predicate === Predicate.PLANS_TO_TAKE),
      );
      const active = activeWarnings(ctx.snapshot);

      for (const inducer of potent) {
        const estrogenActive = hormonal.filter((h) => ESTROGEN_CONCEPTS.has(h.concept_id));
        if (estrogenActive.length) {
          const int002 = active.find(
            (w) => w.evidence_record_id === 'INT-002' && w.medication_concept_id === inducer.concept_id,
          );
          if (int002) {
            findings.push({
              severity: 'alert',
              kind: 'potent-inducer-active',
              message: `Warning INT-002 is active for ${inducer.canonical_name} — a potent enzyme inducer per the record. Review with priority.`,
              refs: { warning_id: int002.warning_id, record_id: 'INT-002' },
              dedupe_key: `active:${int002.warning_id}`,
            });
          } else {
            findings.push({
              severity: 'alert',
              kind: 'expected-warning-missing',
              message: `${inducer.canonical_name} and an estrogen-containing product are both active for the patient but no INT-002 warning is active — investigate immediately (integrity check).`,
              refs: { record_id: 'INT-002', medication_assertion_id: inducer.assertion_id },
              dedupe_key: `missing:${inducer.assertion_id}`,
            });
          }
        } else if (!hormonal.length) {
          findings.push({
            severity: 'attention',
            kind: 'potent-inducer-context',
            message: `${inducer.canonical_name} is recorded for the patient but the hormonal contraceptive method (if any) is not yet known — establish that context.`,
            refs: { medication_assertion_id: inducer.assertion_id },
            dedupe_key: `context:${inducer.concept_id}`,
          });
        }
      }

      const seen = new Map<string, number>();
      for (const w of active) {
        const key = `${w.evidence_record_id}|${w.hormonal_concept_id}|${w.medication_concept_id}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const [key, count] of seen) {
        if (count > 1) {
          findings.push({
            severity: 'alert',
            kind: 'duplicate-warning',
            message: `Pair ${key} carries ${count} simultaneous active warnings — duplicate-warning integrity violation.`,
            refs: { pair: key },
            dedupe_key: `dup:${key}`,
          });
        }
      }
      return { findings };
    },
  };
}

export function washoutWindowSentinel(settings: Settings, index: EvidenceIndex): FleetWorker {
  // Union of every enzyme-inducer concept enumerated by the washout-carrying records.
  const WASHOUT_RECORDS = ['INT-001', 'INT-003', 'INT-004', 'INT-006'];
  const inducers = new Set<string>();
  for (const rid of WASHOUT_RECORDS) {
    for (const cid of (index.getRecord(rid)?.interactingConceptIds as string[] | undefined) ?? []) {
      inducers.add(cid);
    }
  }
  const enabled = settings.fleet_washout_sentinel;
  return {
    id: 'w08-washout-window',
    name: 'Washout-window sentinel',
    tier: 2,
    cadence: 'commit',
    agentic: false,
    enabled,
    disabledReason: enabled
      ? undefined
      : 'PROPOSED behavior change awaiting physician sign-off (VERIFICATION_TABLE.md addendum): ' +
        'records INT-001/003/004 state the contraceptive is not recommended "for 28 days after ' +
        'stopping" an enzyme inducer, and INT-006 states induction persists "up to 4 weeks after" ' +
        'stopping — but the engine treats a stated stop as historical context and retracts. ' +
        'Enable in development with FLEET_WASHOUT_SENTINEL=true; forced off in production.',
    description:
      'Closes the washout blind spot — advisory-only and disabled until the physician signs ' +
      'it off. Behavior when enabled, per commit: it looks for a patient assertion of an ' +
      'enzyme-inducer concept (the union of the members enumerated by records ' +
      'INT-001/003/004/006) whose status is historical or negated, while a hormonal product ' +
      'is active or planned for the patient. For each such case it emits an attention ' +
      'finding that (a) quotes, verbatim, the matching record\'s own sentence about the ' +
      '28-day / 4-week persistence after stopping, and (b) asks exactly when the medication ' +
      'was stopped. It never creates a warning, never changes an assertion, and never alters ' +
      'the result state — the graph and warning pipeline are untouched by design until the ' +
      'physician approves a stronger behavior.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const findings: FindingDraft[] = [];
      const patient = ctx.snapshot.assertions.filter(
        (a) => a.is_active && a.subject === SubjectRole.PATIENT,
      );
      const hormonalActive = patient.filter(
        (a) =>
          a.category === MentionCategory.HORMONAL_PRODUCT &&
          (a.predicate === Predicate.CURRENTLY_USES || a.predicate === Predicate.PLANS_TO_TAKE),
      );
      if (!hormonalActive.length) return { findings };
      const stoppedInducers = patient.filter(
        (a) =>
          inducers.has(a.concept_id) &&
          (a.status === MentionStatus.HISTORICAL || a.status === MentionStatus.NEGATED),
      );
      for (const stopped of stoppedInducers) {
        const record = WASHOUT_RECORDS.find((rid) => {
          const rec = ctx.index.getRecord(rid);
          const members = (rec?.interactingConceptIds as string[] | undefined) ?? [];
          const hormones = (rec?.hormonalConceptIds as string[] | undefined) ?? [];
          return (
            members.includes(stopped.concept_id) &&
            hormonalActive.some((h) => hormones.includes(h.concept_id))
          );
        });
        if (!record) continue;
        const quote =
          verbatimSentence(ctx.index, record, 'potentialConsequence', '28 days') ??
          verbatimSentence(ctx.index, record, 'potentialConsequence', '4 weeks');
        findings.push({
          severity: 'attention',
          kind: 'washout-window',
          message:
            `${stopped.canonical_name} was described as stopped or not taken, but record ${record} states: ` +
            (quote ? `"${quote}" ` : '(see the record\'s consequence text) ') +
            'Ask exactly when it was stopped. [Advisory only — behavior pending physician sign-off.]',
          refs: {
            record_id: record,
            medication_assertion_id: stopped.assertion_id,
            hormonal_assertion_ids: hormonalActive.map((h) => h.assertion_id),
          },
          dedupe_key: `washout:${stopped.concept_id}:${record}`,
        });
      }
      return { findings };
    },
  };
}

export function hiddenInducerHunter(): FleetWorker {
  return {
    id: 'w09-hidden-inducer-hunter',
    name: 'Hidden-inducer hunter (herbal/OTC/EC)',
    tier: 2,
    cadence: 'turn',
    agentic: false,
    enabled: true,
    description:
      'Owns the agents patients do not think of as medications, grounded in record INT-006. ' +
      'Behavior, per finalized turn: (1) if the turn talks about supplements, herbal ' +
      'products, vitamins or over-the-counter items without naming a product (no mention ' +
      'extracted from the turn), it asks for specific product names and notes that the ' +
      'evidence dataset contains herbal entries (St John\'s wort, record INT-006); (2) when ' +
      'levonorgestrel emergency contraception enters the graph it raises a time-critical ' +
      'attention finding quoting record INT-006\'s population definition verbatim — the ' +
      'record concerns enzyme-inducer use within the last 4 weeks, so recent medication ' +
      'history must be asked about now, not later.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const turn = ctx.latestTurn!;
      const findings: FindingDraft[] = [];
      const turnMentions = ctx.snapshot.mentions.filter(
        (nm) => nm.mention.source_turn_id === turn.turn_id,
      );
      if (SUPPLEMENT_TALK.test(turn.text) && !turnMentions.length) {
        findings.push({
          severity: 'attention',
          kind: 'unnamed-supplement',
          message:
            `Turn ${turn.turn_id} mentions supplements/herbal/OTC products without naming one — ask for specific product names. ` +
            'The evidence dataset includes herbal entries (e.g. St John\'s wort, record INT-006).',
          refs: { turn_id: turn.turn_id, record_id: 'INT-006' },
          dedupe_key: `supplement:${turn.turn_id}`,
        });
      }
      const ecMention = turnMentions.find(
        (nm) => nm.concept_id === 'levonorgestrel_emergency_contraception',
      );
      if (ecMention) {
        const population = String(ctx.index.getRecord('INT-006')?.population ?? '');
        findings.push({
          severity: 'attention',
          kind: 'ec-time-critical',
          message:
            `Emergency contraception entered the encounter (${turn.turn_id}). Record INT-006 population: "${population}". ` +
            'Ask about medication use in the recent weeks now.',
          refs: { turn_id: turn.turn_id, record_id: 'INT-006' },
          dedupe_key: 'ec-context',
        });
      }
      return { findings };
    },
  };
}

interface HormoneWatcherConfig {
  id: string;
  name: string;
  concepts: string[];
  records: string[];
}

function hormoneWatcher(cfg: HormoneWatcherConfig): FleetWorker {
  const conceptSet = new Set(cfg.concepts);
  return {
    id: cfg.id,
    name: cfg.name,
    tier: 2,
    cadence: 'commit',
    agentic: false,
    enabled: true,
    description:
      `Per-product overlay watcher for ${cfg.concepts.join(', ')} (records ${cfg.records.join(', ')}). ` +
      'Behavior, per commit: (1) whenever its product is asserted for the patient it logs a ' +
      'status summary (status, applicable records, active/retracted warning counts for its ' +
      'records) so coverage for this product is one worker\'s clear responsibility; (2) when ' +
      'its product is in play and any of its records runs only under the pending-verification ' +
      'override, it flags that physician sign-off is outstanding for exactly those records. ' +
      'It owns no matching logic — matching stays in the deterministic pair index.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const findings: FindingDraft[] = [];
      const productAssertions = ctx.snapshot.assertions.filter(
        (a) => a.subject === SubjectRole.PATIENT && conceptSet.has(a.concept_id) && a.is_active,
      );
      if (!productAssertions.length) return { findings };
      const myWarnings = ctx.snapshot.warnings.filter((w) => cfg.records.includes(w.evidence_record_id));
      const activeCount = myWarnings.filter((w) => w.state === 'active' || w.state === 'updated').length;
      const retractedCount = myWarnings.filter((w) => w.state === 'retracted').length;
      for (const a of productAssertions) {
        findings.push({
          severity: 'info',
          kind: 'product-status',
          message: `${a.canonical_name}: status ${a.status} for the patient; ${cfg.records.length} applicable record(s) (${cfg.records.join(', ')}); warnings — ${activeCount} active, ${retractedCount} retracted.`,
          refs: { assertion_id: a.assertion_id, records: cfg.records },
          dedupe_key: `status:${a.concept_id}:${a.status}:${activeCount}:${retractedCount}`,
        });
      }
      const pending = cfg.records.filter((rid) => ctx.index.reports[rid]?.eligible_via_pending_override);
      if (pending.length) {
        findings.push({
          severity: 'attention',
          kind: 'sign-off-pending',
          message: `${pending.length} record(s) for this product (${pending.join(', ')}) run under the pending-verification override — physician sign-off is outstanding.`,
          refs: { records: pending },
          dedupe_key: `signoff:${cfg.id}`,
        });
      }
      return { findings };
    },
  };
}

export function hormoneWatchers(): FleetWorker[] {
  return [
    hormoneWatcher({
      id: 'w10a-chc-watcher',
      name: 'CHC watcher',
      concepts: ['combined_hormonal_contraceptive', 'estrogen_containing_oral_contraceptive'],
      records: ['INT-001', 'INT-002', 'INT-005'],
    }),
    hormoneWatcher({
      id: 'w10b-pop-watcher',
      name: 'POP watcher',
      concepts: ['progestogen_only_pill'],
      records: ['INT-003'],
    }),
    hormoneWatcher({
      id: 'w10c-implant-watcher',
      name: 'Implant watcher',
      concepts: ['etonogestrel_implant'],
      records: ['INT-004'],
    }),
    hormoneWatcher({
      id: 'w10d-ec-watcher',
      name: 'Emergency-contraception watcher',
      concepts: ['levonorgestrel_emergency_contraception'],
      records: ['INT-006'],
    }),
  ];
}
