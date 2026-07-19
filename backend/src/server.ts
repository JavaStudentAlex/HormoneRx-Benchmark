/**
 * HTTP + WebSocket application: session control, encounter WebSocket, text
 * fallback, demo-script replay, audit export, and realtime credentials
 * (spec §19, §21). Express + ws port of the former FastAPI app — identical
 * routes and identical JSON wire format, so the React frontend is unchanged.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import express, { type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';

import { buildAuditExport } from './audit.ts';
import { BACKEND_DIR, Settings, getSettings, liveExtractionAvailable } from './config.ts';
import { EXTRACTOR_VERSION } from './deterministicExtractor.ts';
import { DuplicateEventError, EncounterRuntime, EncounterService } from './encounterService.ts';
import { EvidenceIndex, EvidenceValidationError } from './evidenceIndex.ts';
import { LiveExtractor, buildExtractor } from './extractor.ts';
import { buildFleet } from './fleet/registry.ts';
import { FleetSupervisor } from './fleet/supervisor.ts';
import { EventType, SPEAKER_VALUES, Speaker, newId } from './models.ts';
import { RealtimeSessionError, RelaySupervisor, mintClientSecret } from './realtimeSession.ts';

interface DemoScript {
  id: string;
  turns: Array<{ text: string; speaker: string; pause_ms?: number }>;
  [key: string]: unknown;
}

export interface Backend {
  app: express.Express;
  server: http.Server;
  service: EncounterService;
  settings: Settings;
  index: EvidenceIndex;
  fleet: FleetSupervisor | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSpeaker(value: unknown, fallback: Speaker = Speaker.PATIENT): Speaker {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && SPEAKER_VALUES.includes(value)) return value as Speaker;
  throw new RangeError(`invalid speaker ${JSON.stringify(value)}`);
}

/**
 * Absent means "let the service attribute the speaker" — unlike parseSpeaker,
 * which conflates absent with an explicit fallback label.
 */
function parseOptionalSpeaker(value: unknown): Speaker | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && SPEAKER_VALUES.includes(value)) return value as Speaker;
  throw new RangeError(`invalid speaker ${JSON.stringify(value)}`);
}

