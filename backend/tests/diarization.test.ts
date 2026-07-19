import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DIARIZATION_MODEL,
  DIARIZATION_ROUTE,
  createDiarizationRouter,
  normalizeDiarizationResponse,
} from '../src/diarization.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function startRouter(options: {
  apiKey?: string | null;
  fetch?: typeof fetch;
  maxAudioBytes?: number;
  maxConcurrent?: number;
} = {}): Promise<string> {
  const app = express();
  app.use(
    createDiarizationRouter(
      {
        openai_api_key: options.apiKey === undefined ? 'test-key' : options.apiKey,
        openai_base_url: 'https://api.openai.test/v1',
      },
      {
        fetch: options.fetch,
        maxAudioBytes: options.maxAudioBytes,
        maxConcurrent: options.maxConcurrent,
      },
    ),
  );
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

async function upload(baseUrl: string, body: Uint8Array, filename = 'consultation.wav', contentType = 'audio/wav') {
  const response = await fetch(baseUrl + DIARIZATION_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-Audio-Filename': encodeURIComponent(filename),
    },
    body,
  });
  return { response, json: (await response.json()) as Record<string, any> };
}

describe('uploaded audio diarization', () => {
  it('makes duplicate provider segment IDs unique after chronological sorting', () => {
    const normalized = normalizeDiarizationResponse({
      segments: [
        { id: 'duplicate', speaker: 'B', start: 2, end: 3, text: 'Second.' },
        { id: 'duplicate', speaker: 'A', start: 0, end: 1, text: 'First.' },
      ],
    });

    expect(normalized.segments.map((segment) => segment.segment_id)).toEqual(['duplicate', 'duplicate-2']);
    expect(normalized.segments.map((segment) => segment.text)).toEqual(['First.', 'Second.']);
  });

  it('forwards audio in memory and normalizes acoustic speaker segments', async () => {
    const upstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' });
      expect(form.get('model')).toBe(DIARIZATION_MODEL);
      expect(form.get('response_format')).toBe('diarized_json');
      expect(form.get('chunking_strategy')).toBe('auto');
      const uploaded = form.get('file') as File;
      expect(uploaded.name).toBe('recording.wav');
      expect(uploaded.size).toBe(4);
      return new Response(
        JSON.stringify({
          text: 'How are you? I take carbamazepine.',
          segments: [
            { id: 'seg-b', speaker: 'B', start: 1.3, end: 3.8, text: 'I take carbamazepine.' },
            { id: 'seg-a', speaker: 'A', start: 0, end: 1.2, text: 'How are you?' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const baseUrl = await startRouter({ fetch: upstream as typeof fetch });

    const { response, json } = await upload(baseUrl, new Uint8Array([1, 2, 3, 4]));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(upstream).toHaveBeenCalledWith(
      'https://api.openai.test/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(json).toEqual({
      model: DIARIZATION_MODEL,
      text: 'How are you? I take carbamazepine.',
      speakers: ['A', 'B'],
      segments: [
        { segment_id: 'seg-a', speaker: 'A', start: 0, end: 1.2, text: 'How are you?' },
        { segment_id: 'seg-b', speaker: 'B', start: 1.3, end: 3.8, text: 'I take carbamazepine.' },
      ],
    });
  });

  it('fails closed when no server API key is configured', async () => {
    const upstream = vi.fn();
    const baseUrl = await startRouter({ apiKey: null, fetch: upstream as typeof fetch });

    const { response, json } = await upload(baseUrl, new Uint8Array([1]));

    expect(response.status).toBe(503);
    expect(json.detail).toContain('OPENAI_API_KEY');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects unsupported formats before contacting the provider', async () => {
    const upstream = vi.fn();
    const baseUrl = await startRouter({ fetch: upstream as typeof fetch });

    const { response, json } = await upload(baseUrl, new Uint8Array([1]), 'notes.txt', 'text/plain');

    expect(response.status).toBe(415);
    expect(json.detail).toContain('Supported audio formats');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('enforces the upload limit before contacting the provider', async () => {
    const upstream = vi.fn();
    const baseUrl = await startRouter({ fetch: upstream as typeof fetch, maxAudioBytes: 4 });

    const { response, json } = await upload(baseUrl, new Uint8Array([1, 2, 3, 4, 5]));

    expect(response.status).toBe(413);
    expect(json.detail).toContain('4 bytes or smaller');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects provider output without real speaker metadata', async () => {
    const upstream = vi.fn(async () =>
      new Response(
        JSON.stringify({ text: 'Unlabelled text', segments: [{ start: 0, end: 1, text: 'Unlabelled text' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const baseUrl = await startRouter({ fetch: upstream as typeof fetch });

    const { response, json } = await upload(baseUrl, new Uint8Array([1]));

    expect(response.status).toBe(502);
    expect(json.detail).toContain('invalid speaker transcript');
  });

  it('bounds concurrent in-memory uploads before contacting the provider', async () => {
    let releaseFirst: ((response: Response) => void) | null = null;
    const upstream = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const baseUrl = await startRouter({ fetch: upstream as typeof fetch, maxConcurrent: 1 });

    const first = upload(baseUrl, new Uint8Array([1]));
    while (upstream.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = await upload(baseUrl, new Uint8Array([2]));

    expect(second.response.status).toBe(429);
    expect(second.response.headers.get('retry-after')).toBe('1');
    expect(upstream).toHaveBeenCalledTimes(1);

    releaseFirst!(
      new Response(
        JSON.stringify({
          text: 'First upload.',
          segments: [{ id: 'seg-1', speaker: 'A', start: 0, end: 1, text: 'First upload.' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect((await first).response.status).toBe(200);
  });

  it('aborts provider work and releases the slot when the upload client disconnects', async () => {
    let providerAborted = false;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const upstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (upstream.mock.calls.length > 1) {
        return new Response(
          JSON.stringify({
            text: 'Next upload.',
            segments: [{ id: 'seg-next', speaker: 'A', start: 0, end: 1, text: 'Next upload.' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      markProviderStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            providerAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    });
    const baseUrl = await startRouter({ fetch: upstream as typeof fetch, maxConcurrent: 1 });
    const controller = new AbortController();
    const abandoned = fetch(baseUrl + DIARIZATION_ROUTE, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-Audio-Filename': 'consultation.wav',
      },
      body: new Uint8Array([1]),
      signal: controller.signal,
    });
    await providerStarted;
    controller.abort();
    await expect(abandoned).rejects.toThrow();
    while (!providerAborted) await new Promise((resolve) => setImmediate(resolve));

    const next = await upload(baseUrl, new Uint8Array([2]));
    expect(next.response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
