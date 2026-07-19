/**
 * Fleet supervisor: runs every registered worker on its cadence, isolates
 * failures, tracks health/heartbeats, keeps the fleet log (findings) and the
 * physician review queue, and publishes fleet events over the encounter
 * WebSocket.
 *
 * Ordering guarantee: encounter-scoped worker runs happen inside the same
 * per-encounter mutex as turn processing, so the fleet sees a consistent
 * snapshot and worker proposals can never interleave with a concurrent turn.
 */
import { Settings } from '../config.ts';
import { EncounterRuntime, EncounterService } from '../encounterService.ts';
import { EvidenceIndex } from '../evidenceIndex.ts';
import { ResultState, TranscriptTurn, newId, utcnow } from '../models.ts';
import {
  FindingDraft,
  FleetFinding,
  FleetWorker,
  GlobalContext,
  ReviewItem,
  WorkerContext,
  WorkerHealthView,
  WorkerProposal,
  WorkerRunResult,
  WorkerStatus,
} from './core.ts';

const FINDINGS_CAP = 400;
const REVIEW_QUEUE_CAP = 100;
const FAILED_AFTER_CONSECUTIVE_ERRORS = 3;

interface WorkerHealth {
  status: WorkerStatus;
  runs: number;
  errors: number;
  consecutive_errors: number;
  findings: number;
  proposals_applied: number;
  last_run_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
}

export class FleetSupervisor {
  workers: FleetWorker[] = [];
  private health = new Map<string, WorkerHealth>();
  private findings: FleetFinding[] = [];
  private findingKeys = new Set<string>();
  private reviewQueue: ReviewItem[] = [];
  private reviewKeys = new Set<string>();
  private service: EncounterService | null = null;
  private timers: NodeJS.Timeout[] = [];
  readonly started_at = utcnow();

  constructor(
    private settings: Settings,
    private index: EvidenceIndex,
  ) {}

  register(worker: FleetWorker): void {
    this.workers.push(worker);
    this.health.set(worker.id, {
      status: worker.enabled ? 'idle' : 'disabled',
      runs: 0,
      errors: 0,
      consecutive_errors: 0,
      findings: 0,
      proposals_applied: 0,
      last_run_at: null,
      last_duration_ms: null,
      last_error: null,
    });
    if (!worker.enabled && worker.disabledReason) {
      this.pushReviewItem(worker.id, {
        kind: 'disabled-worker',
        summary: `${worker.name} is registered but disabled`,
        detail: worker.disabledReason,
        dedupe_key: `disabled:${worker.id}`,
      });
    }
  }

  attach(service: EncounterService): void {
    this.service = service;
    service.fleet = this;
  }

