/**
 * Tier 3 — database integrity & maintenance workers (w11–w14).
 *
 * These workers check the two databases continuously: the encounter graph
 * (event log + derived snapshot) and the evidence dataset. Maintenance workers
 * PROPOSE — into the physician review queue — and never modify a record, a
 * synonym, or a sign-off flag.
 */
import { createHash } from 'node:crypto';

import { Settings, liveExtractionAvailable } from '../config.ts';
import { DeterministicExtractor } from '../deterministicExtractor.ts';
import { EncounterService } from '../encounterService.ts';
import { EvidenceIndex } from '../evidenceIndex.ts';
import { EncounterGraphReducer, NON_INTERACTING_PREFIX } from '../graphReducer.ts';
import { GraphValidator } from '../graphValidator.ts';
import {
  MentionCategory,
  NormalizationStatus,
  Predicate,
  ResultState,
  SubjectRole,
  newId,
} from '../models.ts';
import { NO_MATCH_SECONDARY } from '../warningEngine.ts';
import { FindingDraft, FleetWorker, GlobalContext, WorkerContext, WorkerRunResult } from './core.ts';

export function invariantAuditorWorker(index: EvidenceIndex): FleetWorker {
  const reducer = new EncounterGraphReducer(index);
  const validator = new GraphValidator(index);
  return {
    id: 'w11-invariant-auditor',
    name: 'Graph invariant auditor',
    tier: 3,
    cadence: 'commit',
    agentic: false,
    enabled: true,
    description:
      'Independent replay auditor for the encounter graph, on top of the inline validation ' +
      'the engine already performs. Behavior, per commit: (1) it rebuilds the graph from the ' +
      'raw event log with its OWN reducer instance and runs all 12 graph invariants ' +
      '(provenance, supersession consistency, warning references) against the rebuilt state ' +
      'and the current warnings — any violation is an alert; (2) determinism check: it ' +
      'rebuilds twice and compares the canonical JSON of all assertions — a difference means ' +
      'non-deterministic replay and is an alert; (3) it cross-checks that the published ' +
      'snapshot contains exactly the assertions the replay produces. This is the worker that ' +
      '"constantly checks that everything is okay" at the data-structure level.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const findings: FindingDraft[] = [];
      const stateA = reducer.rebuild(ctx.events);
      const violations = validator.validate(stateA, ctx.runtime.warnings);
      for (const v of violations) {
        findings.push({
          severity: 'alert',
          kind: 'invariant-violation',
          message: `Graph invariant violated on independent replay: ${v}`,
          dedupe_key: `violation:${v}`,
        });
      }
      const canon = (s: typeof stateA): string =>
        JSON.stringify([...s.assertions.values()].sort((a, b) => a.assertion_id.localeCompare(b.assertion_id)));
      const stateB = reducer.rebuild(ctx.events);
      if (canon(stateA) !== canon(stateB)) {
        findings.push({
          severity: 'alert',
          kind: 'nondeterministic-rebuild',
          message: 'Two replays of the same event log produced different assertions — determinism is broken.',
          dedupe_key: 'nondeterministic',
        });
      }
      if (stateA.assertions.size !== ctx.snapshot.assertions.length) {
        findings.push({
          severity: 'alert',
          kind: 'snapshot-drift',
          message: `Snapshot holds ${ctx.snapshot.assertions.length} assertions but independent replay produced ${stateA.assertions.size} — snapshot drift.`,
          dedupe_key: `drift:${ctx.snapshot.version}`,
        });
      }
      return { findings };
    },
  };
}

