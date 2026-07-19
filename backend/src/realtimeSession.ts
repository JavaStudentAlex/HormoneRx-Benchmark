/**
 * Realtime transcription credentials and server-side relay support.
 *
 * The browser never sees the standard API key. For the preferred WebRTC
 * architecture the backend mints an ephemeral client secret; for the fallback
 * architecture the browser streams PCM16 audio over our own WebSocket and this
 * module relays it to the provider's realtime endpoint server-side.
 *
 * NOTE (honest status): this module cannot be exercised in an environment
 * without an OPENAI_API_KEY and a microphone; it is covered by unit tests with
 * fake transports and must be smoke-tested against the real API before a live
 * demo. See MORNING_REVIEW.md.
 */
import WebSocket from 'ws';

import { Settings } from './config.ts';

export class RealtimeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeSessionError';
  }
}

/** Mint an ephemeral realtime client secret for browser WebRTC use. */
export async function mintClientSecret(settings: Settings): Promise<Record<string, unknown>> {
  if (!settings.openai_api_key) {
    throw new RealtimeSessionError('OPENAI_API_KEY is not configured on the server');
  }
  const sessionConfig = {
    session: {
      type: 'transcription',
      audio: {
        input: {
          transcription: {
            model: settings.transcription_model,
            language: settings.transcription_language,
          },
          turn_detection: { type: 'server_vad' },
        },
      },
    },
  };
  const response = await fetch(`${settings.openai_base_url}/realtime/client_secrets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.openai_api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(sessionConfig),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status >= 400) {
    const text = await response.text();
    console.error(`client secret mint failed: ${response.status} ${text.slice(0, 500)}`);
    throw new RealtimeSessionError(`provider returned ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, any>;
  // Return only what the browser needs; never the server key.
  return {
    client_secret: payload.value ?? payload.client_secret?.value,
    expires_at: payload.expires_at ?? payload.client_secret?.expires_at,
    model: settings.transcription_model,
  };
}

/** Minimal provider-socket contract so tests can inject a fake transport. */
export interface ProviderSocket {
  send(data: string): void | Promise<void>;
  close(): void | Promise<void>;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close' | 'error', listener: (arg?: unknown) => void): void;
}

export type ProviderConnect = (url: string, headers: Record<string, string>) => Promise<ProviderSocket>;

async function defaultConnect(url: string, headers: Record<string, string>): Promise<ProviderSocket> {
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws as unknown as ProviderSocket;
}

/**
 * Server-side relay: our WebSocket audio frames -> provider realtime WS.
 *
 * Transport is injected so tests can drive the relay with fake provider events.
 */
export class ProviderRelay {
  private providerWs: ProviderSocket | null = null;

  constructor(
    private settings: Settings,
    private onPartial: ((text: string) => void | Promise<void>) | null,
    private onFinal: ((itemId: string | null, text: string) => void | Promise<void>) | null,
  ) {}

  async connect(connectImpl?: ProviderConnect): Promise<void> {
    if (!this.settings.openai_api_key) {
      throw new RealtimeSessionError('OPENAI_API_KEY is not configured on the server');
    }
    const connect = connectImpl ?? defaultConnect;
    const url = this.settings.openai_base_url.replace('https://', 'wss://') + '/realtime?intent=transcription';
    this.providerWs = await connect(url, { Authorization: `Bearer ${this.settings.openai_api_key}` });
    await this.providerWs.send(
      JSON.stringify({
        type: 'transcription_session.update',
        session: {
          input_audio_transcription: {
            model: this.settings.transcription_model,
            language: this.settings.transcription_language,
          },
          turn_detection: { type: 'server_vad' },
        },
      }),
    );
  }

  async sendAudio(pcm16: Buffer | Uint8Array): Promise<void> {
    if (!this.providerWs) {
      throw new RealtimeSessionError('relay not connected');
    }
    await this.providerWs.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(pcm16).toString('base64'),
      }),
    );
  }

  async handleProviderEvent(raw: string): Promise<void> {
    const event = JSON.parse(raw) as { type?: string; delta?: string; item_id?: string; transcript?: string };
    const eventType = event.type ?? '';
    if (eventType.endsWith('input_audio_transcription.delta')) {
      await this.onPartial?.(event.delta ?? '');
    } else if (eventType.endsWith('input_audio_transcription.completed')) {
      await this.onFinal?.(event.item_id ?? null, event.transcript ?? '');
    }
  }

  /** Consume provider events until the provider socket closes. */
  pump(): Promise<void> {
    if (!this.providerWs) {
      return Promise.reject(new RealtimeSessionError('relay not connected'));
    }
    const ws = this.providerWs;
    return new Promise<void>((resolve) => {
      ws.on('message', (data: unknown) => {
        void this.handleProviderEvent(String(data));
      });
      ws.on('close', () => resolve());
      ws.on('error', () => resolve());
    });
  }

  async close(): Promise<void> {
    if (this.providerWs) {
      await this.providerWs.close();
      this.providerWs = null;
    }
  }
}
