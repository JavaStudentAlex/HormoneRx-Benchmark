/** Shared test fixtures (port of the pytest conftest). */
import { Settings, defaultSettings } from '../src/config.ts';
import { DeterministicExtractor } from '../src/deterministicExtractor.ts';
import { EncounterRuntime, EncounterService } from '../src/encounterService.ts';
import { EvidenceIndex } from '../src/evidenceIndex.ts';
import {
  EncounterSnapshot,
  Speaker,
  TranscriptTurn,
  makeTranscriptTurn,
  newId,
} from '../src/models.ts';

export const settings: Settings = defaultSettings();

/** Session-scoped index with the pending-verification demo override. */
export const index = new EvidenceIndex(settings.evidence_path, settings.synonym_path, {
  strict: true,
  allowPendingVerification: true,
});

/** Spec-strict eligibility: physician sign-off required, no override. */
export const strictIndex = new EvidenceIndex(settings.evidence_path, settings.synonym_path, {
  strict: true,
  allowPendingVerification: false,
});

export function makeService(): EncounterService {
  return new EncounterService(settings, index, new DeterministicExtractor(index));
}

export function makeTurn(text: string, speaker: Speaker = 'patient', sequence = 1): TranscriptTurn {
  return makeTranscriptTurn({
    turn_id: `turn-${sequence}`,
    sequence,
    speaker,
    text,
    is_final: true,
  });
}

export async function say(
  service: EncounterService,
  runtime: EncounterRuntime,
  text: string,
  options: {
    speaker?: Speaker;
    event_id?: string;
    sequence?: number;
    provider_item_id?: string;
  } = {},
): Promise<EncounterSnapshot> {
  return service.processFinalTurn(runtime, {
    event_id: options.event_id ?? newId('evt'),
    text,
    speaker: options.speaker ?? 'patient',
    sequence: options.sequence,
    provider_item_id: options.provider_item_id,
  });
}