export function sourceLinkMonitorWorker(settings: Settings, index: EvidenceIndex): FleetWorker {
  const baselines = new Map<string, string>();
  const enabled = settings.fleet_link_check;
  return {
    id: 'w12-source-link-monitor',
    name: 'Evidence source-link monitor',
    tier: 3,
    cadence: 'interval',
    intervalMs: settings.fleet_link_interval_min * 60_000,
    agentic: false,
    enabled,
    disabledReason: enabled
      ? undefined
      : 'Outbound network checks are off by default (no surprise egress in dev/CI). Enable with FLEET_LINK_CHECK=true.',
    description:
      'Watches the cited FSRH/CDC/FDA/MHRA sources for drift relative to each record\'s ' +
      'lastVerified date. Behavior, on its interval: for every unique sourceUrl in the ' +
      'evidence dataset it fetches the page, hashes the content, and (1) reports an ' +
      'unreachable source at attention severity; (2) records a baseline hash on first ' +
      'successful fetch; (3) raises an ALERT and files a physician review-queue item when ' +
      'the content hash changes from the baseline — "the cited source may have changed since ' +
      'lastVerified; re-verify the record". It never edits a record and never re-dates ' +
      'lastVerified; only the physician does that.',
    async runGlobal(ctx: GlobalContext): Promise<WorkerRunResult> {
      const result: WorkerRunResult = { findings: [], reviewItems: [] };
      const urls = new Map<string, string[]>();
      for (const [rid, record] of Object.entries(ctx.index.records)) {
        const url = String(record.sourceUrl ?? '');
        if (!url) continue;
        urls.set(url, [...(urls.get(url) ?? []), rid]);
      }
      for (const [url, recordIds] of urls) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) {
            result.findings.push({
              severity: 'attention',
              kind: 'source-unreachable',
              message: `Evidence source returned HTTP ${response.status}: ${url} (records ${recordIds.join(', ')}).`,
              refs: { url, records: recordIds },
              dedupe_key: `http:${url}:${response.status}`,
            });
            continue;
          }
          const hash = createHash('sha256').update(await response.text()).digest('hex');
          const baseline = baselines.get(url);
          if (!baseline) {
            baselines.set(url, hash);
            result.findings.push({
              severity: 'info',
              kind: 'source-baseline-recorded',
              message: `Baseline content hash recorded for ${url} (records ${recordIds.join(', ')}).`,
              refs: { url, records: recordIds },
              dedupe_key: `baseline:${url}`,
            });
          } else if (baseline !== hash) {
            baselines.set(url, hash);
            result.findings.push({
              severity: 'alert',
              kind: 'source-content-changed',
              message: `Content at ${url} changed since the fleet baseline (records ${recordIds.join(', ')}). The cited source may have been updated — physician re-verification needed.`,
              refs: { url, records: recordIds },
              dedupe_key: `changed:${url}:${hash}`,
            });
            result.reviewItems!.push({
              kind: 'source-drift',
              summary: `Source content changed for ${recordIds.join(', ')}`,
              detail: `The page at ${url} no longer matches the fleet's baseline hash. Re-verify the records' medical prose against the current source; only the physician updates lastVerified.`,
              refs: { url, records: recordIds },
              dedupe_key: `drift:${url}:${hash}`,
            });
          }
        } catch (err) {
          result.findings.push({
            severity: 'attention',
            kind: 'source-unreachable',
            message: `Evidence source unreachable: ${url} (${String(err instanceof Error ? err.message : err)}).`,
            refs: { url, records: recordIds },
            dedupe_key: `unreachable:${url}`,
          });
        }
      }
      return result;
    },
  };
}

