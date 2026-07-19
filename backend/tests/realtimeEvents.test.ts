/**
 * Realtime event routing and provider-relay protocol tests.
 */
import { describe, expect, it } from 'vitest';

import { defaultSettings } from '../src/config.ts';
import { EventType, activeWarnings } from '../src/models.ts';
import { SerializedAudioIngress } from '../src/server.ts';
import {
  ProviderRelay,
  RealtimeProviderError,
  RealtimeSessionError,
  RelaySupervisor,
  mintClientSecret,
  type ProviderSocket,
  type RelayItemFailure,
  type RelayState,
} from '../src/realtimeSession.ts';
import { makeService, say } from './helpers.ts';

const liveSettings = defaultSettings({ openai_api_key: 'sk-test' });
const sessionUpdated = JSON.stringify({
  type: 'session.updated',
  session: {
    type: 'transcription',
    audio: { input: { transcription: { model: 'gpt-realtime-whisper', language: 'en' } } },
  },
});

/** Fake provider socket for relay tests. */
class FakeProviderSocket implements ProviderSocket {
  private listeners = new Map<string, Array<(arg?: unknown) => void>>();
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }

  on(event: string, listener: (arg?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function connectRelay(relay: ProviderRelay, socket: FakeProviderSocket): Promise<void> {
  const connecting = relay.connect(async () => socket);
  await tick();
  socket.emit('message', sessionUpdated);
  await connecting;
}

describe('realtime events', () => {
  it('never updates the graph from partial deltas', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await service.startSession(rt);
    const versionBefore = rt.snapshot.version;
    service.recordPartial(rt, 'I use the combined pill and take carbamazepine', 'patient');
    expect(rt.snapshot.version).toBe(versionBefore);
    expect(rt.snapshot.assertions).toEqual([]);
    expect(activeWarnings(rt.snapshot)).toEqual([]);
    expect(rt.snapshot.result_state).toBe('LISTENING');
  });

  it('does not store partials by default', () => {
    const service = makeService();
    const rt = service.createEncounter();
    service.recordPartial(rt, 'I use the combined pill', 'patient');
    expect(service.settings.store_transcripts).toBe(false);
    expect(rt.store.eventsOf(EventType.TRANSCRIPT_PARTIAL_RECEIVED)).toEqual([]);
  });

  it('stops processing after stop-listening', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await service.startSession(rt);
    await service.stopSession(rt);
    const snap = await say(service, rt, 'I use the combined pill and take carbamazepine.');
    expect(snap.turns).toEqual([]);
    expect(activeWarnings(snap)).toEqual([]);
  });

  it('records speaker changes', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await service.changeSpeaker(rt, 'doctor');
    expect(rt.active_speaker).toBe('doctor');
    expect(rt.store.eventsOf(EventType.SPEAKER_CHANGED)).toHaveLength(1);
  });

  it('preserves an acoustic source speaker label as transcript provenance only', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    const snapshot = await service.processFinalTurn(rt, {
      event_id: 'evt-diarized-speaker',
      text: 'I take carbamazepine.',
      speaker: 'patient',
      source_speaker_label: 'speaker_0',
    });

    expect(snapshot.turns[0].source_speaker_label).toBe('speaker_0');
    expect(rt.store.eventsOf(EventType.TRANSCRIPT_FINAL_RECEIVED)[0].payload.turn).toMatchObject({
      source_speaker_label: 'speaker_0',
    });
  });
});

