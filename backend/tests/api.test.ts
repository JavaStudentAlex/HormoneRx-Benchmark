/**
 * API tests (spec §27): REST + WebSocket contract, snapshot on reconnect,
 * duplicate handling, audit export. Runs against a real listening server.
 */
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { defaultSettings } from '../src/config.ts';
import { Backend, createBackend } from '../src/server.ts';

let backend: Backend;
let baseUrl: string;
let wsBase: string;

beforeAll(async () => {
  // Fleet disabled here: this suite pins the BASELINE wire contract (exact
  // message sequences). Fleet API/WS behavior is covered in fleet.test.ts.
  backend = createBackend(defaultSettings({ fleet_enabled: false }));
  await new Promise<void>((resolve) => backend.server.listen(0, resolve));
  const port = (backend.server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => backend.server.close(() => resolve()));
});

async function post(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const response = await fetch(baseUrl + path);
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function createEncounter(): Promise<string> {
  const response = await post('/api/encounters', { synthetic_demo: true });
  expect(response.status).toBe(200);
  return response.json.encounter_id;
}

/** WebSocket wrapper with an awaitable message queue. */
class WsClient {
  private queue: any[] = [];
  private waiters: Array<(msg: any) => void> = [];

  constructor(public ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  next(timeoutMs = 5000): Promise<any> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws message timeout')), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    this.ws.close();
  }
}

async function openWs(path: string): Promise<WsClient> {
  const ws = new WebSocket(wsBase + path);
  // Attach the message listener BEFORE awaiting open: the server sends the
  // snapshot immediately and the first frame can be emitted in the same tick
  // as the open event.
  const client = new WsClient(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return client;
}

describe('REST API', () => {
  it('reports health with evidence eligibility', async () => {
    const response = await get('/api/health');
    expect(response.status).toBe(200);
    expect(response.json.status).toBe('ok');
    expect(response.json).toHaveProperty('evidence');
    expect(response.json.evidence.recordCount).toBe(6);
  });

  it('lists evidence records with eligibility', async () => {
    const { json } = await get('/api/evidence');
    expect(json.records).toHaveLength(6);
    expect(json.eligibility).toHaveProperty('pendingPhysicianSignOff');
  });

  it('returns 503 for realtime session without a key', async () => {
    const response = await post('/api/realtime/session');
    expect(response.status).toBe(503);
  });

  it('processes a text turn end to end', async () => {
    const enc = await createEncounter();
    const response = await post(`/api/encounters/${enc}/text-turn`, {
      speaker: 'patient',
      text: 'I take carbamazepine and use the combined pill.',
    });
    expect(response.status).toBe(200);
    expect(response.json.result.state).toBe('EVIDENCE_FOUND');
    expect(response.json.result.active_warnings[0].evidence_record_id).toBe('INT-001');
    // Medical wording is served verbatim from the record.
    expect(response.json.result.active_warnings[0].evidence_record.id).toBe('INT-001');
  });

  it('returns 409 for a duplicate text turn', async () => {
    const enc = await createEncounter();
    const payload = { event_id: 'evt-1', speaker: 'patient', text: 'I take carbamazepine.' };
    expect((await post(`/api/encounters/${enc}/text-turn`, payload)).status).toBe(200);
    expect((await post(`/api/encounters/${enc}/text-turn`, payload)).status).toBe(409);
  });

  it('rejects empty turns with 422', async () => {
    const enc = await createEncounter();
    const response = await post(`/api/encounters/${enc}/text-turn`, { speaker: 'patient', text: '   ' });
    expect(response.status).toBe(422);
  });

  it('returns 404 for unknown encounters', async () => {
    expect((await get('/api/encounters/enc-nope/snapshot')).status).toBe(404);
  });

  it('handles the proposal lifecycle', async () => {
    const enc = await createEncounter();
    await post(`/api/encounters/${enc}/text-turn`, { speaker: 'patient', text: 'I use the combined pill.' });
    let { json } = await post(`/api/encounters/${enc}/proposals`, {
      medication_surface_text: 'Lamotrigine',
    });
    expect(json.result.state).toBe('EVIDENCE_FOUND');
    const proposalId = json.proposals[0].proposal_id;
    ({ json } = await post(`/api/encounters/${enc}/proposals/cancel`, { proposal_id: proposalId }));
    expect(['RETRACTED', 'MORE_INFORMATION_REQUIRED']).toContain(json.result.state);
    expect(json.result.active_warnings).toEqual([]);
  });

  it('exports a complete audit', async () => {
    const enc = await createEncounter();
    await post(`/api/encounters/${enc}/text-turn`, {
      speaker: 'patient',
      text: 'I take Tegretol and use the combined pill.',
    });
    await post(`/api/encounters/${enc}/text-turn`, {
      speaker: 'patient',
      text: 'Sorry, I stopped Tegretol last year.',
    });
    const { json: audit } = await get(`/api/encounters/${enc}/audit`);
    expect(audit.final_transcript_turns.length).toBeGreaterThan(0);
    expect(audit.extracted_mentions.length).toBeGreaterThan(0);
    expect(audit.graph_assertions.length).toBeGreaterThan(0);
    expect(audit.warning_lifecycle.length).toBeGreaterThan(0);
    const retracted = audit.warning_lifecycle.filter((w: any) => w.state === 'retracted');
    expect(retracted.length).toBeGreaterThan(0);
    expect(retracted[0].retraction_reason).toBeTruthy();
    expect(audit.latency_measurements.length).toBeGreaterThan(0);
    expect(audit.event_log.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain('raw_audio');
  });

  it('lists the demo scripts', async () => {
    const { json } = await get('/api/demo-scripts');
    const ids = json.scripts.map((s: any) => s.id);
    expect(ids).toContain('demo-1-incremental-positive');
    expect(ids).toHaveLength(5);
  });
});

describe('encounter WebSocket', () => {
  it('sends the snapshot, processes final turns, deduplicates', async () => {
    const enc = await createEncounter();
    const client = await openWs(`/ws/encounters/${enc}`);
    try {
      const snapshot = await client.next();
      expect(snapshot.type).toBe('encounter.snapshot');
      client.send({
        type: 'transcript.final',
        event_id: 'evt-ws-1',
        sequence: 1,
        speaker: 'patient',
        text: 'I take Tegretol and use the combined pill.',
      });
      const types: string[] = [];
      const recordIds: string[] = [];
      let finalResult: any = null;
      for (let i = 0; i < 10; i++) {
        const msg = await client.next();
        types.push(msg.type);
        if (msg.type === 'warning.created') {
          recordIds.push(msg.warning.evidence_record_id);
        }
        if (msg.type === 'result.updated') {
          finalResult = msg;
          break;
        }
      }
      expect(types).toContain('graph.updated');
      expect(types).toContain('warning.created');
      expect(recordIds).toEqual(['INT-001']);
      expect(finalResult.result.state).toBe('EVIDENCE_FOUND');
      expect(finalResult.result.latency_ms.total_ms).toBeGreaterThan(0);

      // Duplicate final event over WS is acknowledged, not reprocessed.
      client.send({
        type: 'transcript.final',
        event_id: 'evt-ws-1',
        sequence: 1,
        speaker: 'patient',
        text: 'I take Tegretol and use the combined pill.',
      });
      const dup = await client.next();
      expect(dup.type).toBe('event.duplicate');
    } finally {
      client.close();
    }

    // Reconnect: snapshot reflects current state.
    const client2 = await openWs(`/ws/encounters/${enc}`);
    try {
      const snapshot = await client2.next();
      expect(snapshot.result.state).toBe('EVIDENCE_FOUND');
      expect(snapshot.turns).toHaveLength(1);
    } finally {
      client2.close();
    }
  });

  it('updates only captions from partials', async () => {
    const enc = await createEncounter();
    const client = await openWs(`/ws/encounters/${enc}`);
    try {
      await client.next(); // snapshot
      client.send({ type: 'transcript.partial', speaker: 'patient', text: 'I take carbam' });
      const msg = await client.next();
      expect(msg.type).toBe('caption.updated');
      expect(msg.provisional).toBe(true);
    } finally {
      client.close();
    }
    const { json: snapshot } = await get(`/api/encounters/${enc}/snapshot`);
    expect(snapshot.turns).toEqual([]);
    expect(snapshot.result.state).toBe('LISTENING');
  });
});
