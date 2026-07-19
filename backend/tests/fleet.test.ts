/**
 * Agent-fleet tests (v0.4.0): roster, parity with the baseline engine,
 * per-worker behavior, error isolation, and the fleet API/WS surface.
 *
 * The load-bearing guarantee: with the fleet attached, every gold-labeled
 * behavior of the baseline engine is unchanged — workers add findings and
 * (rarely) supplementary extractions, never alter benchmarked outcomes.
 */
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { defaultSettings } from '../src/config.ts';
import { DeterministicExtractor } from '../src/deterministicExtractor.ts';
import { EncounterService } from '../src/encounterService.ts';
import { buildFleet } from '../src/fleet/registry.ts';
import { FleetSupervisor } from '../src/fleet/supervisor.ts';
import { activeWarnings } from '../src/models.ts';
import { Backend, createBackend } from '../src/server.ts';
import { index, say, settings } from './helpers.ts';

function makeFleetService(overrides: Partial<typeof settings> = {}): {
  service: EncounterService;
  fleet: FleetSupervisor;
} {
  const s = { ...settings, ...overrides };
  const service = new EncounterService(s, index, new DeterministicExtractor(index));
  const fleet = buildFleet(s, index);
  fleet.attach(service);
  return { service, fleet };
}

function makeBaselineService(): EncounterService {
  return new EncounterService(settings, index, new DeterministicExtractor(index));
}

describe('fleet roster', () => {
  it('registers 17 worker instances with at least 10 running by default', () => {
    const { fleet } = makeFleetService();
    expect(fleet.workers).toHaveLength(17);
    const enabled = fleet.workers.filter((w) => w.enabled);
    expect(enabled.length).toBeGreaterThanOrEqual(10);
  });

  it('ships the washout sentinel disabled pending physician sign-off', () => {
    const { fleet } = makeFleetService();
    const washout = fleet.workers.find((w) => w.id === 'w08-washout-window')!;
    expect(washout.enabled).toBe(false);
    expect(washout.disabledReason).toContain('physician');
    // The pending proposal is visible in the review queue, not hidden.
    expect(fleet.reviewQueueItems().some((i) => i.kind === 'disabled-worker')).toBe(true);
  });

  it('keeps the source-link monitor network-silent by default', () => {
    const { fleet } = makeFleetService();
    const monitor = fleet.workers.find((w) => w.id === 'w12-source-link-monitor')!;
    expect(monitor.enabled).toBe(false);
    expect(monitor.disabledReason).toContain('FLEET_LINK_CHECK');
  });

  it('publishes a status payload with per-worker descriptions and health', () => {
    const { fleet } = makeFleetService();
    const status = fleet.statusPayload() as { workers: Array<Record<string, unknown>> };
    expect(status.workers).toHaveLength(17);
    for (const w of status.workers) {
      expect(String(w.description).length).toBeGreaterThan(80);
      expect(['idle', 'healthy', 'degraded', 'failed', 'disabled']).toContain(w.status);
    }
  });
});

describe('fleet parity with the baseline engine', () => {
  const SCRIPT = [
    'I have been using the combined pill for two years.',
    'I also take carbamazepine for my epilepsy.',
    'Actually, I stopped taking carbamazepine last month.',
  ];

  it('does not change result states, warnings, or assertions on a gold-style sequence', async () => {
    const baseline = makeBaselineService();
    const { service } = makeFleetService();
    const rtA = baseline.createEncounter();
    const rtB = service.createEncounter();
    const statesA: string[] = [];
    const statesB: string[] = [];
    for (const text of SCRIPT) {
      statesA.push((await say(baseline, rtA, text)).result_state);
      statesB.push((await say(service, rtB, text)).result_state);
    }
    expect(statesB).toEqual(statesA);
    expect(activeWarnings(rtB.snapshot).map((w) => w.evidence_record_id)).toEqual(
      activeWarnings(rtA.snapshot).map((w) => w.evidence_record_id),
    );
    expect(rtB.snapshot.assertions.map((a) => `${a.concept_id}:${a.status}:${a.is_active}`).sort()).toEqual(
      rtA.snapshot.assertions.map((a) => `${a.concept_id}:${a.status}:${a.is_active}`).sort(),
    );
    expect(rtB.warnings.filter((w) => w.state === 'retracted')[0]?.retraction_reason).toEqual(
      rtA.warnings.filter((w) => w.state === 'retracted')[0]?.retraction_reason,
    );
  });

  it('remains parity-safe with the washout sentinel enabled (advisory only)', async () => {
    const baseline = makeBaselineService();
    const { service, fleet } = makeFleetService({ fleet_washout_sentinel: true });
    const rtA = baseline.createEncounter();
    const rtB = service.createEncounter();
    const script = ['I use the combined pill.', 'I stopped taking carbamazepine last month.'];
    const statesA: string[] = [];
    const statesB: string[] = [];
    for (const text of script) {
      statesA.push((await say(baseline, rtA, text)).result_state);
      statesB.push((await say(service, rtB, text)).result_state);
    }
    expect(statesB).toEqual(statesA);
    expect(activeWarnings(rtB.snapshot)).toEqual([]);
    const washout = fleet
      .recentFindings(rtB.encounter_id)
      .find((f) => f.kind === 'washout-window');
    expect(washout).toBeDefined();
    expect(washout!.message).toContain('28 days');
    expect(washout!.message).toContain('physician');
  });
});