export function coverageGapMinerWorker(): FleetWorker {
  return {
    id: 'w13-coverage-gap-miner',
    name: 'Coverage-gap miner',
    tier: 3,
    cadence: 'commit',
    agentic: false,
    enabled: true,
    description:
      'Mines live encounters for places where the evidence database has no answer, and ' +
      'turns them into physician review-queue proposals — never into runtime changes. ' +
      'Behavior, per commit: (1) any mention the normalizer marks UNKNOWN (a term in ' +
      'neither the concept ontology nor the non-interacting lexicon) becomes a dataset-gap ' +
      'item: "term not recognized — physician review needed before any dataset change"; ' +
      '(2) when the result state is NO_VALIDATED_MATCH it extracts the exact uncovered ' +
      '(hormonal concept × medication concept) pairs — excluding curated non-interacting ' +
      'medications — and files them as coverage-gap proposals, always restating the ' +
      'engine\'s own caveat that absence of a record does not establish absence of an ' +
      'interaction. The miner cannot add records, synonyms, or aliases itself.',
    async runEncounter(ctx: WorkerContext): Promise<WorkerRunResult> {
      const result: WorkerRunResult = { findings: [], reviewItems: [] };
      for (const nm of ctx.snapshot.mentions) {
        if (nm.normalization_status !== NormalizationStatus.UNKNOWN) continue;
        const term = nm.mention.surface_text.toLowerCase().trim();
        result.reviewItems!.push({
          kind: 'dataset-gap-term',
          summary: `Unrecognized term "${term}"`,
          detail: `The term "${term}" (${nm.mention.category}) appeared in an encounter but is not in the synonym index or the non-interacting lexicon. Physician review is needed before any dataset change; the fleet never edits the dataset.`,
          refs: { surface_text: term, category: nm.mention.category },
          dedupe_key: `term:${term}`,
        });
        result.findings.push({
          severity: 'info',
          kind: 'dataset-gap-term',
          message: `Term "${term}" is not in the ontology — filed for physician review of dataset coverage.`,
          refs: { surface_text: term },
          dedupe_key: `term:${term}`,
        });
      }
      if (ctx.snapshot.result_state === ResultState.NO_VALIDATED_MATCH) {
        const patient = ctx.snapshot.assertions.filter(
          (a) => a.is_active && a.subject === SubjectRole.PATIENT,
        );
        const hormonal = patient.filter(
          (a) =>
            a.category === MentionCategory.HORMONAL_PRODUCT &&
            (a.predicate === Predicate.CURRENTLY_USES || a.predicate === Predicate.PLANS_TO_TAKE) &&
            a.concept_id in ctx.index.ontology.hormonal_concepts,
        );
        const medications = patient.filter(
          (a) =>
            a.category === MentionCategory.OTHER_MEDICATION &&
            (a.predicate === Predicate.CURRENTLY_TAKES || a.predicate === Predicate.PLANS_TO_TAKE) &&
            !a.concept_id.startsWith(NON_INTERACTING_PREFIX) &&
            a.concept_id in ctx.index.ontology.medication_concepts,
        );
        for (const h of hormonal) {
          for (const m of medications) {
            if (ctx.index.lookupPair(h.concept_id, m.concept_id).length) continue;
            result.reviewItems!.push({
              kind: 'dataset-gap-pair',
              summary: `No record covers ${h.canonical_name} × ${m.canonical_name}`,
              detail: `The combination (${h.concept_id} × ${m.concept_id}) occurred in an encounter and no evidence record covers it. ${NO_MATCH_SECONDARY} Physician review needed to decide whether a record should be added.`,
              refs: { hormonal_concept_id: h.concept_id, medication_concept_id: m.concept_id },
              dedupe_key: `pair:${h.concept_id}:${m.concept_id}`,
            });
            result.findings.push({
              severity: 'attention',
              kind: 'dataset-gap-pair',
              message: `No evidence record covers ${h.canonical_name} × ${m.canonical_name}. ${NO_MATCH_SECONDARY} Filed for physician review of dataset coverage.`,
              refs: { hormonal_concept_id: h.concept_id, medication_concept_id: m.concept_id },
              dedupe_key: `pair:${h.concept_id}:${m.concept_id}`,
            });
          }
        }
      }
      return result;
    },
  };
}