export function createBackend(settings: Settings = getSettings()): Backend {
  let index: EvidenceIndex;
  try {
    index = new EvidenceIndex(settings.evidence_path, settings.synonym_path, {
      strict: settings.strict_evidence_validation,
      allowPendingVerification: settings.evidence_allow_pending_verification,
    });
  } catch (err) {
    if (err instanceof EvidenceValidationError) {
      // Strict mode: fail startup listing schema errors (spec §36).
      throw new Error(`Evidence validation failed in strict mode:\n- ${err.errors.join('\n- ')}`);
    }
    throw err;
  }

  const extractor = buildExtractor(settings, index);
  const service = new EncounterService(settings, index, extractor);

  // Agent fleet: always-running workers over the event log (docs/FLEET.md).
  let fleet: FleetSupervisor | null = null;
  if (settings.fleet_enabled) {
    fleet = buildFleet(settings, index);
    fleet.attach(service);
    fleet.start();
  }

  const demoScripts = JSON.parse(
    readFileSync(path.join(BACKEND_DIR, 'data', 'demo_scripts.json'), 'utf8'),
  ) as { scripts: DemoScript[] };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173') {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  const getRuntime = (req: Request, res: Response): EncounterRuntime | null => {
    const runtime = service.encounters.get(String(req.params.encounterId)) ?? null;
    if (!runtime) {
      res.status(404).json({ detail: 'unknown encounter' });
    }
    return runtime;
  };

  const handleError = (res: Response, err: unknown): void => {
    if (err instanceof DuplicateEventError) {
      res.status(409).json({ detail: err.message });
    } else if (err instanceof RangeError) {
      res.status(422).json({ detail: err.message });
    } else {
      console.error(err);
      res.status(500).json({ detail: 'internal error' });
    }
  };

  // -- health and metadata -------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      app_env: settings.app_env,
      demo_mode: settings.demo_mode,
      live_extraction_available: liveExtractionAvailable(settings),
      live_transcription_available: Boolean(settings.openai_api_key),
      extraction_model:
        liveExtractionAvailable(settings) && !settings.demo_mode
          ? settings.extraction_model
          : EXTRACTOR_VERSION,
      transcription_model: settings.transcription_model,
      evidence: index.eligibilitySummary(),
    });
  });

  app.get('/api/evidence', (_req, res) => {
    res.json({
      datasetVersion: index.dataset_version,
      records: Object.values(index.records),
      eligibility: index.eligibilitySummary(),
    });
  });

  app.get('/api/demo-scripts', (_req, res) => {
    res.json(demoScripts);
  });

  // -- agent fleet (docs/FLEET.md) -----------------------------------------

  app.get('/api/fleet/status', (_req, res) => {
    if (!fleet) {
      res.status(503).json({ detail: 'fleet disabled (FLEET_ENABLED=false)' });
      return;
    }
    res.json(fleet.statusPayload());
  });

  app.get('/api/fleet/findings', (req, res) => {
    if (!fleet) {
      res.status(503).json({ detail: 'fleet disabled (FLEET_ENABLED=false)' });
      return;
    }
    const encounterId = req.query.encounter_id ? String(req.query.encounter_id) : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json({ findings: fleet.recentFindings(encounterId, limit) });
  });

  app.get('/api/fleet/review-queue', (_req, res) => {
    if (!fleet) {
      res.status(503).json({ detail: 'fleet disabled (FLEET_ENABLED=false)' });
      return;
    }
    res.json({ items: fleet.reviewQueueItems() });
  });

  /** Run all interval workers immediately (watchdog self-check, link monitor). */
  app.post('/api/fleet/run', (_req, res) => {
    if (!fleet) {
      res.status(503).json({ detail: 'fleet disabled (FLEET_ENABLED=false)' });
      return;
    }
    fleet
      .runIntervalWorkersOnce()
      .then(() => res.json(fleet!.statusPayload()))
      .catch((err) => handleError(res, err));
  });

  // -- realtime credentials (spec §21.1) -----------------------------------

  app.post('/api/realtime/session', (_req, res) => {
    mintClientSecret(settings)
      .then((payload) => res.json(payload))
      .catch((err) => {
        if (err instanceof RealtimeSessionError) {
          res.status(503).json({ detail: err.message });
        } else {
          handleError(res, err);
        }
      });
  });

  // -- encounters (spec §21.2) ---------------------------------------------

  app.post('/api/encounters', (req, res) => {
    const syntheticDemo = (req.body?.synthetic_demo as boolean | undefined) ?? true;
    const runtime = service.createEncounter(syntheticDemo);
    res.json({
      encounter_id: runtime.encounter_id,
      status: 'created',
      synthetic_demo: runtime.synthetic_demo,
    });
  });

  app.post('/api/encounters/:encounterId/start', (req, res) => {
    const runtime = getRuntime(req, res);
    if (!runtime) return;
    service
      .startSession(runtime)
      .then(() => res.json({ status: runtime.snapshot.status }))
      .catch((err) => handleError(res, err));
  });

  app.post('/api/encounters/:encounterId/stop', (req, res) => {
    const runtime = getRuntime(req, res);
    if (!runtime) return;
    service
      .stopSession(runtime)
      .then(() => res.json({ status: runtime.snapshot.status }))
      .catch((err) => handleError(res, err));
  });

  app.post('/api/encounters/:encounterId/reset', (req, res) => {
    const runtime = getRuntime(req, res);
    if (!runtime) return;
    service
      .resetEncounter(runtime)
      .then(() => res.json({ status: 'reset' }))
      .catch((err) => handleError(res, err));
  });

  /** Text fallback: a typed statement processed exactly like a finalized turn. */
  app.post('/api/encounters/:encounterId/text-turn', (req, res) => {
    const runtime = getRuntime(req, res);
    if (!runtime) return;
    Promise.resolve()
      .then(() =>
        service.processFinalTurn(runtime, {
          event_id: (req.body?.event_id as string | undefined) ?? newId('evt'),
          text: String(req.body?.text ?? ''),
          speaker: parseOptionalSpeaker(req.body?.speaker),
          sequence: (req.body?.sequence as number | undefined) ?? null,
        }),
      )
      .then(() => res.json(service.snapshotPayload(runtime)))
      .catch((err) => handleError(res, err));
  });

  app.post('/api/encounters/:encounterId/proposals', (req, res) => {
    const runtime = getRuntime(req, res);
    if (!runtime) return;
    service
      .proposePrescription(runtime, {
        event_id: (req.body?.event_id as string | undefined) ?? newId('evt'),
        surface_text: String(req.body?.medication_surface_text ?? ''),
      })
      .then(() => res.json(service.snapshotPayload(runtime)))
      .catch((err) => handleError(res, err));
  });

  app.post('/api/encounters/:encounterId/proposals/cancel', (req, res) => {
    const runtime = getRuntime(req, res);
    if (!runtime) return;
    service
      .cancelPrescription(runtime, {
        event_id: (req.body?.event_id as string | undefined) ?? newId('evt'),
        proposal_id: String(req.body?.proposal_id ?? ''),
      })
      .then(() => res.json(service.snapshotPayload(runtime)))
      .catch((err) => handleError(res, err));
  });

  app.get('/api/encounters/:encounterId/audit', (req, res) => {
    const runtime = getRuntime(req, res);
    if (!runtime) return;
    const extractorLabel =
      extractor instanceof LiveExtractor ? settings.extraction_model : EXTRACTOR_VERSION;
    res.json(buildAuditExport(runtime, extractorLabel));
  });

  app.get('/api/encounters/:encounterId/snapshot', (req, res) => {
    const runtime = getRuntime(req, res);
    if (!runtime) return;
    res.json(service.snapshotPayload(runtime));
  });

  // -- demo-script replay ---------------------------------------------------

  app.post('/api/encounters/:encounterId/demo-script/:scriptId', (req, res) => {
    const runtime = getRuntime(req, res);
    if (!runtime) return;
    const script = demoScripts.scripts.find((s) => s.id === req.params.scriptId);
    if (!script) {
      res.status(404).json({ detail: 'unknown demo script' });
      return;
    }
    const speed = Math.max(Number(req.query.speed ?? 1.0) || 1.0, 0.1);
    void replayScript(service, runtime, script, speed).catch((err) =>
      console.error('demo replay failed:', err),
    );
    res.json({ status: 'playing', script_id: script.id, turns: script.turns.length });
  });

  // -- WebSockets (spec §21.3) ---------------------------------------------

  const server = http.createServer(app);
  const encounterWss = new WebSocketServer({ noServer: true });
  const audioWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const audioMatch = url.pathname.match(/^\/ws\/encounters\/([^/]+)\/audio$/);
    const encounterMatch = url.pathname.match(/^\/ws\/encounters\/([^/]+)$/);
    if (audioMatch) {
      audioWss.handleUpgrade(request, socket, head, (ws) => {
        void handleAudioSocket(service, settings, ws, audioMatch[1]);
      });
    } else if (encounterMatch) {
      encounterWss.handleUpgrade(request, socket, head, (ws) => {
        handleEncounterSocket(service, ws, encounterMatch[1]);
      });
    } else {
      socket.destroy();
    }
  });

  return { app, server, service, settings, index, fleet };
}

