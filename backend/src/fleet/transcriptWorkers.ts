/**
 * Tier 1 — transcript workers (w01–w05).
 *
 * These run on every finalized turn (or every commit) and cover the realtime
 * extraction path: the primary extractor's heartbeat, cross-turn context,
 * contradiction hunting, subject attribution, and ambiguity policing.
 * Detailed behavior contracts live in docs/FLEET.md (same text as the
 * `description` fields here).
 */
import { Settings, liveExtractionAvailable } from '../config.ts';
import { MedicationContextExtractor } from '../extractor.ts';
import {
  EventType,
  MentionStatus,
  NormalizationStatus,
  SubjectRole,
  TranscriptTurn,
  makeTranscriptTurn,
} from '../models.ts';
import { FindingDraft, FleetWorker, WorkerContext, WorkerRunResult } from './core.ts';

const UNDERSPECIFIED_REFERENCE =
  /\b(that one|the other (?:pill|one|medication)|the same (?:pill|medication|one))\b/i;

export function detailExtractorWorker(settings: Settings): FleetWorker {
  const agentic = !settings.demo_mode && liveExtractionAvailable(settings);
  return {
    id: 'w01-detail-extractor',
    name: 'Detail extractor',
    tier: 1,
    cadence: 'turn',
    agentic,
    enabled: true,
    description:
      'The primary per-turn extraction agent. It is the component that actually runs inside ' +
      'turn processing (live structured-output model when a key is configured, deterministic ' +
      'rule extractor otherwise); its fleet entry is the heartbeat and audit of that run. ' +
      'After every finalized turn it verifies a MENTIONS_EXTRACTED event exists for the turn, ' +
      'reports which extraction method produced it, and raises an attention finding whenever ' +
      'the live model failed and the deterministic fallback was used — so silent quality ' +
      'degradation is impossible.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const turn = ctx.latestTurn!;
      const findings: FindingDraft[] = [];
      const extraction = ctx.events.find(
        (e) => e.event_type === EventType.MENTIONS_EXTRACTED && e.payload.turn_id === turn.turn_id,
      );
      if (!extraction) {
        findings.push({
          severity: 'alert',
          kind: 'extraction-missing',
          message: `Turn ${turn.turn_id} has no extraction event; the transcript is retained but the turn did not reach the graph.`,
          refs: { turn_id: turn.turn_id },
          dedupe_key: `missing:${turn.turn_id}`,
        });
      } else if (extraction.payload.extraction_method === 'deterministic_fallback') {
        findings.push({
          severity: 'attention',
          kind: 'extraction-fallback',
          message: `Live extraction failed for ${turn.turn_id}; the deterministic rule extractor was used instead. Structured output is unaffected, but review live-model connectivity.`,
          refs: { turn_id: turn.turn_id },
          dedupe_key: `fallback:${turn.turn_id}`,
        });
      }
      return { findings };
    },
  };
}