describe('tier 1 — transcript workers', () => {
  it('w02 recovers a mention split across two turns and proposes it to the graph', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, "I'm on the combined", { sequence: 1 });
    const snap = await say(service, rt, 'pill, and nothing else.', { sequence: 2 });
    const hormonal = snap.assertions.find(
      (a) => a.concept_id === 'combined_hormonal_contraceptive' && a.is_active,
    );
    expect(hormonal).toBeDefined();
    expect(snap.result_state).toBe('MORE_INFORMATION_REQUIRED');
    const finding = fleet.recentFindings(rt.encounter_id).find((f) => f.kind === 'split-mention');
    expect(finding).toBeDefined();
    expect(fleet.statusPayload()).toMatchObject({});
  });

  it('w03 surfaces resolved contradictions and repeated flip-flops', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'I take the combined pill.');
    await say(service, rt, "Actually, I don't take the combined pill.");
    await say(service, rt, 'I am taking the combined pill again.');
    const findings = fleet.recentFindings(rt.encounter_id);
    expect(findings.some((f) => f.kind === 'resolved-contradiction')).toBe(true);
    expect(findings.some((f) => f.kind === 'repeated-flip-flop')).toBe(true);
  });

  it('w04 logs other-person attribution as excluded', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'My sister takes carbamazepine for her epilepsy.');
    const finding = fleet
      .recentFindings(rt.encounter_id)
      .find((f) => f.kind === 'other-person-mention');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('info');
  });

  it('w05 flags ambiguous aliases with the approved clarification question', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    const snap = await say(service, rt, "I'm on the pill.");
    expect(snap.result_state).toBe('MORE_INFORMATION_REQUIRED');
    const finding = fleet.recentFindings(rt.encounter_id).find((f) => f.kind === 'ambiguous-alias');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('abstains');
  });
});

describe('tier 2 — danger-condition specialists', () => {
  it('w06 escalates an active INT-005 warning to an alert finding', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill.');
    const snap = await say(service, rt, 'I take lamotrigine every day.');
    expect(activeWarnings(snap).some((w) => w.evidence_record_id === 'INT-005')).toBe(true);
    const finding = fleet.recentFindings(rt.encounter_id).find((f) => f.kind === 'seizure-risk-active');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('alert');
  });

  it('w06 raises a near-miss when the pair is present but statuses do not trigger', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'I used to take lamotrigine years ago.');
    const snap = await say(service, rt, 'I use the combined pill.');
    expect(activeWarnings(snap)).toEqual([]);
    const finding = fleet
      .recentFindings(rt.encounter_id)
      .find((f) => f.kind === 'seizure-risk-nearmiss');
    expect(finding).toBeDefined();
  });

  it('w07 escalates the potent-inducer warning', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill.');
    const snap = await say(service, rt, 'I take rifampicin for tuberculosis.');
    expect(activeWarnings(snap).some((w) => w.evidence_record_id === 'INT-002')).toBe(true);
    const finding = fleet
      .recentFindings(rt.encounter_id)
      .find((f) => f.kind === 'potent-inducer-active');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('alert');
  });

  it('w09 asks for names when supplements are mentioned without one', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'I also take some herbal supplements every day.');
    const finding = fleet
      .recentFindings(rt.encounter_id)
      .find((f) => f.kind === 'unnamed-supplement');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('INT-006');
  });

  it('w10 watcher reports product status and outstanding sign-off', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill.');
    const findings = fleet.recentFindings(rt.encounter_id);
    expect(findings.some((f) => f.kind === 'product-status')).toBe(true);
    const signoff = findings.find((f) => f.kind === 'sign-off-pending');
    expect(signoff).toBeDefined();
    expect(signoff!.message).toContain('physician sign-off');
  });
});