// ---------------------------------------------------------------------------
// Demo-script replay
// ---------------------------------------------------------------------------

async function replayScript(
  service: EncounterService,
  runtime: EncounterRuntime,
  script: DemoScript,
  speed: number,
): Promise<void> {
  for (let i = 0; i < script.turns.length; i++) {
    const turn = script.turns[i];
    const text = turn.text;
    const speaker = parseSpeaker(turn.speaker);
    // Progressive partial captions (display only — never analyzed).
    const words = text.split(' ');
    const step = Math.max(Math.floor(words.length / 3), 1);
    for (let cut = step; cut < words.length; cut += step) {
      const partial = words.slice(0, cut).join(' ');
      service.broadcast(runtime, {
        type: 'caption.updated',
        speaker,
        text: partial,
        provisional: true,
      });
      await sleep(250 / speed);
    }
    await sleep(200 / speed);
    try {
      await service.processFinalTurn(runtime, {
        event_id: newId('evt'),
        text,
        speaker,
        provider_item_id: `${script.id}-item-${i + 1}`,
      });
    } catch (err) {
      if (!(err instanceof DuplicateEventError)) throw err;
    }
    await sleep((turn.pause_ms ?? 900) / speed);
  }
}

// ---------------------------------------------------------------------------
// Encounter WebSocket
// ---------------------------------------------------------------------------

