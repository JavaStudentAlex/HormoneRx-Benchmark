import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildImportedDiarizedTurns } from '../components/live/AudioUploadDiarization';
import {
  acousticSpeakerDisplayLabel,
  acousticSpeakerStyleIndex,
} from '../components/live/acousticSpeakerStyles';
import { backend, type AddTextTurnPayload } from '../lib/backendClient';
import type { DiarizationResult } from '../lib/diarizationClient';

const result: DiarizationResult = {
  model: 'gpt-4o-transcribe-diarize',
  text: 'Hello. Hi.',
  speakers: ['A', 'B'],
  segments: [
    { segment_id: 'seg-1', speaker: 'A', start: 0.125, end: 1.25, text: 'Hello.' },
    { segment_id: 'seg-2', speaker: 'B', start: 1.4, end: 2.05, text: 'Hi.' },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('diarized import identity', () => {
  it('reuses one import id while preserving acoustic speaker and mapped role', () => {
    const first = buildImportedDiarizedTurns(result, { A: 'patient', B: 'unknown' }, 'import-stable');
    const retry = buildImportedDiarizedTurns(result, { A: 'patient', B: 'unknown' }, 'import-stable');

    expect(retry).toEqual(first);
    expect(first).toEqual([
      {
        import_id: 'import-stable',
        segment_id: 'seg-1',
        source_speaker: 'A',
        speaker: 'patient',
        text: 'Hello.',
        started_at_ms: 125,
        ended_at_ms: 1250,
      },
      {
        import_id: 'import-stable',
        segment_id: 'seg-2',
        source_speaker: 'B',
        speaker: 'unknown',
        text: 'Hi.',
        started_at_ms: 1400,
        ended_at_ms: 2050,
      },
    ]);
  });

  it('assigns stable distinct styles and non-duplicated labels to common acoustic speakers', () => {
    expect(acousticSpeakerStyleIndex('A')).not.toBe(acousticSpeakerStyleIndex('B'));
    expect(acousticSpeakerStyleIndex('Speaker A')).toBe(acousticSpeakerStyleIndex('A'));
    expect(acousticSpeakerDisplayLabel('A')).toBe('Speaker A');
    expect(acousticSpeakerDisplayLabel('Speaker B')).toBe('Speaker B');
  });
});

describe('encounter REST provenance and retries', () => {
  it('creates ordinary encounters by default and marks only requested demos synthetic', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ encounter_id: 'enc-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await backend.createEncounter();
    await backend.createEncounter(true);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ synthetic_demo: false });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ synthetic_demo: true });
  });

  it('accepts a duplicate text-turn response so a stable import retry can continue', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('duplicate event', { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const payload: AddTextTurnPayload = {
      event_id: 'upload-import-stable-0-seg-1',
      provider_item_id: 'upload-import-stable-0-seg-1',
      text: 'Hello.',
      speaker: 'unknown',
      source_speaker_label: 'A',
      started_at_ms: 125,
      ended_at_ms: 1250,
    };

    await expect(backend.addTextTurn('enc-1', payload)).resolves.toEqual({ duplicate: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(payload);
  });
});
