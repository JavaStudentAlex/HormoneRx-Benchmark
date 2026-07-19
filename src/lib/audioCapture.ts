// Microphone capture for live mode: getUserMedia -> AudioWorklet -> batched
// 24 kHz PCM16 mono frames. Audio stays in memory and is streamed immediately.

const TARGET_SAMPLE_RATE = 24000;
export const AUDIO_FRAME_MS = 80;
export const SPEECH_END_SILENCE_MS = 480;
export const MIN_COMMIT_AUDIO_MS = 120;
const PRE_ROLL_MS = 1200;
const SPEECH_RMS_THRESHOLD = 0.004;
const SPEECH_PEAK_THRESHOLD = 0.012;

const workletSource = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export interface AudioCaptureStopResult {
  shouldCommit: boolean;
}

export interface AudioCaptureHandle {
  commitCurrentUtterance: () => boolean;
  stop: () => AudioCaptureStopResult;
  sampleRate: number;
}

export interface AudioCaptureOptions {
  onChunk: (pcm16: ArrayBuffer) => void;
  onUtteranceEnd: () => void;
  frameMs?: number;
  silenceMs?: number;
}

/** Collect arbitrary PCM chunks into fixed-size frames suitable for WebSocket transport. */
export class PcmFrameBatcher {
  private readonly buffer: Int16Array;
  private used = 0;

  constructor(readonly frameSamples: number) {
    if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
      throw new RangeError('frameSamples must be a positive integer');
    }
    this.buffer = new Int16Array(frameSamples);
  }

  push(chunk: Int16Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(this.frameSamples - this.used, chunk.length - offset);
      this.buffer.set(chunk.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used === this.frameSamples) {
        frames.push(this.buffer.slice());
        this.used = 0;
      }
    }
    return frames;
  }

  flush(): Int16Array | null {
    if (this.used === 0) return null;
    const frame = this.buffer.slice(0, this.used);
    this.used = 0;
    return frame;
  }
}

export interface SpeechGateResult {
  frames: Int16Array[];
  utteranceEnded: boolean;
}

export interface ForcedSpeechGateResult {
  frames: Int16Array[];
  shouldCommit: boolean;
}

/**
 * Lightweight client VAD. Silence is held as a bounded pre-roll until speech
 * begins; once active, trailing silence is forwarded before the commit signal.
 */
export class SpeechFrameGate {
  private readonly preRollFrames: number;
  private readonly silenceFrames: number;
  private preRoll: Int16Array[] = [];
  private active = false;
  private silentFrameCount = 0;
  private activeSampleCount = 0;

  constructor(
    readonly frameMs = AUDIO_FRAME_MS,
    silenceMs = SPEECH_END_SILENCE_MS,
    preRollMs = PRE_ROLL_MS,
  ) {
    this.preRollFrames = Math.max(1, Math.ceil(preRollMs / frameMs));
    this.silenceFrames = Math.max(1, Math.ceil(silenceMs / frameMs));
  }

  push(frame: Int16Array): SpeechGateResult {
    const speech = frameHasSpeech(frame);
    if (!this.active) {
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      if (!speech) return { frames: [], utteranceEnded: false };

      this.active = true;
      this.silentFrameCount = 0;
      const frames = this.preRoll;
      this.preRoll = [];
      this.activeSampleCount = frames.reduce((total, buffered) => total + buffered.length, 0);
      return { frames, utteranceEnded: false };
    }

    this.activeSampleCount += frame.length;

    if (speech) {
      this.silentFrameCount = 0;
    } else {
      this.silentFrameCount += 1;
    }

    if (this.silentFrameCount >= this.silenceFrames) {
      this.active = false;
      this.silentFrameCount = 0;
      this.preRoll = [];
      this.activeSampleCount = 0;
      return { frames: [frame], utteranceEnded: true };
    }
    return { frames: [frame], utteranceEnded: false };
  }

  hasPendingUtterance(): boolean {
    return this.active;
  }

  pendingUtteranceSamples(): number {
    return this.active ? this.activeSampleCount : 0;
  }

  padPendingUtterance(minimumSamples: number): Int16Array | null {
    const padding = silencePaddingForMinimum(this.pendingUtteranceSamples(), minimumSamples);
    if (padding) this.activeSampleCount += padding.length;
    return padding;
  }

  forceCurrentUtterance(minimumSamples: number): ForcedSpeechGateResult {
    if (this.active) {
      const padding = this.padPendingUtterance(minimumSamples);
      this.reset();
      return { frames: padding ? [padding] : [], shouldCommit: true };
    }
    if (this.preRoll.length === 0) return { frames: [], shouldCommit: false };

    const frames = this.preRoll;
    const bufferedSamples = frames.reduce((total, frame) => total + frame.length, 0);
    const padding = silencePaddingForMinimum(bufferedSamples, minimumSamples);
    if (padding) frames.push(padding);
    this.reset();
    return { frames, shouldCommit: true };
  }

