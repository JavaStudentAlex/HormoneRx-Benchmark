import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react';

import {
  DIARIZATION_AUDIO_ACCEPT,
  DiarizationClientError,
  assertSupportedAudioFile,
  diarizeAudioFile,
  type DiarizationResult,
} from '../../lib/diarizationClient';
import { Badge, Button, cn } from '../ui/primitives';
import {
  acousticSpeakerDisplayLabel,
  acousticSpeakerStyle,
} from './acousticSpeakerStyles';

export type DiarizedRole = 'doctor' | 'patient' | 'other_person' | 'unknown';
export type SpeakerRoleChoice = 'auto' | DiarizedRole;

export interface ImportedDiarizedTurn {
  import_id: string;
  segment_id: string;
  source_speaker: string;
  speaker: DiarizedRole | null;
  text: string;
  started_at_ms: number;
  ended_at_ms: number;
}

export interface AudioUploadDiarizationProps {
  onImport: (turns: ImportedDiarizedTurn[]) => void | Promise<void>;
  className?: string;
  disabled?: boolean;
}

export function buildImportedDiarizedTurns(
  result: DiarizationResult,
  roleBySpeaker: Record<string, SpeakerRoleChoice>,
  importId: string,
): ImportedDiarizedTurn[] {
  return result.segments.map((segment) => {
    const role = roleBySpeaker[segment.speaker] ?? 'auto';
    return {
      import_id: importId,
      segment_id: segment.segment_id,
      source_speaker: segment.speaker,
      speaker: role === 'auto' ? null : role,
      text: segment.text,
      started_at_ms: Math.round(segment.start * 1000),
      ended_at_ms: Math.round(segment.end * 1000),
    };
  });
}

