/**
 * Realtime transcription credentials and server-side relay support.
 *
 * The browser sends 24 kHz PCM16 audio to this server. The server owns the
 * provider connection, waits for the provider to acknowledge the transcription
 * session, and only then forwards buffered audio. Raw audio and transcript text
 * are deliberately absent from diagnostics.
 */
import WebSocket from 'ws';

import { Settings } from './config.ts';

const PCM_SAMPLE_RATE = 24_000;
const PCM_BYTES_PER_SAMPLE = 2;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_BUFFER_BYTES = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * 5;

export class RealtimeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeSessionError';
  }
}

export class RealtimeProviderError extends RealtimeSessionError {
  constructor(
    message: string,
    public code: string | null = null,
    public param: string | null = null,
  ) {
    super(message);
    this.name = 'RealtimeProviderError';
  }
}

function transcriptionSession(settings: Settings): Record<string, unknown> {
  return {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: PCM_SAMPLE_RATE },
        transcription: {
          model: settings.transcription_model,
          language: settings.transcription_language,
        },
        // The browser owns speech-boundary detection and sends explicit commit
        // controls. Enabling provider VAD as well would double-commit buffers.
        turn_detection: null,
      },
    },
  };
}

/** Mint an ephemeral realtime client secret for browser WebRTC use. */
export async function mintClientSecret(settings: Settings): Promise<Record<string, unknown>> {
  if (!settings.openai_api_key) {
    throw new RealtimeSessionError('OPENAI_API_KEY is not configured on the server');
  }
  const response = await fetch(`${settings.openai_base_url}/realtime/client_secrets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.openai_api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session: transcriptionSession(settings) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status >= 400) {
    const text = await response.text();
    console.error(`client secret mint failed: ${response.status} ${text.slice(0, 500)}`);
    throw new RealtimeSessionError(`provider returned ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, any>;
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

interface ProviderEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  transcript?: string;
  session?: {
    audio?: { input?: { transcription?: { model?: string } | null } };
  };
  error?: {
    type?: string;
    code?: string;
    message?: string;
    param?: string;
  };
}

interface CompletionWaiter {
  targetOrdinal: number;
  resolve: (completed: boolean) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ItemSettlement =
  | { status: 'completed'; itemId: string | null; transcript: string }
  | { status: 'failed'; itemId: string | null; code: string | null };

export interface RelayItemFailure {
  stage: 'transcription' | 'processing';
  itemId: string | null;
  commitOrdinal: number;
  code: string | null;
}

export interface CommitResult {
  committed: boolean;
  commitOrdinal: number | null;
}

export interface DrainResult extends CommitResult {
  completed: boolean;
  timedOut: boolean;
}

/**
 * One provider connection. Message listeners are attached before session.update
 * is sent, so a fast session.updated acknowledgement cannot be missed.
 */
export class ProviderRelay {
  private providerWs: ProviderSocket | null = null;
  private readyAcknowledged = false;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private terminalError: Error | null = null;
  private terminalClosed = false;
  private pumpWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private sendTail: Promise<void> = Promise.resolve();
  private eventTail: Promise<void> = Promise.resolve();
  private audioPending = false;

  private partialsByItem = new Map<string, string>();
  private commitCount = 0;
  private nextScheduledOrdinal = 1;
  private nextProcessedOrdinal = 1;
  private finalizationTail: Promise<void> = Promise.resolve();
  private completedCommitCount = 0;
  private failedCommitCount = 0;
  private processingFailedCommitCount = 0;
  private unmappedCommitOrdinals: number[] = [];
  private ordinalByItem = new Map<string, number>();
  private settlementsByOrdinal = new Map<number, ItemSettlement>();
  private settlementsBeforeMapping = new Map<string, ItemSettlement>();
  private completionWaiters: CompletionWaiter[] = [];

  constructor(
    private settings: Settings,
    private onPartial: ((text: string) => void | Promise<void>) | null,
    private onFinal: (
      (itemId: string | null, text: string, commitOrdinal: number | null) => void | Promise<void>
    ) | null,
    private options: {
      readyTimeoutMs?: number;
      onItemFailure?: (failure: RelayItemFailure) => void | Promise<void>;
    } = {},
  ) {}

  get ready(): boolean {
    return this.readyAcknowledged && !this.terminalError && !this.terminalClosed;
  }

  diagnostics(): Record<string, number | boolean> {
    return {
      provider_ready: this.ready,
      provider_commits: this.commitCount,
      provider_completed_commits: this.completedCommitCount,
      provider_failed_commits: this.failedCommitCount,
      provider_processing_failed_commits: this.processingFailedCommitCount,
      provider_received_settlements: this.nextScheduledOrdinal - 1,
      provider_settled_commits: this.nextProcessedOrdinal - 1,
      provider_pending_commits: Math.max(0, this.commitCount - this.nextProcessedOrdinal + 1),
      provider_partial_items: this.partialsByItem.size,
    };
  }

  async connect(connectImpl?: ProviderConnect): Promise<void> {
    if (!this.settings.openai_api_key) {
      throw new RealtimeSessionError('OPENAI_API_KEY is not configured on the server');
    }
    const connect = connectImpl ?? defaultConnect;
    const url = this.settings.openai_base_url.replace('https://', 'wss://') + '/realtime?intent=transcription';
    const ws = await connect(url, { Authorization: `Bearer ${this.settings.openai_api_key}` });
    this.providerWs = ws;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    ws.on('message', (data: unknown) => {
      const handling = this.eventTail.then(() => this.handleProviderEvent(String(data)));
      this.eventTail = handling.catch(() => undefined);
      void handling.catch((error) => this.fail(this.normalizeError(error, 'provider event handling failed')));
    });
    ws.on('close', () => this.markClosed());
    ws.on('error', (error?: unknown) => {
      this.fail(this.normalizeError(error, 'provider socket error'));
    });

    const readyTimeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await ws.send(
        JSON.stringify({
          type: 'session.update',
          session: transcriptionSession(this.settings),
        }),
      );
      await Promise.race([
        this.readyPromise,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RealtimeSessionError(`provider session.updated timeout after ${readyTimeoutMs} ms`)),
            readyTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      const normalized = this.normalizeError(error, 'provider session setup failed');
      this.fail(normalized);
      throw normalized;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async sendAudio(pcm16: Buffer | Uint8Array): Promise<void> {
    const audio = Buffer.from(pcm16);
    if (!audio.byteLength) return;
    await this.enqueueProviderOperation(async (ws) => {
      await ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: audio.toString('base64'),
        }),
      );
      this.audioPending = true;
    });
  }

  async commit(): Promise<CommitResult> {
    return this.enqueueProviderOperation(async (ws) => {
      if (!this.audioPending) {
        return { committed: false, commitOrdinal: this.commitCount || null };
      }
      const commitOrdinal = ++this.commitCount;
      this.unmappedCommitOrdinals.push(commitOrdinal);
      try {
        await ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      } catch (error) {
        this.unmappedCommitOrdinals = this.unmappedCommitOrdinals.filter((value) => value !== commitOrdinal);
        this.commitCount -= 1;
        throw error;
      }
      this.audioPending = false;
      return { committed: true, commitOrdinal };
    });
  }

  async commitAndWait(timeoutMs: number): Promise<DrainResult> {
    const commit = await this.commit();
    const targetOrdinal = commit.commitOrdinal;
    if (targetOrdinal === null) {
      return { ...commit, completed: false, timedOut: false };
    }
    const completed = await this.waitForCompletion(targetOrdinal, timeoutMs);
    return { ...commit, completed, timedOut: !completed };
  }

  async handleProviderEvent(raw: string): Promise<void> {
    let event: ProviderEvent;
    try {
      event = JSON.parse(raw) as ProviderEvent;
    } catch {
      throw new RealtimeSessionError('provider returned malformed JSON');
    }
    const eventType = event.type ?? '';

    if (eventType === 'error') {
      const code = event.error?.code ?? null;
      const param = event.error?.param ?? null;
      const message = (event.error?.message ?? 'provider rejected the realtime request').slice(0, 500);
      throw new RealtimeProviderError(`provider error${code ? ` (${code})` : ''}: ${message}`, code, param);
    }

    if (eventType === 'session.updated') {
      const model = event.session?.audio?.input?.transcription?.model;
      if (!model) {
        throw new RealtimeProviderError('provider acknowledged a session without transcription enabled');
      }
      this.readyAcknowledged = true;
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }

    if (eventType.endsWith('input_audio_buffer.committed')) {
      this.mapCommittedItem(event.item_id ?? null);
      this.scheduleSettlementsInOrder();
      return;
    }

    if (eventType.endsWith('input_audio_transcription.delta')) {
      const itemKey = event.item_id ?? '__unknown_item__';
      const cumulative = (this.partialsByItem.get(itemKey) ?? '') + (event.delta ?? '');
      this.partialsByItem.set(itemKey, cumulative);
      await this.onPartial?.(cumulative);
      return;
    }

    if (eventType.endsWith('input_audio_transcription.failed')) {
      const itemId = event.item_id ?? null;
      const itemKey = itemId ?? '__unknown_item__';
      this.partialsByItem.delete(itemKey);
      const settlement: ItemSettlement = {
        status: 'failed',
        itemId,
        code: event.error?.code ?? event.error?.type ?? null,
      };
      this.storeSettlement(itemId, settlement);
      this.scheduleSettlementsInOrder();
      return;
    }

    if (eventType.endsWith('input_audio_transcription.completed')) {
      const itemId = event.item_id ?? null;
      const itemKey = itemId ?? '__unknown_item__';
      const transcript = event.transcript ?? this.partialsByItem.get(itemKey) ?? '';
      this.partialsByItem.delete(itemKey);

      this.storeSettlement(itemId, { status: 'completed', itemId, transcript });
      this.scheduleSettlementsInOrder();
    }
  }

  /** Provider messages are consumed from connect() onward; pump waits for termination. */
  pump(): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.terminalClosed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.pumpWaiters.push({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    const ws = this.providerWs;
    this.providerWs = null;
    if (ws) await ws.close();
  }

  private mapCommittedItem(itemId: string | null): void {
    if (!itemId || this.ordinalByItem.has(itemId)) return;
    const ordinal = this.unmappedCommitOrdinals.shift();
    if (ordinal === undefined) return;
    this.ordinalByItem.set(itemId, ordinal);
    const earlySettlement = this.settlementsBeforeMapping.get(itemId);
    if (earlySettlement !== undefined) {
      this.settlementsBeforeMapping.delete(itemId);
      this.settlementsByOrdinal.set(ordinal, earlySettlement);
    }
  }

  private storeSettlement(itemId: string | null, settlement: ItemSettlement): void {
    let ordinal = itemId ? this.ordinalByItem.get(itemId) : undefined;
    // With exactly one unmapped commit the item mapping is unambiguous even if
    // the intermediary committed event was lost or delayed.
    if (ordinal === undefined && itemId && this.unmappedCommitOrdinals.length === 1) {
      this.mapCommittedItem(itemId);
      ordinal = this.ordinalByItem.get(itemId);
    }
    if (ordinal === undefined) {
      if (itemId) this.settlementsBeforeMapping.set(itemId, settlement);
      return;
    }
    if (ordinal < this.nextScheduledOrdinal || this.settlementsByOrdinal.has(ordinal)) return;
    this.settlementsByOrdinal.set(ordinal, settlement);
  }

  private scheduleSettlementsInOrder(): void {
    while (this.settlementsByOrdinal.has(this.nextScheduledOrdinal)) {
      const ordinal = this.nextScheduledOrdinal;
      const settlement = this.settlementsByOrdinal.get(ordinal)!;
      this.settlementsByOrdinal.delete(ordinal);
      this.nextScheduledOrdinal += 1;
      this.finalizationTail = this.finalizationTail.then(() => this.finalizeSettlement(ordinal, settlement));
    }
  }

  private async finalizeSettlement(ordinal: number, settlement: ItemSettlement): Promise<void> {
    if (settlement.status === 'failed') {
      this.failedCommitCount += 1;
      await this.reportItemFailure({
        stage: 'transcription',
        itemId: settlement.itemId,
        commitOrdinal: ordinal,
        code: settlement.code,
      });
    } else {
      this.completedCommitCount += 1;
      try {
        await this.onFinal?.(settlement.itemId, settlement.transcript, ordinal);
      } catch (error) {
        this.processingFailedCommitCount += 1;
        await this.reportItemFailure({
          stage: 'processing',
          itemId: settlement.itemId,
          commitOrdinal: ordinal,
          code: error instanceof Error ? error.name : null,
        });
      }
    }
    this.nextProcessedOrdinal = ordinal + 1;
    this.resolveCompletionWaiters();
  }

  private async reportItemFailure(failure: RelayItemFailure): Promise<void> {
    try {
      await this.options.onItemFailure?.(failure);
    } catch {
      // Failure reporting must not stall later committed transcription items.
    }
  }

  private waitForCompletion(targetOrdinal: number, timeoutMs: number): Promise<boolean> {
    if (this.nextProcessedOrdinal > targetOrdinal) return Promise.resolve(true);
    const settlementWasScheduled = this.nextScheduledOrdinal > targetOrdinal;
    if (this.terminalError && !settlementWasScheduled) return Promise.reject(this.terminalError);
    if (this.terminalClosed && !settlementWasScheduled) {
      return Promise.reject(new RealtimeSessionError('provider closed before transcription completed'));
    }
    return new Promise<boolean>((resolve, reject) => {
      const waiter: CompletionWaiter = {
        targetOrdinal,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.completionWaiters = this.completionWaiters.filter((candidate) => candidate !== waiter);
          resolve(false);
        }, timeoutMs),
      };
      this.completionWaiters.push(waiter);
    });
  }

  private resolveCompletionWaiters(): void {
    const pending: CompletionWaiter[] = [];
    for (const waiter of this.completionWaiters) {
      if (this.nextProcessedOrdinal > waiter.targetOrdinal) {
        clearTimeout(waiter.timer);
        waiter.resolve(true);
      } else {
        pending.push(waiter);
      }
    }
    this.completionWaiters = pending;
  }

  private enqueueProviderOperation<T>(operation: (ws: ProviderSocket) => Promise<T>): Promise<T> {
    const result = this.sendTail.then(async () => {
      if (!this.ready || !this.providerWs) {
        throw this.terminalError ?? new RealtimeSessionError('relay is not ready');
      }
      return operation(this.providerWs);
    });
    this.sendTail = result.then(
      () => undefined,
      () => undefined,
    );
    void result.catch((error) => this.fail(this.normalizeError(error, 'provider send failed')));
    return result;
  }

  private fail(error: Error): void {
    if (this.terminalError || this.terminalClosed) return;
    this.terminalError = error;
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    for (const waiter of this.pumpWaiters.splice(0)) waiter.reject(error);
    this.rejectUnscheduledCompletionWaiters(error);
    try {
      void this.providerWs?.close();
    } catch {
      // Socket is already unusable; the stored provider error is authoritative.
    }
  }

  private markClosed(): void {
    if (this.terminalClosed) return;
    this.terminalClosed = true;
    if (!this.readyAcknowledged && !this.terminalError) {
      const error = new RealtimeSessionError('provider closed before session.updated');
      this.rejectReady?.(error);
      this.rejectReady = null;
      this.resolveReady = null;
    }
    for (const waiter of this.pumpWaiters.splice(0)) waiter.resolve();
    if (!this.terminalError) {
      const error = new RealtimeSessionError('provider closed before transcription completed');
      this.rejectUnscheduledCompletionWaiters(error);
    }
  }

  private rejectUnscheduledCompletionWaiters(error: Error): void {
    const scheduled: CompletionWaiter[] = [];
    for (const waiter of this.completionWaiters) {
      if (this.nextScheduledOrdinal > waiter.targetOrdinal) {
        scheduled.push(waiter);
      } else {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.completionWaiters = scheduled;
  }

  private normalizeError(error: unknown, fallback: string): Error {
    if (error instanceof RealtimeSessionError) return error;
    if (error instanceof Error) return new RealtimeSessionError(`${fallback}: ${error.message}`);
    return new RealtimeSessionError(fallback);
  }
}

export type RelayState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'gave_up';

export interface RelayDiagnostics {
  state: RelayState;
  reconnects: number;
  buffered_audio_frames: number;
  buffered_audio_bytes: number;
  max_buffered_audio_bytes: number;
  sent_audio_frames: number;
  sent_audio_bytes: number;
  dropped_audio_frames: number;
  dropped_audio_bytes: number;
  provider_ready: boolean;
  provider_commits: number;
  provider_completed_commits: number;
  provider_failed_commits: number;
  provider_processing_failed_commits: number;
  provider_received_settlements: number;
  provider_settled_commits: number;
  provider_pending_commits: number;
  provider_partial_items: number;
}

/**
 * Reconnect supervision plus bounded audio buffering. Frames received before
 * session.updated are retained up to maxBufferedAudioBytes, then oldest frames
 * are evicted and counted explicitly.
 */
export class RelaySupervisor {
  private relay: ProviderRelay | null = null;
  private stopped = false;
  private flushingBuffer = false;
  private state: RelayState = 'connecting';
  private bufferedAudio: Buffer[] = [];
  private bufferedAudioBytes = 0;
  private sentAudioFrames = 0;
  private sentAudioBytes = 0;
  private droppedAudioBytes = 0;
  private connectedWaiters: Array<{ resolve: (relay: ProviderRelay) => void; reject: (error: Error) => void }> = [];
  reconnects = 0;
  droppedAudioFrames = 0;

  constructor(
    private settings: Settings,
    private onPartial: ((text: string) => void | Promise<void>) | null,
    private onFinal: (
      (itemId: string | null, text: string, commitOrdinal: number | null) => void | Promise<void>
    ) | null,
    private options: {
      maxAttempts?: number;
      backoffMs?: number;
      readyTimeoutMs?: number;
      maxBufferedAudioBytes?: number;
      sleep?: (ms: number) => Promise<void>;
      onItemFailure?: (failure: RelayItemFailure) => void | Promise<void>;
      onStateChange?: (state: RelayState, detail: string, diagnostics: RelayDiagnostics) => void;
    } = {},
  ) {}

  diagnostics(): RelayDiagnostics {
    const provider = this.relay?.diagnostics() ?? {};
    return {
      state: this.state,
      reconnects: this.reconnects,
      buffered_audio_frames: this.bufferedAudio.length,
      buffered_audio_bytes: this.bufferedAudioBytes,
      max_buffered_audio_bytes: this.options.maxBufferedAudioBytes ?? DEFAULT_STARTUP_BUFFER_BYTES,
      sent_audio_frames: this.sentAudioFrames,
      sent_audio_bytes: this.sentAudioBytes,
      dropped_audio_frames: this.droppedAudioFrames,
      dropped_audio_bytes: this.droppedAudioBytes,
      provider_ready: Boolean(provider.provider_ready),
      provider_commits: Number(provider.provider_commits ?? 0),
      provider_completed_commits: Number(provider.provider_completed_commits ?? 0),
      provider_failed_commits: Number(provider.provider_failed_commits ?? 0),
      provider_processing_failed_commits: Number(provider.provider_processing_failed_commits ?? 0),
      provider_received_settlements: Number(provider.provider_received_settlements ?? 0),
      provider_settled_commits: Number(provider.provider_settled_commits ?? 0),
      provider_pending_commits: Number(provider.provider_pending_commits ?? 0),
      provider_partial_items: Number(provider.provider_partial_items ?? 0),
    };
  }

  private notify(state: RelayState, detail: string): void {
    this.state = state;
    this.options.onStateChange?.(state, detail, this.diagnostics());
    if (state === 'gave_up' || state === 'closed') {
      const error = new RealtimeSessionError(detail);
      for (const waiter of this.connectedWaiters.splice(0)) waiter.reject(error);
    }
  }

  async run(connectImpl?: ProviderConnect): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? 5;
    const backoffMs = this.options.backoffMs ?? 1000;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    let failures = 0;
    let hasConnected = false;

    while (!this.stopped) {
      const relay = new ProviderRelay(this.settings, this.onPartial, this.onFinal, {
        readyTimeoutMs: this.options.readyTimeoutMs,
        onItemFailure: this.options.onItemFailure,
      });
      this.notify(hasConnected || failures > 0 ? 'reconnecting' : 'connecting', `attempt ${failures + 1}`);
      try {
        await relay.connect(connectImpl);
      } catch (error) {
        failures += 1;
        const normalized =
          error instanceof RealtimeSessionError
            ? error
            : new RealtimeSessionError(
                error instanceof Error ? `provider connection failed: ${error.message}` : 'provider connection failed',
              );
        if (normalized instanceof RealtimeProviderError || failures >= maxAttempts || this.stopped) {
          this.notify('gave_up', normalized.message);
          throw normalized;
        }
        await sleep(backoffMs * 2 ** (failures - 1));
        continue;
      }

      if (this.stopped) {
        await relay.close();
        break;
      }
      this.relay = relay;
      if (hasConnected) this.reconnects += 1;
      hasConnected = true;
      failures = 0;
      try {
        await this.flushBufferedAudio(relay);
      } catch (error) {
        this.relay = null;
        const normalized =
          error instanceof RealtimeSessionError
            ? error
            : new RealtimeSessionError(
                error instanceof Error ? `provider buffer flush failed: ${error.message}` : 'provider buffer flush failed',
              );
        if (normalized instanceof RealtimeProviderError) {
          this.notify('gave_up', normalized.message);
          throw normalized;
        }
        this.notify('reconnecting', normalized.message);
        await sleep(backoffMs);
        continue;
      }
      this.notify('connected', 'provider session.updated acknowledged');
      for (const waiter of this.connectedWaiters.splice(0)) waiter.resolve(relay);

      try {
        await relay.pump();
      } catch (error) {
        this.relay = null;
        const normalized =
          error instanceof RealtimeSessionError
            ? error
            : new RealtimeSessionError(
                error instanceof Error ? `provider relay failed: ${error.message}` : 'provider relay failed',
              );
        if (normalized instanceof RealtimeProviderError) {
          this.notify('gave_up', normalized.message);
          throw normalized;
        }
        if (this.stopped) break;
        this.notify('reconnecting', normalized.message);
        await sleep(backoffMs);
        continue;
      }

      this.relay = null;
      if (this.stopped) break;
      if (this.reconnects >= maxAttempts) {
        this.notify('gave_up', `provider closed; reconnect budget (${maxAttempts}) exhausted`);
        return;
      }
      this.notify('reconnecting', 'provider closed the socket');
      await sleep(backoffMs);
    }
    this.notify('closed', 'relay stopped');
  }

  async sendAudio(pcm16: Buffer | Uint8Array): Promise<void> {
    const frame = Buffer.from(pcm16);
    if (!frame.byteLength) return;
    if (!this.relay || !this.relay.ready || this.flushingBuffer) {
      this.bufferAudio(frame);
      return;
    }
    await this.relay.sendAudio(frame);
    this.sentAudioFrames += 1;
    this.sentAudioBytes += frame.byteLength;
  }

  async commit(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<CommitResult> {
    const relay = await this.waitForConnectedRelay(timeoutMs);
    return relay.commit();
  }

  async commitAndWait(timeoutMs: number): Promise<DrainResult> {
    const startedAt = Date.now();
    const relay = await this.waitForConnectedRelay(timeoutMs);
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    return relay.commitAndWait(remainingMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.relay) {
      await this.relay.close();
      this.relay = null;
    } else {
      this.notify('closed', 'relay stopped');
    }
  }

  private bufferAudio(frame: Buffer): void {
    const maxBytes = this.options.maxBufferedAudioBytes ?? DEFAULT_STARTUP_BUFFER_BYTES;
    if (frame.byteLength > maxBytes) {
      this.droppedAudioFrames += 1;
      this.droppedAudioBytes += frame.byteLength;
      return;
    }
    while (this.bufferedAudio.length && this.bufferedAudioBytes + frame.byteLength > maxBytes) {
      const dropped = this.bufferedAudio.shift()!;
      this.bufferedAudioBytes -= dropped.byteLength;
      this.droppedAudioFrames += 1;
      this.droppedAudioBytes += dropped.byteLength;
    }
    this.bufferedAudio.push(frame);
    this.bufferedAudioBytes += frame.byteLength;
  }

  private async flushBufferedAudio(relay: ProviderRelay): Promise<void> {
    this.flushingBuffer = true;
    try {
      while (this.bufferedAudio.length) {
        const frame = this.bufferedAudio[0];
        await relay.sendAudio(frame);
        this.bufferedAudio.shift();
        this.bufferedAudioBytes -= frame.byteLength;
        this.sentAudioFrames += 1;
        this.sentAudioBytes += frame.byteLength;
      }
    } finally {
      this.flushingBuffer = false;
    }
  }

  private waitForConnectedRelay(timeoutMs: number): Promise<ProviderRelay> {
    if (this.relay?.ready && !this.flushingBuffer) return Promise.resolve(this.relay);
    if (this.stopped || this.state === 'gave_up' || this.state === 'closed') {
      return Promise.reject(new RealtimeSessionError(`relay is ${this.state}`));
    }
    return new Promise<ProviderRelay>((resolve, reject) => {
      let storedWaiter: { resolve: (relay: ProviderRelay) => void; reject: (error: Error) => void };
      const timer = setTimeout(() => {
        this.connectedWaiters = this.connectedWaiters.filter((candidate) => candidate !== storedWaiter);
        reject(new RealtimeSessionError(`relay readiness timeout after ${timeoutMs} ms`));
      }, timeoutMs);
      storedWaiter = {
        resolve: (relay) => {
          clearTimeout(timer);
          resolve(relay);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.connectedWaiters.push(storedWaiter);
    });
  }
}