function handleEncounterSocket(service: EncounterService, ws: WebSocket, encounterId: string): void {
  const runtime = service.encounters.get(encounterId);
  if (!runtime) {
    ws.close(4404);
    return;
  }
  runtime.subscribers.add(ws);
  // A (re)connecting client always receives the current snapshot first.
  ws.send(JSON.stringify(service.snapshotPayload(runtime)));
  ws.on('message', (raw) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw));
    } catch {
      ws.send(JSON.stringify({ type: 'processing.error', detail: 'invalid JSON' }));
      return;
    }
    void handleClientEvent(service, runtime, ws, message);
  });
  ws.on('close', () => {
    runtime.subscribers.delete(ws);
  });
}

async function handleClientEvent(
  service: EncounterService,
  runtime: EncounterRuntime,
  ws: WebSocket,
  message: Record<string, unknown>,
): Promise<void> {
  const msgType = String(message.type ?? '');
  try {
    if (msgType === 'transcript.partial') {
      // Provisional captions are display-only; without an explicit label they
      // stay 'unknown' (neutral) rather than guessing — the resolved speaker
      // arrives moments later on the finalized turn.
      const speaker = parseSpeaker(message.speaker, runtime.speaker_override ?? Speaker.UNKNOWN);
      service.recordPartial(runtime, String(message.text ?? ''), speaker);
      service.broadcast(runtime, {
        type: 'caption.updated',
        speaker,
        text: String(message.text ?? ''),
        provisional: true,
      });
    } else if (msgType === 'transcript.final') {
      await service.processFinalTurn(runtime, {
        event_id: (message.event_id as string | undefined) || newId('evt'),
        text: String(message.text ?? ''),
        speaker: parseOptionalSpeaker(message.speaker),
        sequence: (message.sequence as number | undefined) ?? null,
        provider_item_id: (message.provider_item_id as string | undefined) ?? null,
        started_at_ms: (message.started_at_ms as number | undefined) ?? null,
        ended_at_ms: (message.ended_at_ms as number | undefined) ?? null,
      });
    } else if (msgType === 'speaker.changed') {
      await service.changeSpeaker(runtime, parseSpeaker(message.speaker));
    } else if (msgType === 'prescription.proposed') {
      await service.proposePrescription(runtime, {
        event_id: (message.event_id as string | undefined) || newId('evt'),
        surface_text: String(message.medication_surface_text ?? ''),
      });
    } else if (msgType === 'prescription.cancelled') {
      await service.cancelPrescription(runtime, {
        event_id: (message.event_id as string | undefined) || newId('evt'),
        proposal_id: String(message.proposal_id ?? ''),
      });
    } else if (msgType === 'session.start') {
      await service.startSession(runtime);
    } else if (msgType === 'session.stop') {
      await service.stopSession(runtime);
    } else if (msgType === 'encounter.reset') {
      await service.resetEncounter(runtime);
    } else if (msgType === 'snapshot.request') {
      ws.send(JSON.stringify(service.snapshotPayload(runtime)));
    } else {
      ws.send(
        JSON.stringify({ type: 'processing.error', detail: `unknown event type '${msgType}'` }),
      );
    }
  } catch (err) {
    if (err instanceof DuplicateEventError) {
      // Idempotent: a duplicate final event is acknowledged but not reprocessed.
      ws.send(JSON.stringify({ type: 'event.duplicate', event_id: message.event_id }));
    } else if (err instanceof RangeError) {
      ws.send(JSON.stringify({ type: 'processing.error', detail: err.message }));
    } else {
      console.error('websocket handler error:', err);
      ws.send(JSON.stringify({ type: 'processing.error', detail: 'internal error' }));
    }
  }
}

