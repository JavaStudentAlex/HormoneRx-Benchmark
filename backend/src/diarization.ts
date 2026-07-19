import path from 'node:path';

import express, { type ErrorRequestHandler, type RequestHandler, type Router } from 'express';

import type { Settings } from './config.ts';

export const DIARIZATION_ROUTE = '/api/audio/diarize';
export const DIARIZATION_MODEL = 'gpt-4o-transcribe-diarize';
export const MAX_DIARIZATION_AUDIO_BYTES = 25 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set(['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm']);
const SUPPORTED_MIME_TYPES = new Set([
  'application/octet-stream',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/mpga',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
  'video/mp4',
  'video/mpeg',
  'video/webm',
]);

export interface DiarizedSegment {
  segment_id: string;
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface DiarizationPayload {
  model: typeof DIARIZATION_MODEL;
  text: string;
  speakers: string[];
  segments: DiarizedSegment[];
}

export interface DiarizationRouterOptions {
  fetch?: typeof fetch;
  maxAudioBytes?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
}

type DiarizationSettings = Pick<Settings, 'openai_api_key' | 'openai_base_url'>;

class InvalidProviderPayloadError extends Error {}

function cleanFilename(encodedFilename: string | undefined): string | null {
  if (!encodedFilename) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedFilename);
  } catch {
    return null;
  }
  const basename = path.basename(decoded).replace(/[\r\n]/g, '').slice(0, 255);
  return basename || null;
}

function extensionOf(filename: string): string {
  return path.extname(filename).slice(1).toLowerCase();
}

function contentTypeOf(header: string | undefined): string {
  return (header ?? '').split(';', 1)[0].trim().toLowerCase();
}

function finiteTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InvalidProviderPayloadError(`invalid ${field}`);
  }
  return value;
}

export function normalizeDiarizationResponse(value: unknown): DiarizationPayload {
  if (!value || typeof value !== 'object') {
    throw new InvalidProviderPayloadError('response is not an object');
  }
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.segments) || response.segments.length === 0) {
    throw new InvalidProviderPayloadError('response has no speaker segments');
  }

  const segments = response.segments.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new InvalidProviderPayloadError(`segment ${index + 1} is not an object`);
    }
    const segment = raw as Record<string, unknown>;
    const speaker = typeof segment.speaker === 'string' ? segment.speaker.trim() : '';
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    const start = finiteTimestamp(segment.start, `segment ${index + 1} start`);
    const end = finiteTimestamp(segment.end, `segment ${index + 1} end`);
    if (!speaker || !text || end < start) {
      throw new InvalidProviderPayloadError(`segment ${index + 1} is incomplete`);
    }
    const providerId = typeof segment.id === 'string' ? segment.id.trim() : '';
    return {
      originalIndex: index,
      segment_id: providerId || `segment-${index + 1}`,
      speaker,
      start,
      end,
      text,
    };
  })
    .sort((a, b) => a.start - b.start || a.end - b.end || a.originalIndex - b.originalIndex)
    .map(({ originalIndex: _originalIndex, ...segment }): DiarizedSegment => segment);

  const usedSegmentIds = new Set<string>();
  for (const segment of segments) {
    const baseId = segment.segment_id;
    let uniqueId = baseId;
    let suffix = 2;
    while (usedSegmentIds.has(uniqueId)) uniqueId = `${baseId}-${suffix++}`;
    segment.segment_id = uniqueId;
    usedSegmentIds.add(uniqueId);
  }

  return {
    model: DIARIZATION_MODEL,
    text:
      typeof response.text === 'string' && response.text.trim()
        ? response.text.trim()
        : segments.map((segment) => segment.text).join(' '),
    speakers: [...new Set(segments.map((segment) => segment.speaker))],
    segments,
  };
}

