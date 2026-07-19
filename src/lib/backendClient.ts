// Client for the realtime backend (REST + WebSocket).
// The browser never holds a provider API key: live transcription credentials
// are minted server-side, and all analysis runs on the backend.

export interface BackendHealth {
  status: string;
  demo_mode: boolean;
  live_extraction_available: boolean;
  live_transcription_available: boolean;
  audio_diarization_available: boolean;
  extraction_model: string;
  transcription_model: string;
  evidence: {
    datasetVersion: string;
    recordCount: number;
    runtimeEligible: string[];
    pendingPhysicianSignOff: string[];
  };
}

export type AudioRelayState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'draining'
  | 'closed'
  | 'gave_up';

export type RelayDiagnostics = Record<string, unknown>;

const AUDIO_RELAY_STATES = new Set<AudioRelayState>([
  'connecting',
  'connected',
  'reconnecting',
  'draining',
  'closed',
  'gave_up',
]);

export type AudioServerEvent =
  | {
      type: 'relay.state';
      state: AudioRelayState;
      detail: string;
      diagnostics?: RelayDiagnostics;
    }
  | { type: 'processing.error'; detail: string }
  | {
      type: 'audio.drained';
      committed: number;
      completed: number;
      timed_out: boolean;
      diagnostics?: RelayDiagnostics;
    };

export function parseAudioServerEvent(data: unknown): AudioServerEvent | null {
  try {
    const parsed = JSON.parse(String(data)) as Record<string, unknown>;
    if (parsed.type === 'processing.error' && typeof parsed.detail === 'string') {
      return { type: 'processing.error', detail: parsed.detail };
    }
    if (
      parsed.type === 'relay.state' &&
      typeof parsed.state === 'string' &&
      AUDIO_RELAY_STATES.has(parsed.state as AudioRelayState) &&
      typeof parsed.detail === 'string'
    ) {
      return parsed as AudioServerEvent;
    }
    if (
      parsed.type === 'audio.drained' &&
      typeof parsed.committed === 'number' &&
      typeof parsed.completed === 'number' &&
      typeof parsed.timed_out === 'boolean'
    ) {
      return parsed as AudioServerEvent;
    }
  } catch {
    // Ignore non-JSON frames from an incompatible proxy/provider.
  }
  return null;
}

export interface BackendAssertion {
  assertion_id: string;
  subject: string;
  predicate: string;
  concept_id: string;
  canonical_name: string;
  category: string;
  status: string;
  source_turn_id: string;
  is_active: boolean;
  certainty: string;
  origin: string;
  supersedes_assertion_id: string | null;
  superseded_by_assertion_id: string | null;
}

export interface BackendWarning {
  warning_id: string;
  state: 'active' | 'updated' | 'retracted';
  display_label: string;
  evidence_record_id: string;
  context: string;
  verification_status: string;
  trigger_assertion_ids: string[];
  retraction_reason: string | null;
  retracted_by_turn_id: string | null;
  created_at: string;
  retracted_at: string | null;
  evidence_record: Record<string, unknown>;
}

export interface BackendResult {
  state: string;
  lookup_reason: string;
  missing_information: string[];
  excluded_notes: string[];
  conflict_notes: string[];
  messages: string[];
  active_warnings: BackendWarning[];
  warning_history: BackendWarning[];
  latency_ms: { total_ms: number } | null;
}

export interface BackendTurn {
  turn_id: string;
  sequence: number;
  speaker: string;
  source_speaker_label?: string | null;
  text: string;
  arrived_late: boolean;
}

export interface BackendProposal {
  proposal_id: string;
  surface_text: string;
  canonical_name: string | null;
  status: string;
}

export interface EncounterState {
  turns: BackendTurn[];
  active_assertions: BackendAssertion[];
  inactive_assertions: BackendAssertion[];
  proposals: BackendProposal[];
  result: BackendResult;
  status?: string;
}

export interface AddTextTurnPayload {
  event_id: string;
  text: string;
  speaker: 'doctor' | 'patient' | 'other_person' | 'unknown' | null;
  source_speaker_label: string | null;
  provider_item_id: string;
  started_at_ms: number;
  ended_at_ms: number;
}

export interface DemoScript {
  id: string;
  label: string;
  description: string;
  turns: { speaker: string; text: string }[];
}

export interface FleetFinding {
  finding_id: string;
  worker_id: string;
  worker_name: string;
  encounter_id: string | null;
  severity: 'info' | 'attention' | 'alert';
  kind: string;
  message: string;
  created_at: string;
}

export interface FleetWorkerStatus {
  id: string;
  name: string;
  tier: number;
  cadence: string;
  agentic: boolean;
  enabled: boolean;
  disabled_reason: string | null;
  description: string;
  status: string;
  runs: number;
  errors: number;
  findings: number;
  proposals_applied: number;
}