const ROLE_LABELS: Record<SpeakerRoleChoice, string> = {
  auto: 'Automatic role',
  doctor: 'Doctor',
  patient: 'Patient',
  other_person: 'Other person',
  unknown: 'Unknown',
};

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`;
}

function messageFrom(error: unknown): string {
  if (error instanceof DiarizationClientError || error instanceof Error) return error.message;
  return 'Audio diarization failed.';
}

function createImportId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export default function AudioUploadDiarization({
  onImport,
  className,
  disabled = false,
}: AudioUploadDiarizationProps) {
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<DiarizationResult | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [roleBySpeaker, setRoleBySpeaker] = useState<Record<string, SpeakerRoleChoice>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const analysisAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => () => analysisAbortRef.current?.abort(), []);
  useEffect(() => {
    if (disabled) analysisAbortRef.current?.abort();
  }, [disabled]);

  const duration = useMemo(
    () => (result ? Math.max(...result.segments.map((segment) => segment.end)) : 0),
    [result],
  );

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setError(null);
    setResult(null);
    setImportId(null);
    setRoleBySpeaker({});
    if (!selected) {
      setFile(null);
      return;
    }
    try {
      assertSupportedAudioFile(selected);
      setFile(selected);
    } catch (selectionError) {
      event.target.value = '';
      setFile(null);
      setError(messageFrom(selectionError));
    }
  }

  async function analyze() {
    if (!file) return;
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setAnalyzing(true);
    setError(null);
    setResult(null);
    setImportId(null);
    try {
      const transcript = await diarizeAudioFile(file, { signal: controller.signal });
      setResult(transcript);
      setImportId(createImportId());
      setRoleBySpeaker(
        Object.fromEntries(transcript.speakers.map((speaker) => [speaker, 'auto' as SpeakerRoleChoice])),
      );
    } catch (analysisError) {
      setResult(null);
      setImportId(null);
      if (!isAbortError(analysisError)) setError(messageFrom(analysisError));
    } finally {
      if (analysisAbortRef.current === controller) {
        analysisAbortRef.current = null;
        setAnalyzing(false);
      }
    }
  }

  function cancelAnalysis() {
    analysisAbortRef.current?.abort();
  }

  async function importTurns() {
    if (!result || !importId) return;
    setImporting(true);
    setError(null);
    try {
      await onImport(buildImportedDiarizedTurns(result, roleBySpeaker, importId));
    } catch (importError) {
      setError(messageFrom(importError));
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className={cn('space-y-4', className)} aria-labelledby={`${inputId}-title`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`${inputId}-title`} className="text-base font-semibold text-navy">
            Recorded consultation
          </h3>
          <p className="mt-0.5 text-xs text-ink-muted">
            Uploaded audio is sent to OpenAI for speaker diarization and transcription and is not saved by this server.
          </p>
        </div>
        <Badge tone="muted">25 MB maximum</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold text-navy">
            Consultation recording
          </label>
          <input
            id={inputId}
            type="file"
            accept={DIARIZATION_AUDIO_ACCEPT}
            disabled={disabled || analyzing || importing}
            onChange={chooseFile}
            className="block w-full rounded-lg border border-line bg-surface text-sm text-ink-muted file:mr-3 file:border-0 file:border-r file:border-line file:bg-canvas file:px-3 file:py-2.5 file:text-sm file:font-medium file:text-navy hover:file:bg-line/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        {analyzing ? (
          <Button variant="secondary" onClick={cancelAnalysis} disabled={importing}>
            Cancel
          </Button>
        ) : (
          <Button onClick={analyze} disabled={disabled || !file || importing}>
            Analyze recording
          </Button>
        )}
      </div>

      {file && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span className="max-w-full truncate font-medium text-navy">{file.name}</span>
          <span>{formatBytes(file.size)}</span>
        </div>
      )}

      {previewUrl && <audio className="h-10 w-full" controls preload="metadata" src={previewUrl} />}

      <div aria-live="polite">
        {analyzing && <p className="text-sm text-ink-muted">Separating speakers and transcribing audio...</p>}
        {error && (
          <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
      </div>

      {result && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap gap-2">
              <Badge tone="navy">{result.speakers.length} speakers</Badge>
              <Badge tone="neutral">{result.segments.length} segments</Badge>
              <Badge tone="muted">{formatTimestamp(duration)}</Badge>
            </div>
            <Button onClick={importTurns} disabled={disabled || importing || analyzing}>
              {importing ? 'Importing...' : `Import ${result.segments.length} turns`}
            </Button>
          </div>

          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-1 text-xs font-semibold text-navy">Speaker roles</legend>
            {result.speakers.map((speaker) => (
              <label
                key={speaker}
                className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,auto)] items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2"
              >
                <span className="truncate text-sm font-medium text-navy">Speaker {speaker}</span>
                <select
                  value={roleBySpeaker[speaker] ?? 'auto'}
                  onChange={(event) =>
                    setRoleBySpeaker((current) => ({
                      ...current,
                      [speaker]: event.target.value as SpeakerRoleChoice,
                    }))
                  }
                  disabled={disabled || importing}
                  aria-label={`Role for speaker ${speaker}`}
                  className="min-w-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-navy outline-none focus:border-teal focus:ring-2 focus:ring-teal/20"
                >
                  {(Object.keys(ROLE_LABELS) as SpeakerRoleChoice[]).map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>

          <div className="max-h-[28rem] space-y-2.5 overflow-y-auto pr-1" aria-label="Diarized transcript">
            {result.segments.map((segment) => {
              const style = acousticSpeakerStyle(segment.speaker);
              const role = roleBySpeaker[segment.speaker] ?? 'auto';
              return (
                <div key={segment.segment_id} className={cn('flex flex-col', style.align)}>
                  <div className={cn('max-w-[85%] rounded-lg border p-2.5', style.bubble)}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', style.dot)} aria-hidden="true" />
                      <span className="text-[11px] font-semibold text-navy">
                        {acousticSpeakerDisplayLabel(segment.speaker)}
                      </span>
                      {role !== 'auto' && <span className="text-[11px] text-ink-muted">{ROLE_LABELS[role]}</span>}
                      <time className="font-mono text-[10px] text-ink-faint">
                        {formatTimestamp(segment.start)}-{formatTimestamp(segment.end)}
                      </time>
                    </div>
                    <p className="mt-1 text-sm text-navy">{segment.text}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