export function createDiarizationRouter(
  settings: DiarizationSettings,
  options: DiarizationRouterOptions = {},
): Router {
  const router = express.Router();
  const fetchImpl = options.fetch ?? fetch;
  const maxAudioBytes = options.maxAudioBytes ?? MAX_DIARIZATION_AUDIO_BYTES;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
  const timeoutMs = options.timeoutMs ?? 120_000;
  let activeRequests = 0;

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const rejectOversizedContentLength: RequestHandler = (req, res, next) => {
    const rawLength = req.get('content-length');
    const length = rawLength === undefined ? null : Number(rawLength);
    if (length !== null && Number.isFinite(length) && length > maxAudioBytes) {
      res.status(413).json({ detail: `Audio file must be ${maxAudioBytes} bytes or smaller.` });
      return;
    }
    next();
  };

  const acquireRequestSlot: RequestHandler = (_req, res, next) => {
    if (activeRequests >= maxConcurrent) {
      res.setHeader('Retry-After', '1');
      res.status(429).json({ detail: 'Too many audio diarization requests are already running.' });
      return;
    }
    activeRequests += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      activeRequests -= 1;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };

  router.post(
    DIARIZATION_ROUTE,
    rejectOversizedContentLength,
    acquireRequestSlot,
    express.raw({ type: () => true, limit: maxAudioBytes }),
    async (req, res) => {
      if (!settings.openai_api_key) {
        res.status(503).json({ detail: 'Audio diarization is unavailable because OPENAI_API_KEY is not configured.' });
        return;
      }

      const filename = cleanFilename(req.get('x-audio-filename'));
      if (!filename) {
        res.status(400).json({ detail: 'X-Audio-Filename is required.' });
        return;
      }
      const extension = extensionOf(filename);
      const contentType = contentTypeOf(req.get('content-type'));
      if (!SUPPORTED_EXTENSIONS.has(extension) || !SUPPORTED_MIME_TYPES.has(contentType)) {
        res.status(415).json({
          detail: 'Supported audio formats are mp3, mp4, mpeg, mpga, m4a, wav, and webm.',
        });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ detail: 'Audio file is empty.' });
        return;
      }
      if (req.body.length > maxAudioBytes) {
        res.status(413).json({ detail: `Audio file must be ${maxAudioBytes} bytes or smaller.` });
        return;
      }

      const form = new FormData();
      form.append('model', DIARIZATION_MODEL);
      form.append('response_format', 'diarized_json');
      form.append('chunking_strategy', 'auto');
      form.append('file', new Blob([req.body], { type: contentType }), `recording.${extension}`);

      const abortController = new AbortController();
      const abortUpstream = (): void => abortController.abort();
      req.once('aborted', abortUpstream);
      res.once('close', abortUpstream);
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);
      try {
        const baseUrl = settings.openai_base_url.replace(/\/$/, '');
        const response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${settings.openai_api_key}` },
          body: form,
          signal: abortController.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          res.status(502).json({
            detail: `Audio diarization provider rejected the file (${response.status}).`,
          });
          return;
        }

        let upstream: unknown;
        try {
          upstream = await response.json();
        } catch {
          throw new InvalidProviderPayloadError('response is not valid JSON');
        }
        res.json(normalizeDiarizationResponse(upstream));
      } catch (error) {
        if (error instanceof InvalidProviderPayloadError) {
          res.status(502).json({ detail: 'Audio diarization provider returned an invalid speaker transcript.' });
        } else if (abortController.signal.aborted) {
          res.status(504).json({ detail: 'Audio diarization timed out.' });
        } else {
          res.status(502).json({ detail: 'Audio diarization provider is unavailable.' });
        }
      } finally {
        clearTimeout(timeout);
        req.off('aborted', abortUpstream);
        res.off('close', abortUpstream);
      }
    },
  );

  const payloadErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    const bodyError = error as { status?: number; type?: string };
    if (bodyError.status === 413 || bodyError.type === 'entity.too.large') {
      res.status(413).json({ detail: `Audio file must be ${maxAudioBytes} bytes or smaller.` });
      return;
    }
    next(error);
  };
  router.use(payloadErrorHandler);

  return router;
}