// ---------------------------------------------------------------------------
// Audio relay WebSocket
// ---------------------------------------------------------------------------

/**
 * Live-mode fallback transport: browser PCM16 frames relayed server-side to
 * the realtime transcription provider (spec §7.2 alternative architecture).
 * Requires OPENAI_API_KEY; the browser never sees provider credentials.
 *
 * Not exercisable without a provider key — see MORNING_REVIEW.md.
 */
async function handleAudioSocket(
  service: EncounterService,
  settings: Settings,
  ws: WebSocket,
  encounterId: string,
): Promise<void> {
  const runtime = service.encounters.get(encounterId);
  if (!runtime) {
    ws.close(4404);
    return;
  }

  const onPartial = (text: string): void => {
    service.broadcast(runtime, {
      type: 'caption.updated',
      // Neutral until finalization: the mic stream carries no speaker label,
      // and the resolved role lands with the finalized turn moments later.
      speaker: runtime.speaker_override ?? Speaker.UNKNOWN,
      text,
      provisional: true,
    });
  };

  const onFinal = async (itemId: string | null, text: string): Promise<void> => {
    try {
      await service.processFinalTurn(runtime, {
        event_id: newId('evt'),
        text,
        // Always attributed server-side; a deliberate speaker.changed control
        // frame still overrides via runtime.speaker_override.
        speaker: null,
        provider_item_id: itemId,
      });
    } catch (err) {
      if (!(err instanceof DuplicateEventError)) throw err;
    }
  };

  // Missing key fails fast (previous behavior); the supervisor's retry budget
  // is reserved for network-level failures during a running session.
  if (!settings.openai_api_key) {
    const detail = 'OPENAI_API_KEY is not configured on the server';
    runtime.store.append(EventType.TRANSCRIPTION_FAILED, { error: detail });
    ws.send(JSON.stringify({ type: 'processing.error', detail: `Live transcription unavailable: ${detail}` }));
    ws.close(4503);
    return;
  }

  // Supervised relay: reconnects with backoff when the provider closes the
  // socket mid-session, so long consultations survive provider session caps.
  const relaySupervisor = new RelaySupervisor(settings, onPartial, onFinal, {
    onStateChange: (state, detail) => {
      if (state === 'reconnecting' || state === 'gave_up') {
        runtime.store.append(EventType.TRANSCRIPTION_FAILED, { error: `relay ${state}: ${detail}` });
      }
      service.broadcast(runtime, { type: 'relay.state', state, detail });
    },
  });

  const done = relaySupervisor.run().catch((err) => {
    if (err instanceof RealtimeSessionError) {
      runtime.store.append(EventType.TRANSCRIPTION_FAILED, { error: err.message });
      try {
        ws.send(
          JSON.stringify({
            type: 'processing.error',
            detail: `Live transcription unavailable: ${err.message}`,
          }),
        );
      } catch {
        // client already gone
      }
      ws.close(4503);
    } else {
      console.error('relay failed:', err);
      ws.close(1011);
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      void relaySupervisor
        .sendAudio(data as Buffer)
        .catch((err) => console.error('relay send failed:', err));
    } else {
      try {
        const control = JSON.parse(String(data));
        if (control.type === 'speaker.changed') {
          void service.changeSpeaker(runtime, parseSpeaker(control.speaker));
        }
      } catch {
        // ignore malformed control frames
      }
    }
  });
  ws.on('close', () => {
    void relaySupervisor.stop();
  });
  await done;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    const backend = createBackend();
    const port = Number(process.env.PORT ?? 8000);
    backend.server.listen(port, () => {
      console.log(`HormoneRx realtime backend (TypeScript) listening on :${port}`);
      console.log(
        `evidence: ${JSON.stringify(backend.index.eligibilitySummary().runtimeEligible)} runtime-eligible (pending sign-off override: ${backend.settings.evidence_allow_pending_verification})`,
      );
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