export function bigPictureWorker(
  settings: Settings,
  windowExtractor: MedicationContextExtractor,
): FleetWorker {
  const agentic = !settings.demo_mode && liveExtractionAvailable(settings);
  return {
    id: 'w02-big-picture',
    name: 'Big-picture worker',
    tier: 1,
    cadence: 'turn',
    agentic,
    enabled: true,
    description:
      'Cross-turn context agent. Where the detail extractor sees one turn at a time, this ' +
      'worker re-reads a sliding window of recent turns as one context. Behavior: (1) it ' +
      'joins each pair of adjacent same-speaker turns and re-runs extraction on the joined ' +
      'text, catching mentions split across a turn boundary ("I\'m on the combined" / "pill, ' +
      'yes"); any concept found in the join that has no existing mention or assertion is ' +
      'proposed as a supplementary extraction — merged into the turn\'s extraction event and ' +
      'decided by the ordinary reducer, never written to the graph directly. (2) it flags ' +
      'underspecified references ("that one", "the other pill") that produced no mention, ' +
      'asking for the name to be restated. In live mode the window re-extraction runs through ' +
      'the same structured-output model contract as the primary extractor.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const result: WorkerRunResult = { findings: [], proposals: [] };
      const turn = ctx.latestTurn!;
      const turns = ctx.snapshot.turns;
      const idx = turns.findIndex((t) => t.turn_id === turn.turn_id);
      if (idx < 0) return result;

      // (1) split-mention join over adjacent same-speaker turns
      const prev = idx > 0 ? turns[idx - 1] : null;
      if (prev && prev.speaker === turn.speaker) {
        const joined: TranscriptTurn = makeTranscriptTurn({
          turn_id: turn.turn_id,
          sequence: turn.sequence,
          speaker: turn.speaker,
          text: `${prev.text} ${turn.text}`,
          is_final: true,
          received_at: turn.received_at,
        });
        const extraction = await windowExtractor.extract(joined);
        const normalized = ctx.normalizer.normalize(extraction.mentions);
        const knownConcepts = new Set<string>();
        for (const nm of ctx.snapshot.mentions) {
          if (nm.concept_id) knownConcepts.add(`${nm.mention.subject} ${nm.concept_id}`);
        }
        for (const a of ctx.snapshot.assertions) {
          knownConcepts.add(`${a.subject} ${a.concept_id}`);
        }
        const fresh = normalized.filter(
          (nm) =>
            nm.normalization_status === NormalizationStatus.NORMALIZED &&
            nm.concept_id &&
            !knownConcepts.has(`${nm.mention.subject} ${nm.concept_id}`),
        );
        if (fresh.length) {
          // Spans measured against the joined text do not map onto either turn.
          const mentions = fresh.map((nm) => ({
            ...nm,
            mention: { ...nm.mention, span_start: null, span_end: null, source_turn_id: turn.turn_id },
          }));
          result.proposals!.push({
            turn_id: turn.turn_id,
            normalized_mentions: mentions,
            corrections: [],
            missing_information: [],
            note: `w02-big-picture: mention split across ${prev.turn_id} + ${turn.turn_id}`,
          });
          result.findings.push({
            severity: 'attention',
            kind: 'split-mention',
            message: `A mention split across turns ${prev.turn_id} and ${turn.turn_id} was recovered from the joined text (${mentions
              .map((m) => m.canonical_name)
              .join(', ')}) and proposed to the graph.`,
            refs: { turn_ids: [prev.turn_id, turn.turn_id], concepts: mentions.map((m) => m.concept_id) },
            dedupe_key: `join:${prev.turn_id}:${turn.turn_id}`,
          });
        }
      }

      // (2) underspecified references with no extracted mention
      const turnHasMention = ctx.snapshot.mentions.some(
        (nm) => nm.mention.source_turn_id === turn.turn_id,
      );
      if (UNDERSPECIFIED_REFERENCE.test(turn.text) && !turnHasMention) {
        result.findings.push({
          severity: 'attention',
          kind: 'underspecified-reference',
          message: `Turn ${turn.turn_id} refers to a medication without naming it ("${turn.text.match(UNDERSPECIFIED_REFERENCE)?.[0]}") — ask for the product name to be restated.`,
          refs: { turn_id: turn.turn_id },
          dedupe_key: `underspec:${turn.turn_id}`,
        });
      }
      return result;
    },
  };
}

export function contradictionHunterWorker(): FleetWorker {
  return {
    id: 'w03-contradiction-hunter',
    name: 'Contradiction hunter',
    tier: 1,
    cadence: 'commit',
    agentic: false,
    enabled: true,
    description:
      'Watches the whole assertion history after every graph commit. Behavior: (1) every ' +
      'resolved contradiction (polarity flip or explicit correction, from the reducer\'s ' +
      'conflict notes) is surfaced as a finding so it is visibly acknowledged, not just ' +
      'applied; (2) unresolved same-turn contradictions (which make the engine abstain) are ' +
      'raised at alert severity; (3) a concept whose patient status flipped two or more times ' +
      'during the encounter is flagged as a repeated flip-flop with a request to confirm the ' +
      'current status verbally; (4) integrity: every retracted warning must carry a ' +
      'retraction reason — a missing reason is an alert.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const findings: FindingDraft[] = [];
      for (const note of ctx.snapshot.conflict_notes) {
        findings.push({
          severity: 'attention',
          kind: 'resolved-contradiction',
          message: note,
          dedupe_key: `conflict:${note}`,
        });
      }
      for (const info of ctx.snapshot.missing_information) {
        if (info.startsWith('Contradictory statements about')) {
          findings.push({
            severity: 'alert',
            kind: 'unresolved-contradiction',
            message: `${info} The engine abstains until this is clarified.`,
            dedupe_key: `unresolved:${info}`,
          });
        }
      }
      const bySubjectConcept = new Map<string, string[]>();
      for (const a of [...ctx.snapshot.assertions].sort((x, y) => x.valid_from.localeCompare(y.valid_from))) {
        if (a.subject !== SubjectRole.PATIENT || a.origin !== 'speech') continue;
        const key = `${a.subject} ${a.concept_id}`;
        const seq = bySubjectConcept.get(key) ?? [];
        seq.push(a.status);
        bySubjectConcept.set(key, seq);
      }
      for (const [key, seq] of bySubjectConcept) {
        let flips = 0;
        for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) flips += 1;
        if (flips >= 2) {
          const conceptId = key.split(' ')[1];
          findings.push({
            severity: 'attention',
            kind: 'repeated-flip-flop',
            message: `The stated status of ${ctx.index.ontology.canonicalName(conceptId)} changed ${flips} times during this encounter (${seq.join(' → ')}). Confirm the current status verbally.`,
            refs: { concept_id: conceptId, statuses: seq },
            dedupe_key: `flipflop:${conceptId}:${seq.length}`,
          });
        }
      }
      for (const w of ctx.snapshot.warnings) {
        if (w.state === 'retracted' && !w.retraction_reason) {
          findings.push({
            severity: 'alert',
            kind: 'missing-retraction-reason',
            message: `Warning ${w.warning_id} was retracted without a stated reason — lifecycle integrity violation.`,
            refs: { warning_id: w.warning_id },
            dedupe_key: `noreason:${w.warning_id}`,
          });
        }
      }
      return { findings };
    },
  };
}

