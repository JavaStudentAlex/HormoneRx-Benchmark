import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, cn } from '../components/ui/primitives';
import TranscriptPanel from '../components/live/TranscriptPanel';
import GraphPanel from '../components/live/GraphPanel';
import ResultPanel from '../components/live/ResultPanel';
import ReasoningGraphPanel from '../components/live/ReasoningGraphPanel';
import FleetPanel, { type FleetSummary } from '../components/live/FleetPanel';
import { downloadText } from '../lib/exportUtils';
import { startAudioCapture, type AudioCaptureHandle } from '../lib/audioCapture';
import {
  backend,
  EncounterSocket,
  type BackendAssertion,
  type BackendHealth,
  type BackendProposal,
  type BackendResult,
  type BackendTurn,
  type DemoScript,
  type FleetFinding,
  type FleetWorkerStatus,
  type ServerEvent,
} from '../lib/backendClient';

type SessionPhase = 'idle' | 'listening' | 'stopped';
type MicState = 'not_requested' | 'requesting' | 'active' | 'denied' | 'unavailable';

export default function LiveConsultation() {
  const [searchParams] = useSearchParams();
  // Old bookmark compatibility: the former text tab is its own page now.
  if (searchParams.get('tab') === 'text') return <Navigate to="/analyze" replace />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-navy">Live Consultation</h1>
        <p className="mt-2 max-w-3xl text-sm text-navy-soft">
          One conversation, analyzed in real time: the backend attributes each finalized turn to the doctor or patient
          on its own, builds a provenance-linked encounter medication graph, checks it deterministically against the
          physician-reviewed evidence dataset, and visibly retracts any warning when later speech corrects the context.
        </p>
      </div>

      <LiveSession />
    </div>
  );
}

