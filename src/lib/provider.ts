import type { ExtractionResult } from './types';

// Provider abstraction so the extraction model can be swapped without touching the UI.
// DEMO mode uses the deterministic extractor (no API key needed).
// LIVE mode is expected to call a server-side/serverless endpoint that performs a
// structured-output model call. Secrets (OPENAI_API_KEY, OPENAI_MODEL) are read ONLY on
// the server; the browser never sees them. The endpoint must return an ExtractionResult
// and NOTHING ELSE — no interactions, consequences, citations, or advice.

export interface ExtractionProvider {
  name: string;
  extract(text: string): Promise<ExtractionResult>;
}

import { extractDeterministic } from './extract';

export const demoProvider: ExtractionProvider = {
  name: 'demo-deterministic',
  async extract(text: string) {
    return extractDeterministic(text);
  },
};

// Live provider calls a same-origin serverless function at /api/extract.
// The function is responsible for the model call and MUST enforce the extraction-only
// schema server-side. See docs/SAFETY.md and .env.example.
export const liveProvider: ExtractionProvider = {
  name: 'live-server',
  async extract(text: string) {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      throw new Error(`Extraction endpoint returned ${res.status}`);
    }
    const data = (await res.json()) as ExtractionResult;
    return data;
  },
};

export function getProvider(mode: 'demo' | 'live'): ExtractionProvider {
  return mode === 'live' ? liveProvider : demoProvider;
}