  private reset(): void {
    this.active = false;
    this.silentFrameCount = 0;
    this.activeSampleCount = 0;
    this.preRoll = [];
  }
}

export function silencePaddingForMinimum(
  pendingSamples: number,
  minimumSamples: number,
): Int16Array | null {
  if (pendingSamples <= 0 || pendingSamples >= minimumSamples) return null;
  return new Int16Array(minimumSamples - pendingSamples);
}

export function frameHasSpeech(frame: Int16Array): boolean {
  if (frame.length === 0) return false;
  let sumSquares = 0;
  let peak = 0;
  for (const value of frame) {
    const normalized = value / 0x8000;
    sumSquares += normalized * normalized;
    peak = Math.max(peak, Math.abs(normalized));
  }
  const rms = Math.sqrt(sumSquares / frame.length);
  return rms >= SPEECH_RMS_THRESHOLD || peak >= SPEECH_PEAK_THRESHOLD;
}

function downsampleTo16BitPcm(input: Float32Array, inputRate: number, targetRate: number): Int16Array {
  const ratio = inputRate / targetRate;
  const length = Math.max(0, Math.floor(input.length / ratio));
  const output = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    // Average each source interval instead of selecting a single sample. This
    // avoids the worst aliasing when the browser cannot create a 24 kHz context.
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const clamped = Math.max(-1, Math.min(1, sum / (end - start)));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

export async function startAudioCapture(options: AudioCaptureOptions): Promise<AudioCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    },
  });
  let context: AudioContext | null = null;
  try {
    try {
      context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      // Safari and some managed browsers reject a requested context rate.
      context = new AudioContext();
    }
    const workletUrl = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    if (context.state === 'suspended') await context.resume();

    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, 'pcm-capture');
    const silence = context.createGain();
    silence.gain.value = 0;

    const frameMs = options.frameMs ?? AUDIO_FRAME_MS;
    const batcher = new PcmFrameBatcher(Math.round((TARGET_SAMPLE_RATE * frameMs) / 1000));
    const speechGate = new SpeechFrameGate(frameMs, options.silenceMs ?? SPEECH_END_SILENCE_MS);
    const minimumCommitSamples = Math.ceil((TARGET_SAMPLE_RATE * MIN_COMMIT_AUDIO_MS) / 1000);

    const emitFrame = (frame: Int16Array): void => {
      const gated = speechGate.push(frame);
      for (const outgoing of gated.frames) {
        options.onChunk(outgoing.buffer as ArrayBuffer);
      }
      if (gated.utteranceEnded) options.onUtteranceEnd();
    };

    capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const pcm = downsampleTo16BitPcm(event.data, context!.sampleRate, TARGET_SAMPLE_RATE);
      for (const frame of batcher.push(pcm)) emitFrame(frame);
    };
    source.connect(capture);
    // Keep the worklet in the render graph while guaranteeing no microphone playback.
    capture.connect(silence);
    silence.connect(context.destination);

    let stopped = false;
    return {
      sampleRate: TARGET_SAMPLE_RATE,
      commitCurrentUtterance: () => {
        if (stopped) return false;
        let committed = false;
        const finalFrame = batcher.flush();
        if (finalFrame) {
          const gated = speechGate.push(finalFrame);
          for (const outgoing of gated.frames) options.onChunk(outgoing.buffer as ArrayBuffer);
          if (gated.utteranceEnded) {
            options.onUtteranceEnd();
            committed = true;
          }
        }
        const forced = speechGate.forceCurrentUtterance(minimumCommitSamples);
        for (const outgoing of forced.frames) options.onChunk(outgoing.buffer as ArrayBuffer);
        if (forced.shouldCommit) {
          options.onUtteranceEnd();
          committed = true;
        }
        return committed;
      },
      stop: () => {
        if (stopped) return { shouldCommit: false };
        stopped = true;
        capture.port.onmessage = null;
        const finalFrame = batcher.flush();
        if (finalFrame) emitFrame(finalFrame);
        const padding = speechGate.padPendingUtterance(minimumCommitSamples);
        if (padding) options.onChunk(padding.buffer as ArrayBuffer);
        const shouldCommit = speechGate.hasPendingUtterance();
        capture.disconnect();
        silence.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void context?.close();
        return { shouldCommit };
      },
    };
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    void context?.close();
    throw err;
  }
}