describe('provider relay protocol', () => {
  it('uses the current 24 kHz transcription schema and waits for session.updated', async () => {
    const socket = new FakeProviderSocket();
    const relay = new ProviderRelay(liveSettings, null, null, { readyTimeoutMs: 100 });
    let ready = false;
    const connecting = relay.connect(async () => socket).then(() => {
      ready = true;
    });
    await tick();

    expect(ready).toBe(false);
    expect(socket.sent).toHaveLength(1);
    const update = JSON.parse(socket.sent[0]);
    expect(update).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-realtime-whisper', language: 'en' },
            turn_detection: null,
          },
        },
      },
    });

    socket.emit('message', sessionUpdated);
    await connecting;
    expect(ready).toBe(true);
    expect(relay.ready).toBe(true);
  });

  it('propagates provider errors while session setup is pending', async () => {
    const socket = new FakeProviderSocket();
    const relay = new ProviderRelay(liveSettings, null, null, { readyTimeoutMs: 100 });
    const connecting = relay.connect(async () => socket);
    await tick();
    socket.emit(
      'message',
      JSON.stringify({
        type: 'error',
        error: { code: 'invalid_value', message: 'bad session update', param: 'type' },
      }),
    );
    await expect(connecting).rejects.toMatchObject({
      name: 'RealtimeProviderError',
      code: 'invalid_value',
      param: 'type',
    });
  });

  it('keeps provider turn detection disabled for model overrides', async () => {
    const socket = new FakeProviderSocket();
    const settings = defaultSettings({
      openai_api_key: 'sk-test',
      transcription_model: 'gpt-4o-mini-transcribe',
    });
    const relay = new ProviderRelay(settings, null, null, { readyTimeoutMs: 100 });
    const connecting = relay.connect(async () => socket);
    await tick();

    expect(JSON.parse(socket.sent[0]).session.audio.input.turn_detection).toBeNull();
    socket.emit(
      'message',
      JSON.stringify({
        type: 'session.updated',
        session: { audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } } },
      }),
    );
    await connecting;
  });

  it('accumulates deltas per item and finalizes out-of-order completions in commit order', async () => {
    const socket = new FakeProviderSocket();
    const partials: string[] = [];
    const finals: Array<[string | null, string, number | null]> = [];
    const relay = new ProviderRelay(
      liveSettings,
      (text) => {
        partials.push(text);
      },
      (itemId, text, ordinal) => {
        finals.push([itemId, text, ordinal]);
      },
    );
    await connectRelay(relay, socket);

    await relay.sendAudio(Buffer.from([1, 2]));
    expect(await relay.commit()).toEqual({ committed: true, commitOrdinal: 1 });
    await relay.sendAudio(Buffer.from([3, 4]));
    expect(await relay.commit()).toEqual({ committed: true, commitOrdinal: 2 });

    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_1' }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_2' }));
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_1',
        delta: 'I take ',
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_1',
        delta: 'Tegretol.',
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_2',
        transcript: 'I use the combined pill.',
      }),
    );
    await tick();
    expect(partials).toEqual(['I take ', 'I take Tegretol.']);
    expect(finals).toEqual([]);

    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'I take Tegretol.',
      }),
    );
    await tick();
    expect(finals).toEqual([
      ['item_1', 'I take Tegretol.', 1],
      ['item_2', 'I use the combined pill.', 2],
    ]);
  });

  it('commits and drains only after the matching final callback completes', async () => {
    const socket = new FakeProviderSocket();
    const finals: string[] = [];
    const relay = new ProviderRelay(liveSettings, null, async (_itemId, text) => {
      await tick();
      finals.push(text);
    });
    await connectRelay(relay, socket);
    await relay.sendAudio(Buffer.from([1, 2, 3, 4]));

    const draining = relay.commitAndWait(250);
    await tick();
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_7' }));
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_7',
        transcript: 'Final words.',
      }),
    );

    await expect(draining).resolves.toEqual({
      committed: true,
      commitOrdinal: 1,
      completed: true,
      timedOut: false,
    });
    expect(finals).toEqual(['Final words.']);
    expect(socket.sent.map((message) => JSON.parse(message).type)).toContain('input_audio_buffer.commit');
  });

  it('advances past a failed first item and drains after the second item completes', async () => {
    const socket = new FakeProviderSocket();
    const finals: Array<[string | null, string, number | null]> = [];
    const failures: RelayItemFailure[] = [];
    const relay = new ProviderRelay(
      liveSettings,
      null,
      (itemId, text, ordinal) => {
        finals.push([itemId, text, ordinal]);
      },
      {
        onItemFailure: (failure) => {
          failures.push(failure);
        },
      },
    );
    await connectRelay(relay, socket);
    await relay.sendAudio(Buffer.from([1]));
    await relay.commit();
    await relay.sendAudio(Buffer.from([2]));
    await relay.commit();
    const draining = relay.commitAndWait(500);

    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_1' }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_2' }));
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_1',
        delta: 'partial text',
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'item_1',
        error: { code: 'audio_unintelligible', message: 'not included in callback' },
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_2',
        transcript: 'Second turn.',
      }),
    );

    await expect(draining).resolves.toMatchObject({ completed: true, timedOut: false, commitOrdinal: 2 });
    expect(failures).toEqual([
      {
        stage: 'transcription',
        itemId: 'item_1',
        commitOrdinal: 1,
        code: 'audio_unintelligible',
      },
    ]);
    expect(finals).toEqual([['item_2', 'Second turn.', 2]]);
    expect(relay.diagnostics()).toMatchObject({
      provider_partial_items: 0,
      provider_completed_commits: 1,
      provider_failed_commits: 1,
      provider_settled_commits: 2,
      provider_pending_commits: 0,
    });
  });

  it('keeps ingesting provider events while ordered downstream processing is slow or fails', async () => {
    const socket = new FakeProviderSocket();
    const finals: string[] = [];
    const failures: RelayItemFailure[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const relay = new ProviderRelay(
      liveSettings,
      null,
      async (itemId, text) => {
        if (itemId === 'item_1') {
          await firstGate;
          throw new Error('downstream failed');
        }
        finals.push(text);
      },
      {
        onItemFailure: (failure) => {
          failures.push(failure);
        },
      },
    );
    await connectRelay(relay, socket);
    await relay.sendAudio(Buffer.from([1]));
    await relay.commit();
    await relay.sendAudio(Buffer.from([2]));
    await relay.commit();
    const draining = relay.commitAndWait(500);

    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_1' }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item_2' }));
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'First turn.',
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_2',
        transcript: 'Second turn.',
      }),
    );
    await tick();

    expect(relay.diagnostics()).toMatchObject({
      provider_received_settlements: 2,
      provider_settled_commits: 0,
    });
    releaseFirst();
    await expect(draining).resolves.toMatchObject({ completed: true, timedOut: false });
    expect(finals).toEqual(['Second turn.']);
    expect(failures).toEqual([
      {
        stage: 'processing',
        itemId: 'item_1',
        commitOrdinal: 1,
        code: 'Error',
      },
    ]);
    expect(relay.diagnostics()).toMatchObject({
      provider_completed_commits: 2,
      provider_processing_failed_commits: 1,
      provider_settled_commits: 2,
    });
  });

  it('requires an API key for the relay', async () => {
    const relay = new ProviderRelay(defaultSettings({ openai_api_key: null }), null, null);
    await expect(relay.connect(async () => ({}) as never)).rejects.toThrow(RealtimeSessionError);
  });

  it('requires an API key to mint a client secret', async () => {
    await expect(mintClientSecret(defaultSettings({ openai_api_key: null }))).rejects.toThrow(
      RealtimeSessionError,
    );
  });

  it('classifies provider protocol errors separately from transport failures', async () => {
    const relay = new ProviderRelay(liveSettings, null, null);
    await expect(
      relay.handleProviderEvent(
        JSON.stringify({ type: 'error', error: { code: 'unsupported', message: 'unsupported option' } }),
      ),
    ).rejects.toBeInstanceOf(RealtimeProviderError);
  });
});

