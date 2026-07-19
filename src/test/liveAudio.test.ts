import { describe, expect, it } from 'vitest';

import {
  MIN_COMMIT_AUDIO_MS,
  PcmFrameBatcher,
  SPEECH_END_SILENCE_MS,
  SpeechFrameGate,
  frameHasSpeech,
  silencePaddingForMinimum,
} from '../lib/audioCapture';
import { parseAudioServerEvent } from '../lib/backendClient';

const silence = () => new Int16Array(8);
const speech = () => new Int16Array(8).fill(1200);

describe('live audio framing', () => {
  it('batches arbitrary worklet chunks and flushes the final partial frame', () => {
    const batcher = new PcmFrameBatcher(4);
    expect(batcher.push(Int16Array.from([1, 2]))).toEqual([]);
    expect(batcher.push(Int16Array.from([3, 4, 5, 6, 7]))).toEqual([
      Int16Array.from([1, 2, 3, 4]),
    ]);
    expect(batcher.flush()).toEqual(Int16Array.from([5, 6, 7]));
    expect(batcher.flush()).toBeNull();
  });

  it('keeps bounded pre-roll, commits after sustained silence, and then gates silence', () => {
    const gate = new SpeechFrameGate(80, 160, 160);
    expect(gate.push(silence())).toEqual({ frames: [], utteranceEnded: false });

    const started = gate.push(speech());
    expect(started.frames).toHaveLength(2);
    expect(started.frames[0]).toEqual(silence());
    expect(started.frames[1]).toEqual(speech());
    expect(gate.hasPendingUtterance()).toBe(true);

    expect(gate.push(silence()).utteranceEnded).toBe(false);
    expect(gate.push(silence()).utteranceEnded).toBe(true);
    expect(gate.hasPendingUtterance()).toBe(false);
    expect(gate.pendingUtteranceSamples()).toBe(0);
    expect(gate.push(silence())).toEqual({ frames: [], utteranceEnded: false });
  });

  it('uses a 480 ms default speech boundary without splitting shorter pauses', () => {
    const gate = new SpeechFrameGate();
    gate.push(speech());
    const requiredFrames = SPEECH_END_SILENCE_MS / 80;
    for (let index = 1; index < requiredFrames; index++) {
      expect(gate.push(silence()).utteranceEnded).toBe(false);
    }
    expect(gate.push(silence()).utteranceEnded).toBe(true);
  });

  it('recognizes a single short speech frame as a pending utterance', () => {
    const gate = new SpeechFrameGate();
    expect(frameHasSpeech(speech())).toBe(true);
    expect(frameHasSpeech(new Int16Array(8).fill(200))).toBe(true);
    expect(frameHasSpeech(silence())).toBe(false);
    expect(gate.push(speech()).frames).toHaveLength(1);
    expect(gate.hasPendingUtterance()).toBe(true);
  });

  it('pads a short pending utterance to the commit minimum without padding silence-only input', () => {
    const minimumSamples = (24_000 * MIN_COMMIT_AUDIO_MS) / 1000;
    const shortFinalSpeech = new Int16Array(480).fill(1200);
    const gate = new SpeechFrameGate();

    expect(gate.push(shortFinalSpeech).frames).toEqual([shortFinalSpeech]);
    expect(gate.pendingUtteranceSamples()).toBe(480);
    const padding = gate.padPendingUtterance(minimumSamples);
    expect(padding).toHaveLength(2400);
    expect(padding?.every((sample) => sample === 0)).toBe(true);
    expect(gate.pendingUtteranceSamples()).toBe(minimumSamples);
    expect(gate.padPendingUtterance(minimumSamples)).toBeNull();

    const idleGate = new SpeechFrameGate();
    idleGate.push(silence());
    expect(idleGate.padPendingUtterance(minimumSamples)).toBeNull();
    expect(silencePaddingForMinimum(0, minimumSamples)).toBeNull();
  });

  it('forces buffered quiet audio only on an explicit finish and resets for the next turn', () => {
    const gate = new SpeechFrameGate(80, 160, 160);
    expect(gate.forceCurrentUtterance(12)).toEqual({ frames: [], shouldCommit: false });
    expect(gate.push(silence())).toEqual({ frames: [], utteranceEnded: false });

    const forcedIdle = gate.forceCurrentUtterance(12);
    expect(forcedIdle.shouldCommit).toBe(true);
    expect(forcedIdle.frames.reduce((total, frame) => total + frame.length, 0)).toBe(12);
    expect(gate.hasPendingUtterance()).toBe(false);

    gate.push(speech());
    const forcedSpeech = gate.forceCurrentUtterance(12);
    expect(forcedSpeech.shouldCommit).toBe(true);
    expect(forcedSpeech.frames).toEqual([new Int16Array(4)]);
    expect(gate.pendingUtteranceSamples()).toBe(0);
    expect(gate.push(speech()).frames).toEqual([speech()]);
  });
});

describe('audio WebSocket events', () => {
  it('parses relay readiness and drain diagnostics', () => {
    expect(
      parseAudioServerEvent(
        JSON.stringify({
          type: 'relay.state',
          state: 'connected',
          detail: 'provider socket open',
          diagnostics: { dropped_audio_frames: 0 },
        }),
      ),
    ).toMatchObject({ type: 'relay.state', state: 'connected' });

    expect(
      parseAudioServerEvent(
        JSON.stringify({
          type: 'audio.drained',
          committed: 2,
          completed: 2,
          timed_out: false,
          diagnostics: { buffered_frames: 0 },
        }),
      ),
    ).toMatchObject({ type: 'audio.drained', committed: 2, completed: 2, timed_out: false });
  });

  it('rejects malformed and unrelated frames', () => {
    expect(parseAudioServerEvent('not json')).toBeNull();
    expect(
      parseAudioServerEvent(JSON.stringify({ type: 'relay.state', state: 'mystery', detail: 'unknown' })),
    ).toBeNull();
    expect(parseAudioServerEvent(JSON.stringify({ type: 'audio.drained', committed: 'two' }))).toBeNull();
    expect(parseAudioServerEvent(JSON.stringify({ type: 'provider.internal' }))).toBeNull();
  });
});
