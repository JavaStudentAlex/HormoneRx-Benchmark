// Client for the realtime backend (REST + WebSocket).
// The browser never holds a provider API key: live transcription credentials
// are minted server-side, and all analysis runs on the backend.

export interface BackendHealth {
  status: string;
  demo_mode: boolean;
  live_extraction_available: boolean;
  live_transcription_available: boolean;
  extraction_model: string;
  transcription_model: string;
  evidence: {
    datasetVersion: string;
    recordCount: number;
    runtimeEligible: string[];
    pendingPhysicianSignOff: string[];
  };
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

export interface DemoScript {
  id: string;
  label: string;
  description: string;
  turns: { speaker: string; text: string }[];
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`backend ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export const backend = {
  health: () => fetch('/api/health').then((r) => json<BackendHealth>(r)),
  demoScripts: () => fetch('/api/demo-scripts').then((r) => json<{ scripts: DemoScript[] }>(r)),
  createEncounter: () =>
    fetch('/api/encounters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ synthetic_demo: true }),
    }).then((r) => json<{ encounter_id: string }>(r)),
  playScript: (encounterId: string, scriptId: string) =>
    fetch(`/api/encounters/${encounterId}/demo-script/${scriptId}`, { method: 'POST' }).then((r) => json(r)),
  audit: (encounterId: string) => fetch(`/api/encounters/${encounterId}/audit`).then((r) => json<object>(r)),
  mintRealtimeSession: () => fetch('/api/realtime/session', { method: 'POST' }).then((r) => json<object>(r)),
};

export type ServerEvent =
  | ({ type: 'encounter.snapshot' } & EncounterState)
  | { type: 'caption.updated'; speaker: string; text: string; provisional: boolean }
  | { type: 'graph.updated'; active_assertions: BackendAssertion[]; inactive_assertions: BackendAssertion[]; proposals: BackendProposal[] }
  | { type: 'result.updated'; result: BackendResult }
  | { type: 'warning.created' | 'warning.updated' | 'warning.retracted'; warning: BackendWarning }
  | { type: 'result.processing'; turn_id: string; speaker: string }
  | { type: 'processing.error'; detail: string }
  | { type: 'event.duplicate'; event_id: string };

export class EncounterSocket {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retryMs = 500;
  private eventCounter = 0;

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

  send(payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  nextEventId(): string {
    this.eventCounter += 1;
    return `ui-${this.encounterId}-${this.eventCounter}-${Date.now()}`;
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}