export function subjectAuditorWorker(): FleetWorker {
  return {
    id: 'w04-subject-auditor',
    name: 'Subject auditor',
    tier: 1,
    cadence: 'turn',
    agentic: false,
    enabled: true,
    description:
      'Verifies who each mention belongs to before it can matter. Behavior, per finalized ' +
      'turn: (1) a current-status mention whose subject could not be attributed (unknown) is ' +
      'raised at attention severity with a request to confirm whether it refers to the ' +
      'patient — mirroring the engine\'s own abstention; (2) mentions attributed to another ' +
      'person (e.g. "my sister takes…") are logged as informational findings confirming the ' +
      'exclusion from patient matching; (3) doctor self-references are logged the same way. ' +
      'The auditor never reassigns a subject — it only asks.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const turn = ctx.latestTurn!;
      const findings: FindingDraft[] = [];
      for (const nm of ctx.snapshot.mentions) {
        if (nm.mention.source_turn_id !== turn.turn_id) continue;
        const name = nm.canonical_name ?? nm.mention.surface_text;
        if (
          nm.mention.subject === SubjectRole.UNKNOWN &&
          nm.mention.status === MentionStatus.CURRENT
        ) {
          findings.push({
            severity: 'attention',
            kind: 'unattributed-mention',
            message: `It is unclear whether "${name}" refers to the patient — confirm who takes it before it can enter matching.`,
            refs: { mention_id: nm.mention.mention_id, turn_id: turn.turn_id },
            dedupe_key: `unattributed:${nm.mention.mention_id}`,
          });
        } else if (nm.mention.subject === SubjectRole.OTHER_PERSON) {
          findings.push({
            severity: 'info',
            kind: 'other-person-mention',
            message: `"${name}" is attributed to another person and is excluded from patient matching.`,
            refs: { mention_id: nm.mention.mention_id, turn_id: turn.turn_id },
            dedupe_key: `other:${nm.mention.mention_id}`,
          });
        } else if (nm.mention.subject === SubjectRole.DOCTOR) {
          findings.push({
            severity: 'info',
            kind: 'doctor-self-mention',
            message: `"${name}" is attributed to the doctor, not the patient, and is excluded from patient matching.`,
            refs: { mention_id: nm.mention.mention_id, turn_id: turn.turn_id },
            dedupe_key: `doctor:${nm.mention.mention_id}`,
          });
        }
      }
      return { findings };
    },
  };
}

export function ambiguitySentinelWorker(): FleetWorker {
  return {
    id: 'w05-ambiguity-sentinel',
    name: 'Ambiguity sentinel',
    tier: 1,
    cadence: 'commit',
    agentic: false,
    enabled: true,
    description:
      'Polices the abstain-instead-of-guess rule after every commit. Behavior: (1) every ' +
      'mention normalized as AMBIGUOUS ("the pill", class words like "enzyme inducer") is ' +
      'surfaced with the ontology\'s approved clarification question — the sentinel confirms ' +
      'the engine asked instead of guessed; (2) when mutually exclusive products (e.g. two ' +
      'different oral pills) are simultaneously recorded, the clarification request is ' +
      'escalated to a finding; (3) integrity: an ambiguous mention that neither produced a ' +
      'clarification question nor was superseded by a concrete product is an alert, because ' +
      'it would mean the system silently ignored ambiguity.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const findings: FindingDraft[] = [];
      for (const nm of ctx.snapshot.mentions) {
        if (nm.normalization_status !== NormalizationStatus.AMBIGUOUS) continue;
        if (nm.mention.status === MentionStatus.NEGATED) continue;
        const question = nm.missing_information;
        if (question) {
          findings.push({
            severity: 'attention',
            kind: 'ambiguous-alias',
            message: `"${nm.mention.surface_text}" is deliberately ambiguous — the engine abstains. Clarify: ${question}`,
            refs: { mention_id: nm.mention.mention_id, candidates: nm.candidate_concept_ids },
            dedupe_key: `ambiguous:${nm.mention.mention_id}`,
          });
        } else {
          findings.push({
            severity: 'alert',
            kind: 'silent-ambiguity',
            message: `Ambiguous mention "${nm.mention.surface_text}" carries no clarification question — ambiguity must never be silently ignored.`,
            refs: { mention_id: nm.mention.mention_id },
            dedupe_key: `silent:${nm.mention.mention_id}`,
          });
        }
      }
      for (const info of ctx.snapshot.missing_information) {
        if (info.includes('confirm which one is in use')) {
          findings.push({
            severity: 'attention',
            kind: 'mutual-exclusivity',
            message: info,
            dedupe_key: `mutex:${info}`,
          });
        }
      }
      return { findings };
    },
  };
}