describe('serialized audio ingress', () => {
  it('preserves append and commit ordering when tasks arrive in one tick', async () => {
    const order: string[] = [];
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const ingress = new SerializedAudioIngress((error) => {
      throw error;
    });

    ingress.enqueue(async () => {
      order.push('append:start');
      await appendGate;
      order.push('append:end');
    });
    ingress.enqueue(() => {
      order.push('commit');
    });
    ingress.enqueue(() => {
      order.push('next-append');
    });
    await tick();
    expect(order).toEqual(['append:start']);

    releaseAppend();
    await ingress.idle();
    expect(order).toEqual(['append:start', 'append:end', 'commit', 'next-append']);
  });
});

describe('relay supervision', () => {
  it('reconnects when the provider closes the socket mid-session', async () => {
    const sockets: FakeProviderSocket[] = [];
    const connect = async (): Promise<ProviderSocket> => {
      const socket = new FakeProviderSocket();
      sockets.push(socket);
      setImmediate(() => socket.emit('message', sessionUpdated));
      return socket;
    };
    const states: RelayState[] = [];
    const supervisor = new RelaySupervisor(liveSettings, null, null, {
      backoffMs: 1,
      readyTimeoutMs: 100,
      sleep: async () => {},
      onStateChange: (state) => states.push(state),
    });
    const done = supervisor.run(connect);
    await tick();
    expect(sockets).toHaveLength(1);

    sockets[0].emit('close');
    await tick();
    expect(sockets).toHaveLength(2);
    expect(supervisor.reconnects).toBe(1);
    expect(states).toContain('reconnecting');

    await supervisor.stop();
    await done;
    expect(states[states.length - 1]).toBe('closed');
    expect(states.filter((state) => state === 'connected')).toHaveLength(2);
  });

  it('buffers startup audio up to a bound, counts eviction, and flushes after readiness', async () => {
    const socket = new FakeProviderSocket();
    const supervisor = new RelaySupervisor(liveSettings, null, null, {
      maxBufferedAudioBytes: 4,
      readyTimeoutMs: 100,
    });

    await supervisor.sendAudio(Buffer.from([1, 2, 3]));
    await supervisor.sendAudio(Buffer.from([4, 5, 6]));
    expect(supervisor.diagnostics()).toMatchObject({
      buffered_audio_frames: 1,
      buffered_audio_bytes: 3,
      dropped_audio_frames: 1,
      dropped_audio_bytes: 3,
    });

    const done = supervisor.run(async () => socket);
    await tick();
    socket.emit('message', sessionUpdated);
    await tick();
    const appends = socket.sent.map((message) => JSON.parse(message)).filter((message) => message.type === 'input_audio_buffer.append');
    expect(appends).toHaveLength(1);
    expect(Buffer.from(appends[0].audio, 'base64')).toEqual(Buffer.from([4, 5, 6]));
    expect(supervisor.diagnostics()).toMatchObject({
      buffered_audio_frames: 0,
      sent_audio_frames: 1,
      dropped_audio_frames: 1,
      provider_ready: true,
    });

    await supervisor.stop();
    await done;
  });

  it('gives up after the reconnect budget is exhausted', async () => {
    const states: RelayState[] = [];
    const supervisor = new RelaySupervisor(liveSettings, null, null, {
      maxAttempts: 2,
      backoffMs: 1,
      readyTimeoutMs: 10,
      sleep: async () => {},
      onStateChange: (state) => states.push(state),
    });
    const failingConnect = async (): Promise<ProviderSocket> => {
      throw new Error('network down');
    };
    await expect(supervisor.run(failingConnect)).rejects.toThrow('network down');
    expect(states[states.length - 1]).toBe('gave_up');
  });
});
