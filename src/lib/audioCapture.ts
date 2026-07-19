// Microphone capture for live mode: getUserMedia -> AudioWorklet -> 24 kHz
// PCM16 mono chunks handed to a callback (streamed to the Python backend, which
// relays them server-side to the transcription provider — no key in the browser).
//
// Capture starts ONLY from an explicit user action and every consumer must call
// stop() to end the tracks (visible indicator is the caller's responsibility).

const TARGET_SAMPLE_RATE = 24000;

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

export interface AudioCaptureHandle {
  stop: () => void;
  sampleRate: number;
}

function downsampleTo16BitPcm(input: Float32Array, inputRate: number, targetRate: number): Int16Array {
  const ratio = inputRate / targetRate;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const sample = input[Math.floor(i * ratio)];
    const clamped = Math.max(-1, Math.min(1, sample));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

export async function startAudioCapture(onChunk: (pcm16: ArrayBuffer) => void): Promise<AudioCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const context = new AudioContext();
  const workletUrl = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
  await context.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const source = context.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(context, 'pcm-capture');
  capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const pcm = downsampleTo16BitPcm(event.data, context.sampleRate, TARGET_SAMPLE_RATE);
    onChunk(pcm.buffer as ArrayBuffer);
  };
  source.connect(capture);
  // Not connected to destination: nothing is played back.

  return {
    sampleRate: TARGET_SAMPLE_RATE,
    stop: () => {
      capture.port.onmessage = null;
      capture.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
}