function LiveSession() {
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [scripts, setScripts] = useState<DemoScript[]>([]);
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed'>('closed');
  const [micState, setMicState] = useState<MicState>('not_requested');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [caption, setCaption] = useState<{ speaker: string; text: string } | null>(null);
  const [turns, setTurns] = useState<BackendTurn[]>([]);
  const [active, setActive] = useState<BackendAssertion[]>([]);
  const [inactive, setInactive] = useState<BackendAssertion[]>([]);
  const [proposals, setProposals] = useState<BackendProposal[]>([]);
  const [result, setResult] = useState<BackendResult | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [highlightTurnIds, setHighlightTurnIds] = useState<Set<string>>(new Set());
  const [manualText, setManualText] = useState('');
  const [proposalText, setProposalText] = useState('');
  const [playingScript, setPlayingScript] = useState<string | null>(null);
  const [processingTurn, setProcessingTurn] = useState(false);
  const [fleetSummary, setFleetSummary] = useState<FleetSummary | null>(null);
  const [fleetFindings, setFleetFindings] = useState<FleetFinding[]>([]);
  const [fleetWorkers, setFleetWorkers] = useState<FleetWorkerStatus[]>([]);

  const socketRef = useRef<EncounterSocket | null>(null);
  const encounterIdRef = useRef<string | null>(null);
  const micRef = useRef<AudioCaptureHandle | null>(null);
  const audioWsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    backend
      .health()
      .then((h) => setHealth(h))
      .catch(() => setBackendDown(true));
    backend
      .demoScripts()
      .then((d) => setScripts(d.scripts))
      .catch(() => undefined);
    backend
      .fleetStatus()
      .then((s) => {
        setFleetSummary(s);
        setFleetWorkers(s.workers);
      })
      .catch(() => undefined);
    return () => {
      stopMicrophone();
      socketRef.current?.close();
      audioWsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(timer);
  }, [startedAt]);

  const applyState = useCallback((event: ServerEvent) => {
    if (event.type === 'encounter.snapshot' || event.type === 'graph.updated') {
      if ('turns' in event && event.turns) setTurns(event.turns as BackendTurn[]);
      setActive(event.active_assertions ?? []);
      setInactive(event.inactive_assertions ?? []);
      setProposals(event.proposals ?? []);
      if (event.type === 'encounter.snapshot' && 'result' in event && event.result) setResult(event.result);
      setCaption(null);
    } else if (event.type === 'result.updated') {
      setResult(event.result);
      setProcessingTurn(false);
    } else if (event.type === 'result.processing') {
      setProcessingTurn(true);
    } else if (event.type === 'caption.updated') {
      if (!event.provisional) return;
      setCaption({ speaker: event.speaker, text: event.text });
    } else if (event.type === 'processing.error') {
      setErrorBanner(event.detail);
    } else if (event.type === 'fleet.status') {
      setFleetSummary({
        total_workers: event.total_workers,
        running_workers: event.running_workers,
        healthy_workers: event.healthy_workers,
        findings_total: event.findings_total,
        review_queue_size: event.review_queue_size,
      });
      setFleetFindings(event.recent_findings ?? []);
    } else if (event.type === 'fleet.finding') {
      setFleetFindings((prev) =>
        prev.some((f) => f.finding_id === event.finding.finding_id)
          ? prev
          : [event.finding, ...prev].slice(0, 12),
      );
    }
  }, []);

  async function ensureEncounter(): Promise<string> {
    if (encounterIdRef.current) return encounterIdRef.current;
    const { encounter_id } = await backend.createEncounter();
    encounterIdRef.current = encounter_id;
    const socket = new EncounterSocket(encounter_id, applyState, setWsStatus);
    socket.connect();
    socketRef.current = socket;
    // Give the socket a moment to open so session.start is not dropped.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return encounter_id;
  }

  async function startListening() {
    setErrorBanner(null);
    try {
      await ensureEncounter();
      socketRef.current?.send({ type: 'session.start' });
      setPhase('listening');
      setStartedAt(Date.now());
      if (health?.live_transcription_available) {
        await startMicrophone();
      } else {
        setMicState('unavailable');
      }
    } catch (err) {
      setBackendDown(true);
      setErrorBanner('The realtime backend is not reachable. Start it with: npm run backend');
    }
  }

  async function startMicrophone() {
    const encounterId = encounterIdRef.current;
    if (!encounterId) return;
    setMicState('requesting');
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const audioWs = new WebSocket(`${protocol}://${window.location.host}/ws/encounters/${encounterId}/audio`);
      audioWs.binaryType = 'arraybuffer';
      audioWsRef.current = audioWs;
      const mic = await startAudioCapture((chunk) => {
        if (audioWs.readyState === WebSocket.OPEN) audioWs.send(chunk);
      });
      micRef.current = mic;
      setMicState('active');
    } catch {
      setMicState('denied');
      setErrorBanner('Microphone unavailable or permission denied. The scripted demo and manual turn input still work.');
    }
  }

  function stopMicrophone() {
    micRef.current?.stop();
    micRef.current = null;
    audioWsRef.current?.close();
    audioWsRef.current = null;
  }

  function stopListening() {
    socketRef.current?.send({ type: 'session.stop' });
    stopMicrophone();
    setMicState('not_requested');
    setPhase('stopped');
    setStartedAt(null);
  }

  function clearEncounter() {
    socketRef.current?.send({ type: 'encounter.reset' });
    setTurns([]);
    setCaption(null);
    setResult(null);
    setHighlightTurnIds(new Set());
    setPhase('idle');
    setStartedAt(null);
    setElapsed(0);
  }

  async function finalizeManualTurn() {
    const text = manualText.trim();
    if (!text) return;
    await ensureEncounter();
    if (phase === 'idle') {
      socketRef.current?.send({ type: 'session.start' });
      setPhase('listening');
      setStartedAt(Date.now());
      setMicState((m) => (m === 'not_requested' ? 'unavailable' : m));
    }
    // No speaker label: the backend attributes the role from the conversation.
    socketRef.current?.send({
      type: 'transcript.final',
      event_id: socketRef.current.nextEventId(),
      text,
    });
    setManualText('');
  }

  async function proposePrescription() {
    const text = proposalText.trim();
    if (!text) return;
    await ensureEncounter();
    socketRef.current?.send({
      type: 'prescription.proposed',
      event_id: socketRef.current.nextEventId(),
      medication_surface_text: text,
    });
    setProposalText('');
  }

  function cancelProposal(proposalId: string) {
    socketRef.current?.send({
      type: 'prescription.cancelled',
      event_id: socketRef.current!.nextEventId(),
      proposal_id: proposalId,
    });
  }

  async function playScript(scriptId: string) {
    setErrorBanner(null);
    try {
      const encounterId = await ensureEncounter();
      if (phase !== 'listening') {
        socketRef.current?.send({ type: 'session.start' });
        setPhase('listening');
        setStartedAt(Date.now());
        setMicState('unavailable');
      }
      setPlayingScript(scriptId);
      await backend.playScript(encounterId, scriptId);
      const script = scripts.find((s) => s.id === scriptId);
      const approxMs = (script?.turns.length ?? 4) * 2600;
      setTimeout(() => setPlayingScript(null), approxMs);
    } catch {
      setPlayingScript(null);
      setBackendDown(true);
    }
  }

  async function exportAudit() {
    const encounterId = encounterIdRef.current;
    if (!encounterId) return;
    const audit = await backend.audit(encounterId);
    downloadText(`encounter-audit-${encounterId}.json`, JSON.stringify(audit, null, 2), 'application/json');
  }

  function focusTurn(turnId: string) {
    setHighlightTurnIds(new Set([turnId]));
    setTimeout(() => setHighlightTurnIds(new Set()), 2500);
  }

  const duration = useMemo(() => {
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }, [elapsed]);

  if (backendDown) {
    return (
      <Card>
        <CardBody className="space-y-2">
          <Badge tone="danger">Realtime backend not reachable</Badge>
          <p className="text-sm text-navy-soft">
            The live session needs the realtime backend on port 8000. Start it with{' '}
            <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-xs">npm run backend</code>{' '}
            and reload this page. The <span className="font-medium">Text Analysis</span> page (
            <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-xs">/analyze</code>) works without the
            backend.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Consent + prototype notice (spec §7.1): shown before and during capture. */}
      <div className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-xs leading-relaxed text-navy-soft">
        <span className="font-semibold text-navy">Before you start: </span>
        audio is processed for live transcription only. This is a research prototype — it does not make prescribing
        decisions and never claims a combination is safe. Use <span className="font-semibold">synthetic conversations
        only</span>; do not speak real patient information. Raw audio is not retained.
        {health && !health.live_transcription_available && (
          <span>
            {' '}
            <span className="font-semibold text-amber">Demo mode:</span> no server API key is configured, so microphone
            transcription is unavailable — use a scripted demo conversation or the conversation input below.
          </span>
        )}
      </div>

      {errorBanner && (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-xs text-danger">{errorBanner}</div>
      )}

      {/* Session control */}
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Session</CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
                phase === 'listening' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line bg-canvas text-ink-muted',
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', phase === 'listening' ? 'animate-pulse bg-danger' : 'bg-ink-faint')} />
              {phase === 'listening' ? `Listening · ${duration}` : phase === 'stopped' ? 'Stopped' : 'Not started'}
            </span>
            <Badge tone={micState === 'active' ? 'teal' : micState === 'denied' ? 'danger' : 'muted'}>
              mic: {micState === 'not_requested' ? 'off' : micState}
            </Badge>
            <Badge tone={wsStatus === 'open' ? 'teal' : 'muted'}>ws: {wsStatus}</Badge>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={startListening} disabled={phase === 'listening'}>
              Start listening
            </Button>
            <Button variant="secondary" onClick={stopListening} disabled={phase !== 'listening'}>
              Stop listening
            </Button>
            <Button variant="ghost" onClick={clearEncounter}>
              Clear encounter
            </Button>
            <Button variant="ghost" onClick={exportAudit} disabled={!encounterIdRef.current}>
              Export audit JSON
            </Button>
          </div>

          {scripts.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                Scripted demo conversations (replayed through the full live pipeline)
              </div>
              <div className="flex flex-wrap gap-2">
                {scripts.map((script) => (
                  <Button
                    key={script.id}
                    variant="secondary"
                    className="px-2.5 py-1.5 text-xs"
                    title={script.description}
                    disabled={playingScript !== null}
                    onClick={() => playScript(script.id)}
                  >
                    {playingScript === script.id ? 'Playing…' : script.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <details>
            <summary className="cursor-pointer text-xs font-medium text-teal">More controls</summary>
            <div className="mt-2 max-w-md">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                Proposed prescription (doctor)
              </div>
              <div className="flex gap-2">
                <input
                  value={proposalText}
                  onChange={(e) => setProposalText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && proposePrescription()}
                  placeholder='e.g. "Lamotrigine"'
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-navy placeholder:text-ink-faint focus:border-teal"
                />
                <Button variant="secondary" onClick={proposePrescription} disabled={!proposalText.trim()}>
                  Propose
                </Button>
              </div>
            </div>
          </details>
        </CardBody>
      </Card>

      {/* Conversation + live health warnings */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="flex flex-col lg:col-span-2">
          <CardHeader className="flex items-center justify-between gap-2">
            <CardTitle>Conversation</CardTitle>
            {processingTurn && (
              <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                <span className="h-2 w-2 animate-pulse rounded-full bg-teal" />
                analyzing turn…
              </span>
            )}
          </CardHeader>
          <CardBody className="flex-1">
            <TranscriptPanel turns={turns} caption={caption} highlightTurnIds={highlightTurnIds} />
          </CardBody>
          <div className="border-t border-line px-5 py-3">
            <div className="flex gap-2">
              <input
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && finalizeManualTurn()}
                placeholder='Type what either party says — e.g. "I take Tegretol."'
                className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-navy placeholder:text-ink-faint focus:border-teal"
                aria-label="Add a conversation turn (speaker inferred automatically)"
              />
              <Button variant="secondary" onClick={finalizeManualTurn} disabled={!manualText.trim()}>
                Finalize turn
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-ink-faint">
              Speaker roles are attributed automatically — no need to say who is talking.
            </p>
          </div>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Health warnings</CardTitle>
          </CardHeader>
          <CardBody className="max-h-[34rem] overflow-y-auto">
            <ResultPanel
              result={result}
              assertions={[...active, ...inactive]}
              turns={turns}
              onFocusTurn={focusTurn}
              processing={processingTurn}
            />
          </CardBody>
        </Card>
      </div>

      {/* Reasoning graph: how each warning traces back to the spoken turns */}
      <Card>
        <CardHeader>
          <CardTitle>Reasoning graph — turn → patient fact → evidence</CardTitle>
        </CardHeader>
        <CardBody>
          <ReasoningGraphPanel
            turns={turns}
            assertions={[...active, ...inactive]}
            result={result}
            onFocusTurn={focusTurn}
          />
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-teal">Assertion detail & proposals</summary>
            <div className="mt-2">
              <GraphPanel
                active={active}
                inactive={inactive}
                proposals={proposals}
                onFocusTurn={focusTurn}
                onCancelProposal={cancelProposal}
              />
            </div>
          </details>
        </CardBody>
      </Card>

      {/* Always-running agent fleet */}
      <Card>
        <CardHeader>
          <CardTitle>Agent fleet (always-running workers)</CardTitle>
        </CardHeader>
        <CardBody>
          <FleetPanel summary={fleetSummary} findings={fleetFindings} workers={fleetWorkers} />
        </CardBody>
      </Card>
    </div>
  );
}
