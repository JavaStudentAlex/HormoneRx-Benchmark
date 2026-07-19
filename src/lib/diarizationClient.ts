export const MAX_DIARIZATION_AUDIO_BYTES = 25 * 1024 * 1024;
export const DIARIZATION_AUDIO_ACCEPT = '.mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm';

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

export interface DiarizedSegment {
  segment_id: string;
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface DiarizationResult {
  model: 'gpt-4o-transcribe-diarize';
  text: string;
  speakers: string[];
  segments: DiarizedSegment[];
}

export class DiarizationClientError extends Error {
  constructor(message: string, public status: number | null = null) {
    super(message);
    this.name = 'DiarizationClientError';
  }
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function assertSupportedAudioFile(file: File): void {
  const extension = extensionOf(file.name);
  if (!(extension in MIME_BY_EXTENSION)) {
    throw new DiarizationClientError('Choose an mp3, mp4, mpeg, mpga, m4a, wav, or webm recording.');
  }
  if (file.size === 0) {
    throw new DiarizationClientError('The selected recording is empty.');
  }
  if (file.size > MAX_DIARIZATION_AUDIO_BYTES) {
    throw new DiarizationClientError('The selected recording is larger than 25 MB.');
  }
}

function isDiarizationResult(value: unknown): value is DiarizationResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<DiarizationResult>;
  return (
    result.model === 'gpt-4o-transcribe-diarize' &&
    typeof result.text === 'string' &&
    Array.isArray(result.speakers) &&
    result.speakers.every((speaker) => typeof speaker === 'string' && speaker.length > 0) &&
    Array.isArray(result.segments) &&
    result.segments.length > 0 &&
    result.segments.every(
      (segment) =>
        segment &&
        typeof segment.segment_id === 'string' &&
        typeof segment.speaker === 'string' &&
        typeof segment.text === 'string' &&
        typeof segment.start === 'number' &&
        typeof segment.end === 'number',
    )
  );
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown };
    if (typeof payload.detail === 'string' && payload.detail) return payload.detail;
  } catch {
    // Fall through to the status-based message.
  }
  return `Audio diarization failed (${response.status}).`;
}

export async function diarizeAudioFile(
  file: File,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<DiarizationResult> {
  assertSupportedAudioFile(file);
  const extension = extensionOf(file.name);
  const response = await (options.fetch ?? fetch)('/api/audio/diarize', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || MIME_BY_EXTENSION[extension],
      'X-Audio-Filename': encodeURIComponent(file.name),
    },
    body: file,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new DiarizationClientError(await errorDetail(response), response.status);
  }
  const payload: unknown = await response.json();
  if (!isDiarizationResult(payload)) {
    throw new DiarizationClientError('The server returned an invalid speaker transcript.', 502);
  }
  return payload;
}
