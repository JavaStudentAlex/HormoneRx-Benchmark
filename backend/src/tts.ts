/**
 * Cloud text-to-speech for synthesizing the manifest transcripts into audio the
 * affect models can consume (no local TTS/ffmpeg needed). Uses the user's
 * OpenAI / ElevenLabs credits. Synthetic voices only — never real patient audio.
 */
import { writeFileSync } from 'node:fs';

export interface TtsOut {
  ok: boolean;
  provider: string;
  path?: string;
  bytes?: number;
  error?: string;
}

/** Wrap raw little-endian PCM16 mono samples in a minimal WAV container. */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function synthOpenAiTts(o: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  voice: string;
  text: string;
  outPath: string;
}): Promise<TtsOut> {
  try {
    const resp = await fetch(`${o.baseUrl ?? 'https://api.openai.com/v1'}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({
        model: o.model ?? process.env.OPENAI_TTS_MODEL ?? 'tts-1',
        voice: o.voice,
        input: o.text,
        response_format: 'wav',
      }),
    });
    if (!resp.ok) return { ok: false, provider: 'openai-tts', error: `${resp.status}: ${(await resp.text()).slice(0, 160)}` };
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(o.outPath, buf);
    return { ok: true, provider: 'openai-tts', path: o.outPath, bytes: buf.length };
  } catch (e) {
    return { ok: false, provider: 'openai-tts', error: String(e).slice(0, 160) };
  }
}

export async function synthElevenLabsTts(o: {
  apiKey: string;
  voiceId: string;
  model?: string;
  text: string;
  outPath: string;
}): Promise<TtsOut> {
  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${o.voiceId}?output_format=pcm_16000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': o.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text: o.text, model_id: o.model ?? 'eleven_multilingual_v2' }),
      },
    );
    if (!resp.ok) return { ok: false, provider: 'elevenlabs-tts', error: `${resp.status}: ${(await resp.text()).slice(0, 160)}` };
    const pcm = Buffer.from(await resp.arrayBuffer());
    const wav = pcm16ToWav(pcm, 16000, 1);
    writeFileSync(o.outPath, wav);
    return { ok: true, provider: 'elevenlabs-tts', path: o.outPath, bytes: wav.length };
  } catch (e) {
    return { ok: false, provider: 'elevenlabs-tts', error: String(e).slice(0, 160) };
  }
}