describe('tier 3 — integrity & maintenance', () => {
  it('w11 finds no invariant violations on a healthy encounter', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill.');
    await say(service, rt, 'I also take carbamazepine.');
    const findings = fleet.recentFindings(rt.encounter_id);
    expect(findings.some((f) => f.kind === 'invariant-violation')).toBe(false);
    expect(findings.some((f) => f.kind === 'nondeterministic-rebuild')).toBe(false);
  });

  it('w13 files an uncovered pair for physician review (combined pill × phenobarbital)', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill.');
    const snap = await say(service, rt, 'I also take phenobarbital.');
    expect(snap.result_state).toBe('NO_VALIDATED_MATCH');
    const item = fleet.reviewQueueItems().find((i) => i.kind === 'dataset-gap-pair');
    expect(item).toBeDefined();
    expect(item!.detail).toContain('does not establish that no interaction exists');
    expect(item!.refs).toMatchObject({ medication_concept_id: 'phenobarbital' });
  });

  it('w14 runs the deterministic canary and reports selfcheck-passed', async () => {
    const { fleet } = makeFleetService();
    await fleet.runIntervalWorkersOnce();
    const findings = fleet.recentFindings();
    expect(findings.some((f) => f.kind === 'selfcheck-passed')).toBe(true);
    expect(findings.some((f) => f.kind === 'selfcheck-failed')).toBe(false);
  });
});

describe('fleet resilience', () => {
  it('isolates a crashing worker: engine keeps working, watchdog reports it', async () => {
    const { service, fleet } = makeFleetService();
    fleet.register({
      id: 'wx-test-bomb',
      name: 'Test bomb',
      tier: 3,
      cadence: 'turn',
      agentic: false,
      enabled: true,
      description: 'Test-only worker that always throws, to prove failure isolation.',
      runEncounter: async () => {
        throw new Error('boom');
      },
    });
    const rt = service.createEncounter();
    const snap = await say(service, rt, 'I use the combined pill.');
    expect(snap.turns).toHaveLength(1);
    expect(snap.result_state).toBe('MORE_INFORMATION_REQUIRED');
    const health = fleet.healthView().find((h) => h.worker_id === 'wx-test-bomb')!;
    expect(health.errors).toBe(1);
    expect(health.status).toBe('degraded');
    await fleet.runIntervalWorkersOnce();
    expect(fleet.recentFindings().some((f) => f.kind === 'worker-degraded')).toBe(true);
  });

  it('heartbeats: turn workers record runs on every finalized turn', async () => {
    const { service, fleet } = makeFleetService();
    const rt = service.createEncounter();
    await say(service, rt, 'Hello doctor.');
    for (const id of ['w01-detail-extractor', 'w02-big-picture', 'w04-subject-auditor']) {
      const health = fleet.healthView().find((h) => h.worker_id === id)!;
      expect(health.runs).toBeGreaterThan(0);
      expect(health.status).toBe('healthy');
    }
  });
});

describe('fleet API and WebSocket surface', () => {
  let backend: Backend;
  let baseUrl: string;
  let wsBase: string;

  beforeAll(async () => {
    backend = createBackend(defaultSettings());
    await new Promise<void>((resolve) => backend.server.listen(0, resolve));
    const port = (backend.server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    backend.fleet?.stop();
    await new Promise<void>((resolve) => backend.server.close(() => resolve()));
  });

  it('exposes status, findings, and the review queue over REST', async () => {
    const status = (await fetch(`${baseUrl}/api/fleet/status`).then((r) => r.json())) as any;
    expect(status.total_workers).toBe(17);
    expect(status.running_workers).toBeGreaterThanOrEqual(10);
    const findings = (await fetch(`${baseUrl}/api/fleet/findings`).then((r) => r.json())) as any;
    expect(Array.isArray(findings.findings)).toBe(true);
    const queue = (await fetch(`${baseUrl}/api/fleet/review-queue`).then((r) => r.json())) as any;
    expect(Array.isArray(queue.items)).toBe(true);
  });

  it('broadcasts fleet.finding and fleet.status over the encounter WebSocket', async () => {
    const created = (await fetch(`${baseUrl}/api/encounters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ synthetic_demo: true }),
    }).then((r) => r.json())) as any;
    const encounterId = created.encounter_id;

    const ws = new WebSocket(`${wsBase}/ws/encounters/${encounterId}`);
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const response = await fetch(`${baseUrl}/api/encounters/${encounterId}/text-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: "I'm on the pill.", speaker: 'patient' }),
    });
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));
    ws.close();
    const types = messages.map((m) => m.type);
    expect(types).toContain('fleet.status');
    expect(types).toContain('fleet.finding');
    const finding = messages.find((m) => m.type === 'fleet.finding');
    expect(finding.finding.kind).toBe('ambiguous-alias');
  });
});
