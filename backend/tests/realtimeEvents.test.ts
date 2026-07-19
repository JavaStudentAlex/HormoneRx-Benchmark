/**
 * Realtime event-routing tests (spec §27.6): partials never touch the graph,
 * provider relay parsing, stop semantics.
 */
import { describe, expect, it } from 'vitest';

import { defaultSettings } from '../src/config.ts';
import { EventType, activeWarnings } from '../src/models.ts';
import {
  ProviderRelay,
  RealtimeSessionError,
  RelaySupervisor,
  mintClientSecret,
  type ProviderSocket,
  type RelayState,
} from '../src/realtimeSession.ts';
import { makeService, say } from './helpers.ts';

describe('realtime events', () => {
  it('never updates the graph from partial deltas', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await service.startSession(rt);
    const versionBefore = rt.snapshot.version;
    // A partial containing a full positive pair must not create anything.
    service.recordPartial(rt, 'I use the combined pill and take carbamazepine', 'patient');
    expect(rt.snapshot.version).toBe(versionBefore);
    expect(rt.snapshot.assertions).toEqual([]);
    expect(activeWarnings(rt.snapshot)).toEqual([]);
    expect(rt.snapshot.result_state).toBe('LISTENING');
  });

  it('does not store partials by default', async () => {
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

  it('routes provider delta and completed events', async () => {
    const partials: string[] = [];
    const finals: Array<[string | null, string]> = [];

    const relay = new ProviderRelay(
      defaultSettings(),
      (text) => {
        partials.push(text);
      },
      (itemId, text) => {
        finals.push([itemId, text]);
      },
    );
    await relay.handleProviderEvent(
      JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'I take ' }),
    );
    await relay.handleProviderEvent(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_7',
        transcript: 'I take Tegretol.',
      }),
    );
    expect(partials).toEqual(['I take ']);
    expect(finals).toEqual([['item_7', 'I take Tegretol.']]);
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
});

/** Fake provider socket for supervised-relay tests. */
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
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('relay supervision (long-session reconnect)', () => {
  const liveSettings = defaultSettings({ openai_api_key: 'sk-test' });

  it('reconnects when the provider closes the socket mid-session', async () => {
    const sockets: FakeProviderSocket[] = [];
    const connect = async (): Promise<ProviderSocket> => {
      const s = new FakeProviderSocket();
      sockets.push(s);
      return s;
    };
    const states: RelayState[] = [];
    const supervisor = new RelaySupervisor(liveSettings, null, null, {
      backoffMs: 1,
      sleep: async () => {},
      onStateChange: (state) => states.push(state),
    });
    const done = supervisor.run(connect);
    await tick();
    expect(sockets).toHaveLength(1);

    sockets[0].emit('close'); // provider drops the session
    await tick();
    expect(sockets).toHaveLength(2); // reconnected
    expect(supervisor.reconnects).toBe(1);
    expect(states).toContain('reconnecting');

    await supervisor.stop();
    await done;
    expect(states[states.length - 1]).toBe('closed');
    expect(states.filter((s) => s === 'connected')).toHaveLength(2);
  });

  it('drops (and counts) audio sent while disconnected instead of pretending', async () => {
    const supervisor = new RelaySupervisor(liveSettings, null, null, {});
    await supervisor.sendAudio(Buffer.from([1, 2, 3]));
    expect(supervisor.droppedAudioFrames).toBe(1);
  });

  it('gives up after the reconnect budget is exhausted', async () => {
    const states: RelayState[] = [];
    const supervisor = new RelaySupervisor(liveSettings, null, null, {
      maxAttempts: 2,
      backoffMs: 1,
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