  /** Start interval timers. unref() so tests and CLIs exit normally. */
  start(): void {
    for (const worker of this.workers) {
      if (worker.cadence !== 'interval' || !worker.enabled || !worker.runGlobal) continue;
      const timer = setInterval(() => {
        void this.runOneGlobal(worker);
      }, worker.intervalMs ?? 60_000);
      timer.unref?.();
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // -- cadence entry points (called by EncounterService, lock held) ---------

  async afterTurn(runtime: EncounterRuntime, turn: TranscriptTurn): Promise<void> {
    const proposals = await this.runEncounterWorkers(runtime, turn, 'turn');
    await this.applyProposals(runtime, proposals);
    await this.runEncounterWorkers(runtime, turn, 'commit');
    this.broadcastStatus(runtime);
  }

  async afterCommit(runtime: EncounterRuntime, latestTurn: TranscriptTurn | null): Promise<void> {
    await this.runEncounterWorkers(runtime, latestTurn, 'commit');
    this.broadcastStatus(runtime);
  }

  /** Run all interval (global) workers immediately; also used by tests/API. */
  async runIntervalWorkersOnce(): Promise<void> {
    for (const worker of this.workers) {
      if (worker.cadence === 'interval' && worker.enabled && worker.runGlobal) {
        await this.runOneGlobal(worker);
      }
    }
  }

  clearEncounter(encounterId: string): void {
    this.findings = this.findings.filter((f) => f.encounter_id !== encounterId);
    this.findingKeys = new Set(
      this.findings.map((f) => `${f.worker_id}|${f.encounter_id}|${f.kind}|${f.message}`),
    );
  }

  // -- internals ------------------------------------------------------------

  private buildContext(runtime: EncounterRuntime, latestTurn: TranscriptTurn | null): WorkerContext {
    const service = this.service as EncounterService;
    return {
      runtime,
      snapshot: runtime.snapshot,
      events: runtime.store.events,
      latestTurn,
      index: this.index,
      settings: this.settings,
      normalizer: service.normalizer,
      fallbackExtractor: service.fallbackExtractor,
    };
  }

  private async runEncounterWorkers(
    runtime: EncounterRuntime,
    latestTurn: TranscriptTurn | null,
    cadence: 'turn' | 'commit',
  ): Promise<WorkerProposal[]> {
    if (!this.service) return [];
    const proposals: WorkerProposal[] = [];
    for (const worker of this.workers) {
      if (worker.cadence !== cadence || !worker.enabled || !worker.runEncounter) continue;
      if (cadence === 'turn' && latestTurn === null) continue;
      const result = await this.runIsolated(worker, () =>
        worker.runEncounter!(this.buildContext(runtime, latestTurn)),
      );
      if (!result) continue;
      this.collect(worker, runtime.encounter_id, result, runtime);
      proposals.push(...(result.proposals ?? []));
    }
    return proposals;
  }

  private async runOneGlobal(worker: FleetWorker): Promise<void> {
    if (!this.service) return;
    const ctx: GlobalContext = {
      service: this.service,
      index: this.index,
      settings: this.settings,
      health: this.healthView(),
    };
    const result = await this.runIsolated(worker, () => worker.runGlobal!(ctx));
    if (result) this.collect(worker, null, result, null);
  }

  /** A throwing worker degrades itself; the engine and other workers continue. */
  private async runIsolated(
    worker: FleetWorker,
    fn: () => Promise<WorkerRunResult>,
  ): Promise<WorkerRunResult | null> {
    const health = this.health.get(worker.id)!;
    const t0 = performance.now();
    try {
      const result = await fn();
      health.runs += 1;
      health.consecutive_errors = 0;
      health.status = 'healthy';
      health.last_run_at = utcnow();
      health.last_duration_ms = Math.round((performance.now() - t0) * 100) / 100;
      return result;
    } catch (err) {
      health.runs += 1;
      health.errors += 1;
      health.consecutive_errors += 1;
      health.last_error = String(err instanceof Error ? err.message : err);
      health.last_run_at = utcnow();
      health.status =
        health.consecutive_errors >= FAILED_AFTER_CONSECUTIVE_ERRORS ? 'failed' : 'degraded';
      console.error(`fleet worker ${worker.id} failed:`, err);
      return null;
    }
  }

  private collect(
    worker: FleetWorker,
    encounterId: string | null,
    result: WorkerRunResult,
    runtime: EncounterRuntime | null,
  ): void {
    for (const draft of result.findings) {
      const finding = this.pushFinding(worker, encounterId, draft);
      if (finding && runtime && this.service) {
        this.service.broadcast(runtime, { type: 'fleet.finding', finding });
      }
    }
    for (const item of result.reviewItems ?? []) {
      this.pushReviewItem(worker.id, item);
    }
  }

  private pushFinding(
    worker: FleetWorker,
    encounterId: string | null,
    draft: FindingDraft,
  ): FleetFinding | null {
    const key = `${worker.id}|${encounterId}|${draft.dedupe_key ?? draft.kind}|${draft.message}`;
    if (this.findingKeys.has(key)) return null;
    this.findingKeys.add(key);
    const finding: FleetFinding = {
      finding_id: newId('find'),
      worker_id: worker.id,
      worker_name: worker.name,
      encounter_id: encounterId,
      severity: draft.severity,
      kind: draft.kind,
      message: draft.message,
      refs: draft.refs ?? {},
      created_at: utcnow(),
    };
    this.findings.push(finding);
    this.health.get(worker.id)!.findings += 1;
    if (this.findings.length > FINDINGS_CAP) {
      const dropped = this.findings.splice(0, this.findings.length - FINDINGS_CAP);
      for (const f of dropped) {
        this.findingKeys.delete(`${f.worker_id}|${f.encounter_id}|${f.kind}|${f.message}`);
      }
    }
    return finding;
  }

  private pushReviewItem(workerId: string, draft: { kind: string; summary: string; detail: string; refs?: Record<string, unknown>; dedupe_key: string }): void {
    if (this.reviewKeys.has(draft.dedupe_key)) return;
    this.reviewKeys.add(draft.dedupe_key);
    this.reviewQueue.push({
      item_id: newId('rev'),
      worker_id: workerId,
      created_at: utcnow(),
      ...draft,
      refs: draft.refs ?? {},
    });
    if (this.reviewQueue.length > REVIEW_QUEUE_CAP) this.reviewQueue.shift();
  }

  /**
   * Merge worker proposals into their turn's MENTIONS_EXTRACTED event and
   * recompute. Union semantics: existing mentions/corrections are preserved,
   * new ones appended. The reducer then re-derives the graph from the merged
   * input, applying its ordinary supersession and contradiction rules.
   */
  private async applyProposals(runtime: EncounterRuntime, proposals: WorkerProposal[]): Promise<void> {
    if (!this.service || !proposals.length) return;
    if (runtime.snapshot.result_state === ResultState.PROCESSING_ERROR) return;
    for (const proposal of proposals) {
      if (!proposal.normalized_mentions.length && !proposal.corrections.length) continue;
      const applied = await this.service.applyFleetExtraction(runtime, proposal);
      if (applied) {
        for (const worker of this.workers) {
          if (proposal.note.startsWith(worker.id)) {
            this.health.get(worker.id)!.proposals_applied += 1;
          }
        }
      }
    }
  }

  // -- publication ----------------------------------------------------------

  healthView(): WorkerHealthView[] {
    return this.workers.map((w) => {
      const h = this.health.get(w.id)!;
      return {
        worker_id: w.id,
        status: w.enabled ? h.status : 'disabled',
        cadence: w.cadence,
        enabled: w.enabled,
        runs: h.runs,
        errors: h.errors,
        consecutive_errors: h.consecutive_errors,
        last_run_at: h.last_run_at,
        last_error: h.last_error,
      };
    });
  }

  statusPayload(): Record<string, unknown> {
    const workers = this.workers.map((w) => {
      const h = this.health.get(w.id)!;
      return {
        id: w.id,
        name: w.name,
        tier: w.tier,
        cadence: w.cadence,
        interval_ms: w.intervalMs ?? null,
        agentic: w.agentic,
        enabled: w.enabled,
        disabled_reason: w.disabledReason ?? null,
        description: w.description,
        status: w.enabled ? h.status : 'disabled',
        runs: h.runs,
        errors: h.errors,
        findings: h.findings,
        proposals_applied: h.proposals_applied,
        last_run_at: h.last_run_at,
        last_duration_ms: h.last_duration_ms,
        last_error: h.last_error,
      };
    });
    const enabled = workers.filter((w) => w.enabled);
    return {
      fleet_enabled: true,
      started_at: this.started_at,
      total_workers: workers.length,
      running_workers: enabled.length,
      healthy_workers: enabled.filter((w) => w.status === 'healthy' || w.status === 'idle').length,
      findings_total: this.findings.length,
      review_queue_size: this.reviewQueue.length,
      workers,
    };
  }

  recentFindings(encounterId?: string, limit = 50): FleetFinding[] {
    const source = encounterId
      ? this.findings.filter((f) => f.encounter_id === encounterId || f.encounter_id === null)
      : this.findings;
    return source.slice(-limit).reverse();
  }

  reviewQueueItems(): ReviewItem[] {
    return [...this.reviewQueue].reverse();
  }

  private broadcastStatus(runtime: EncounterRuntime): void {
    if (!this.service) return;
    const payload = this.statusPayload();
    this.service.broadcast(runtime, {
      type: 'fleet.status',
      total_workers: payload.total_workers,
      running_workers: payload.running_workers,
      healthy_workers: payload.healthy_workers,
      findings_total: payload.findings_total,
      review_queue_size: payload.review_queue_size,
      recent_findings: this.recentFindings(runtime.encounter_id, 8),
    });
  }
}
