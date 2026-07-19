import type { PipelineMode, PipelineResult, ExtractionResult } from './types';
import { getProvider } from './provider';
import { runLookup } from './lookup';
import demoData from '../data/demo_cases.json';

export const PIPELINE_VERSION = '0.1.0';
export const DISCLAIMER =
  'Research prototype. Not medical advice. Evidence is limited to the curated prototype dataset and requires verification against the cited source and individual clinical context.';

interface DemoCase {
  id: string;
  label: string;
  text: string;
  cachedExtraction: ExtractionResult;
}

const demoCases = (demoData as { cases: DemoCase[] }).cases;

// For demo cases we use the cached extraction shipped in demo_cases.json (deterministic,
// works with no API key). The deterministic extractor produces equivalent output, but the
// cache guarantees a stable, inspectable demo.
export function getDemoCases(): DemoCase[] {
  return demoCases;
}

export async function analyze(text: string, mode: PipelineMode): Promise<PipelineResult> {
  try {
    // If this exact text matches a cached demo case, use the cached extraction.
    const cached = demoCases.find((c) => c.text.trim() === text.trim());
    let extraction: ExtractionResult;
    if (mode === 'demo' && cached) {
      extraction = cached.cachedExtraction;
    } else {
      extraction = await getProvider(mode).extract(text);
    }
    return runLookup(extraction);
  } catch (err) {
    return {
      state: 'ERROR',
      matchedRecord: null,
      lookupReason: 'The analysis could not be completed. No medical content is shown for this state.',
      messages: ['An error occurred while processing the input. Please try again.'],
      missingInformation: [],
      extraction: {
        hormonalProduct: { raw: null, normalized: null, status: null, sourceSpan: null },
        otherMedication: { raw: null, normalized: null, status: null, sourceSpan: null },
        missingInformation: [],
        shouldSearchEvidence: false,
        reason: err instanceof Error ? err.message : 'Unknown error',
      },
    };
  }
}