export interface FleetStatus {
  total_workers: number;
  running_workers: number;
  healthy_workers: number;
  findings_total: number;
  review_queue_size: number;
  workers: FleetWorkerStatus[];
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`backend ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export const backend = {
  health: () => fetch('/api/health').then((r) => json<BackendHealth>(r)),
  demoScripts: () => fetch('/api/demo-scripts').then((r) => json<{ scripts: DemoScript[] }>(r)),
  createEncounter: (syntheticDemo = false) =>
    fetch('/api/encounters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ synthetic_demo: syntheticDemo }),
    }).then((r) => json<{ encounter_id: string }>(r)),
  startEncounter: (encounterId: string) =>
    fetch(`/api/encounters/${encounterId}/start`, { method: 'POST' }).then((r) =>
      json<{ status: string }>(r),
    ),
  stopEncounter: (encounterId: string) =>
    fetch(`/api/encounters/${encounterId}/stop`, { method: 'POST' }).then((r) =>
      json<{ status: string }>(r),
    ),
  addTextTurn: async (encounterId: string, payload: AddTextTurnPayload) => {
    const response = await fetch(`/api/encounters/${encounterId}/text-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status === 409) return { duplicate: true as const };
    return json<EncounterState>(response);
  },
  playScript: (encounterId: string, scriptId: string) =>
    fetch(`/api/encounters/${encounterId}/demo-script/${scriptId}`, { method: 'POST' }).then((r) => json(r)),
  audit: (encounterId: string) => fetch(`/api/encounters/${encounterId}/audit`).then((r) => json<object>(r)),
  mintRealtimeSession: () => fetch('/api/realtime/session', { method: 'POST' }).then((r) => json<object>(r)),
  fleetStatus: () => fetch('/api/fleet/status').then((r) => json<FleetStatus>(r)),
};

/**
 * Everything the client may send over the encounter socket. Deliberately has
 * no `speaker` field on transcript.final and no speaker.changed event: the
 * backend attributes speaker roles itself, and re-adding a client-side label
 * should be a compile error.
 */
export type ClientEvent =
  | { type: 'session.start' }
  | { type: 'session.stop' }
  | { type: 'encounter.reset' }
  | { type: 'transcript.final'; event_id: string; text: string }
  | { type: 'prescription.proposed'; event_id: string; medication_surface_text: string }
  | { type: 'prescription.cancelled'; event_id: string; proposal_id: string };

export type ServerEvent =
  | ({ type: 'encounter.snapshot' } & EncounterState)
  | { type: 'caption.updated'; speaker: string; text: string; provisional: boolean }
  | { type: 'graph.updated'; active_assertions: BackendAssertion[]; inactive_assertions: BackendAssertion[]; proposals: BackendProposal[] }
  | { type: 'result.updated'; result: BackendResult }
  | { type: 'warning.created' | 'warning.updated' | 'warning.retracted'; warning: BackendWarning }
  | { type: 'result.processing'; turn_id: string; speaker: string }
  | { type: 'processing.error'; detail: string }
  | { type: 'event.duplicate'; event_id: string }
  | { type: 'fleet.finding'; finding: FleetFinding }
  | {
      type: 'fleet.status';
      total_workers: number;
      running_workers: number;
      healthy_workers: number;
      findings_total: number;
      review_queue_size: number;
      recent_findings: FleetFinding[];
    }
  | {
      type: 'relay.state';
      state: AudioRelayState;
      detail: string;
      diagnostics?: RelayDiagnostics;
    };

export class EncounterSocket {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retryMs = 500;
  private eventCounter = 0;
  private openWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private encounterId: string,
    private onEvent: (event: ServerEvent) => void,
    private onStatus: (status: 'connecting' | 'open' | 'closed') => void,
  ) {}

  connect() {
    this.closedByUser = false;
    this.onStatus('connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${protocol}://${window.location.host}/ws/encounters/${this.encounterId}`);
    this.ws.onopen = () => {
      this.retryMs = 500;
      this.onStatus('open');
      for (const waiter of this.openWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.openWaiters.clear();
    };
    this.ws.onmessage = (message) => {
      try {
        this.onEvent(JSON.parse(message.data) as ServerEvent);
      } catch {
        // ignore malformed frames
      }
    };
    this.ws.onclose = () => {
      this.onStatus('closed');
      if (!this.closedByUser) {
        // Reconnect with backoff; the server replays the current snapshot on connect.
        setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 8000);
      }
    };
  }

  send(payload: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  waitUntilOpen(timeoutMs = 5000): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.openWaiters.delete(waiter);
          reject(new Error('Encounter connection timed out'));
        }, timeoutMs),
      };
      this.openWaiters.add(waiter);
    });
  }

  nextEventId(): string {
    this.eventCounter += 1;
    return `ui-${this.encounterId}-${this.eventCounter}-${Date.now()}`;
  }

  close() {
    this.closedByUser = true;
    for (const waiter of this.openWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Encounter connection closed'));
    }
    this.openWaiters.clear();
    this.ws?.close();
  }
}
