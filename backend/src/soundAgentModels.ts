/**
 * Real affect-model adapters behind the AffectModel interface.
 *
 *  - SidecarSer          — on-prem open-source SER on the local GPU via a Python
 *                          sidecar (transformers wav2vec2, Apache-2.0). The
 *                          defensible measurement + privacy option; runs offline.
 *  - OpenAiAudioAffectModel — gpt-4o-audio-preview structured affect summary.
 *                          The PRIMARY "actor" per project strategy. Note: an
 *                          LLM judgment, unvalidated/uncalibrated — low confidence.
 *  - ElevenLabsAffectModel  — Scribe v2 STT with tag_audio_events (laughter /
 *                          emotion / sound-event tags).
 *
 * SAFETY: every adapter only ever returns advisory affect context. Nothing here
 * can produce an interaction, severity, or warning — that stays deterministic
 * and downstream.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AcousticFeatures, CategoricalEmotion } from './models.ts';
import type { AffectModel } from './soundAgent.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// On-prem GPU SER sidecar
// ---------------------------------------------------------------------------

export const SER_PYTHON = process.env.SER_PYTHON || '/home/alex/.cache/hormonerx-ser-venv/bin/python';
export const SER_SIDECAR = path.resolve(HERE, '..', 'ser', 'infer.py');
export const SER_MODEL = process.env.SER_MODEL || 'superb/wav2vec2-base-superb-er';

/** Friendly labels for the superb ER label set. */
const SER_LABEL_MAP: Record<string, string> = { ang: 'anger', hap: 'happiness', neu: 'neutral', sad: 'sadness' };

export function serSidecarAvailable(): boolean {
  return existsSync(SER_PYTHON) && existsSync(SER_SIDECAR);
}

export interface SerSegmentInput {
  segment_id: string;
  transcript: string;
  audio_path?: string | null;
}

export interface SerResult {
  segment_id: string;
  label: string;
  score: number;
  scores: Record<string, number>;
  latency_ms: number;
  audio: 'file' | 'synthetic';
}

export interface SerResponse {
  ok: boolean;
  model?: string;
  cuda?: boolean;
  device?: string;
  results?: SerResult[];
  error?: string;
}

/** Run the sidecar once over a batch of segments (loads the model a single time). */
export function runSidecarSer(segments: SerSegmentInput[], sampleRate = 16000): SerResponse {
  const res = spawnSync(SER_PYTHON, [SER_SIDECAR], {
    input: JSON.stringify({ model: SER_MODEL, sample_rate: sampleRate, segments }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  if (res.error) return { ok: false, error: String(res.error) };
  const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  try {
    return JSON.parse(lastLine) as SerResponse;
  } catch {
    return { ok: false, error: `sidecar non-JSON (exit ${res.status}): ${(res.stderr || lastLine).slice(0, 300)}` };
  }
}

export function serToCategorical(r: SerResult, model: string): CategoricalEmotion {
  return { label: SER_LABEL_MAP[r.label] ?? r.label, score: r.score, model, modality: 'audio' };
}

// ---------------------------------------------------------------------------
// OpenAI gpt-4o-audio-preview (PRIMARY actor) — LLM affect summary
// ---------------------------------------------------------------------------

const AFFECT_SYSTEM_PROMPT =
  'You are an audio affect summarizer. Listen to the segment and return ONLY structured JSON describing the ' +
  "speaker's apparent emotional state and tone. You must NOT give medical, diagnostic, or safety advice, and " +
  'you must NOT mention drugs, interactions, or clinical content. Output only the affect fields.';

const AFFECT_JSON_SCHEMA = {
  name: 'affect_summary',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      emotion: { type: 'string' },
      tone: { type: 'string' },
      distress_level: { type: 'string', enum: ['none', 'low', 'elevated'] },
      evidence: { type: 'string' },
    },
    required: ['emotion', 'tone', 'distress_level', 'evidence'],
  },
} as const;

function wavToBase64(audioPath: string): string {
  return readFileSync(audioPath).toString('base64');
}

export class OpenAiAudioAffectModel implements AffectModel {
  name: string;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(opts: { apiKey: string; baseUrl?: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.model = opts.model ?? 'gpt-4o-audio-preview';
    this.name = `openai:${this.model}`;
  }

  async infer(input: { transcript: string; audioPath?: string; acoustic?: AcousticFeatures }): Promise<{
    categorical_emotion?: CategoricalEmotion;
    events?: string[];
  }> {
    if (!this.apiKey) throw new Error('OpenAiAudioAffectModel requires OPENAI_API_KEY (server-side only)');
    if (!input.audioPath) throw new Error('OpenAiAudioAffectModel requires an audio segment');
    const body = {
      model: this.model,
      modalities: ['text'],
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: AFFECT_JSON_SCHEMA },
      messages: [
        { role: 'system', content: AFFECT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarize the affect of this segment.' },
            { type: 'input_audio', input_audio: { data: wavToBase64(input.audioPath), format: 'wav' } },
          ],
        },
      ],
    };
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`openai affect ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as {
      emotion?: string;
      distress_level?: string;
    };
    return {
      categorical_emotion: parsed.emotion
        ? { label: parsed.emotion, score: parsed.distress_level === 'elevated' ? 0.7 : 0.4, model: this.name, modality: 'audio' }
        : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs Scribe v2 — STT with audio-event / emotion tags
// ---------------------------------------------------------------------------

export class ElevenLabsAffectModel implements AffectModel {
  name = 'elevenlabs:scribe_v2';
  private apiKey: string;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'scribe_v2';
  }

  async infer(input: { transcript: string; audioPath?: string; acoustic?: AcousticFeatures }): Promise<{
    categorical_emotion?: CategoricalEmotion;
    events?: string[];
  }> {
    if (!this.apiKey) throw new Error('ElevenLabsAffectModel requires ELEVENLABS_API_KEY');
    if (!input.audioPath) throw new Error('ElevenLabsAffectModel requires an audio segment');
    const form = new FormData();
    form.append('model_id', this.model);
    form.append('tag_audio_events', 'true');
    form.append('diarize', 'true');
    form.append('file', new Blob([readFileSync(input.audioPath)]), path.basename(input.audioPath));
    const resp = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
    });
    if (!resp.ok) throw new Error(`elevenlabs stt ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as { words?: Array<{ type?: string; text?: string }> };
    // Audio-event tokens (laughter, etc.) arrive as words with type 'audio_event'.
    const events = (data.words ?? [])
      .filter((w) => w.type === 'audio_event' && w.text)
      .map((w) => String(w.text));
    return { events };
  }
}