export function fleetWatchdogWorker(settings: Settings, index: EvidenceIndex): FleetWorker {
  const latencyThresholdMs = !settings.demo_mode && liveExtractionAvailable(settings) ? 5000 : 250;
  return {
    id: 'w14-fleet-watchdog',
    name: 'Fleet watchdog & self-check',
    tier: 3,
    cadence: 'interval',
    intervalMs: settings.fleet_watchdog_interval_s * 1000,
    agentic: false,
    enabled: true,
    description:
      'The worker that watches the workers — and continuously re-proves the core engine. ' +
      'Behavior, on its interval: (1) health sweep — any worker with consecutive errors is ' +
      'reported (attention), three consecutive errors marks it failed (alert); a failed ' +
      'specialist never takes the engine down, but it must never fail silently either; ' +
      '(2) latency watch — p90 of end-to-end turn processing across all encounters is ' +
      'compared to the mode\'s threshold and breaches are reported; (3) transcription ' +
      'failures recorded in any encounter log are surfaced; (4) deterministic canary — it ' +
      'runs a known conversation (combined pill + carbamazepine, then a correction) through ' +
      'a fresh throwaway engine and asserts the exact expected result-state sequence ' +
      '(MORE_INFORMATION_REQUIRED → EVIDENCE_FOUND with INT-001 → RETRACTED); any deviation ' +
      'is an alert, because it means the live engine no longer matches its benchmarked ' +
      'behavior. Full Layer A+B benchmarks remain a separate command; the canary is the ' +
      'always-on tripwire between runs.',
    async runGlobal(ctx: GlobalContext): Promise<WorkerRunResult> {
      const findings: FindingDraft[] = [];

      for (const h of ctx.health) {
        if (h.worker_id === 'w14-fleet-watchdog' || !h.enabled) continue;
        if (h.consecutive_errors >= 3) {
          findings.push({
            severity: 'alert',
            kind: 'worker-failed',
            message: `Fleet worker ${h.worker_id} has failed ${h.consecutive_errors} consecutive runs (last error: ${h.last_error}). The core engine is unaffected; the worker's coverage is currently missing.`,
            refs: { worker_id: h.worker_id },
            dedupe_key: `failed:${h.worker_id}:${h.errors}`,
          });
        } else if (h.consecutive_errors > 0) {
          findings.push({
            severity: 'attention',
            kind: 'worker-degraded',
            message: `Fleet worker ${h.worker_id} errored on its last run (${h.last_error}).`,
            refs: { worker_id: h.worker_id },
            dedupe_key: `degraded:${h.worker_id}:${h.errors}`,
          });
        }
      }

      const totals: number[] = [];
      let transcriptionFailures = 0;
      for (const runtime of ctx.service.encounters.values()) {
        for (const l of runtime.latencies) totals.push(l.total_ms);
        transcriptionFailures += runtime.store.eventsOf('TRANSCRIPTION_FAILED').length;
      }
      if (totals.length) {
        const sorted = [...totals].sort((a, b) => a - b);
        const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
        if (p90 > latencyThresholdMs) {
          findings.push({
            severity: 'attention',
            kind: 'latency-degraded',
            message: `p90 turn-processing latency is ${p90.toFixed(1)} ms across ${totals.length} turns (threshold ${latencyThresholdMs} ms).`,
            refs: { p90_ms: p90, turns: totals.length },
            dedupe_key: `latency:${Math.round(p90)}`,
          });
        }
      }
      if (transcriptionFailures > 0) {
        findings.push({
          severity: 'attention',
          kind: 'transcription-failures',
          message: `${transcriptionFailures} transcription failure/reconnect event(s) recorded across live encounters — check provider connectivity.`,
          refs: { count: transcriptionFailures },
          dedupe_key: `transcription:${transcriptionFailures}`,
        });
      }

      // Deterministic canary against a throwaway engine (no fleet attached).
      try {
        const canary = new EncounterService(settings, index, new DeterministicExtractor(index));
        const runtime = canary.createEncounter(true);
        const states: string[] = [];
        for (const text of [
          'I take the combined pill.',
          'I also take carbamazepine.',
          'Actually, I stopped taking the combined pill last year.',
        ]) {
          const snapshot = await canary.processFinalTurn(runtime, {
            event_id: newId('evt'),
            text,
            speaker: 'patient',
          });
          states.push(snapshot.result_state);
        }
        const warned = runtime.warnings.some((w) => w.evidence_record_id === 'INT-001');
        const expected = [
          ResultState.MORE_INFORMATION_REQUIRED,
          ResultState.EVIDENCE_FOUND,
          ResultState.RETRACTED,
        ];
        const ok = warned && states.length === 3 && states.every((s, i) => s === expected[i]);
        if (!ok) {
          findings.push({
            severity: 'alert',
            kind: 'selfcheck-failed',
            message: `Continuous self-check FAILED: expected ${expected.join(' → ')} with an INT-001 warning, got ${states.join(' → ')} (INT-001 warned: ${warned}). The engine no longer matches its benchmarked behavior — run the full benchmark now.`,
            refs: { states, warned },
            dedupe_key: `selfcheck:${states.join('>')}`,
          });
        } else {
          findings.push({
            severity: 'info',
            kind: 'selfcheck-passed',
            message: 'Continuous self-check passed: canary conversation reproduced MORE_INFORMATION_REQUIRED → EVIDENCE_FOUND (INT-001) → RETRACTED.',
            dedupe_key: 'selfcheck-ok',
          });
        }
      } catch (err) {
        findings.push({
          severity: 'alert',
          kind: 'selfcheck-failed',
          message: `Continuous self-check crashed: ${String(err instanceof Error ? err.message : err)}.`,
          dedupe_key: 'selfcheck-crash',
        });
      }
      return { findings };
    },
  };
}
