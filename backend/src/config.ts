/** Environment-driven configuration. Secrets are read only here, server-side. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export interface Settings {
  app_env: string;
  demo_mode: boolean;
  openai_api_key: string | null;
  openai_base_url: string;
  transcription_model: string;
  transcription_language: string;
  extraction_model: string;
  evidence_path: string;
  synonym_path: string;
  store_raw_audio: boolean;
  store_transcripts: boolean;
  strict_evidence_validation: boolean;
  // Hackathon-demo override: records that pass every runtime-eligibility check
  // EXCEPT the physician sign-off flag may trigger warnings, and every such
  // warning is visibly labeled "physician sign-off pending". Never enabled in
  // production. Once the physician flips physicianVerified to true this flag
  // becomes irrelevant.
  evidence_allow_pending_verification: boolean;
  extraction_fallback_deterministic: boolean;
  log_level: string;
}

export function defaultSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    app_env: 'development',
    demo_mode: true,
    openai_api_key: null,
    openai_base_url: 'https://api.openai.com/v1',
    transcription_model: 'gpt-realtime-whisper',
    transcription_language: 'en',
    extraction_model: 'gpt-4o-mini',
    evidence_path: path.join(BACKEND_DIR, 'data', 'evidence_records.json'),
    synonym_path: path.join(BACKEND_DIR, 'data', 'synonym_index.json'),
    store_raw_audio: false,
    store_transcripts: false,
    strict_evidence_validation: true,
    evidence_allow_pending_verification: true,
    extraction_fallback_deterministic: true,
    log_level: 'INFO',
    ...overrides,
  };
}

export function liveExtractionAvailable(settings: Settings): boolean {
  return Boolean(settings.openai_api_key);
}

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  const env = process.env;
  const appEnv = env.APP_ENV ?? 'development';
  const isProduction = appEnv === 'production';
  cached = defaultSettings({
    app_env: appEnv,
    demo_mode: envBool('DEMO_MODE', true),
    openai_api_key: env.OPENAI_API_KEY || null,
    openai_base_url: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    transcription_model: env.TRANSCRIPTION_MODEL ?? 'gpt-realtime-whisper',
    transcription_language: env.TRANSCRIPTION_LANGUAGE ?? 'en',
    extraction_model: env.EXTRACTION_MODEL ?? 'gpt-4o-mini',
    evidence_path: env.EVIDENCE_PATH ?? path.join(BACKEND_DIR, 'data', 'evidence_records.json'),
    synonym_path: env.SYNONYM_PATH ?? path.join(BACKEND_DIR, 'data', 'synonym_index.json'),
    store_raw_audio: envBool('STORE_RAW_AUDIO', false),
    store_transcripts: envBool('STORE_TRANSCRIPTS', false),
    strict_evidence_validation: envBool('STRICT_EVIDENCE_VALIDATION', true),
    evidence_allow_pending_verification: isProduction
      ? false
      : envBool('EVIDENCE_ALLOW_PENDING_VERIFICATION', true),
    extraction_fallback_deterministic: envBool('EXTRACTION_FALLBACK_DETERMINISTIC', true),
    log_level: env.LOG_LEVEL ?? 'INFO',
  });
  return cached;
}
