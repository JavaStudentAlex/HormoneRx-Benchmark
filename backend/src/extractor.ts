/**
 * Extraction adapters.
 *
 * MedicationContextExtractor is the interface the encounter service depends on.
 * The live adapter calls a server-side structured-output model; every response
 * is validated against the strict contract before it may touch the graph
 * (spec §12.3). Prohibited medical fields cannot survive validation because the
 * schema forbids extra keys.
 */
import { Settings, liveExtractionAvailable } from './config.ts';
import { DeterministicExtractor } from './deterministicExtractor.ts';
import { EvidenceIndex } from './evidenceIndex.ts';
import {
  Certainty,
  MentionCategory,
  MentionStatus,
  SubjectRole,
  TranscriptTurn,
  TurnExtraction,
  makeExtractedMention,
} from './models.ts';

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface MedicationContextExtractor {
  extract(turn: TranscriptTurn): Promise<TurnExtraction>;
}

export const EXTRACTION_SYSTEM_PROMPT = `You extract medication context from one finalized turn of a synthetic doctor-patient conversation.

Return ONLY the structured fields requested. You may identify: hormonal products, other medications, their status (current | historical | planned | negated | uncertain), the subject (patient | doctor | other_person | unknown), certainty, character spans, explicitly stated route or dose, explicit corrections, and missing information.

You must NOT output interactions, consequences, mechanisms, severity, evidence levels, citations, recommendations, or safety judgments. Do not guess a specific contraceptive method from an ambiguous phrase like "the pill" — report the surface text and let downstream code handle ambiguity. Do not invent medication names that are not in the text.`;

export const EXTRACTION_JSON_SCHEMA = {
  name: 'turn_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mentions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            surface_text: { type: 'string' },
            category: { type: 'string', enum: ['hormonal_product', 'other_medication'] },
            status: { type: 'string', enum: ['current', 'historical', 'planned', 'negated', 'uncertain'] },
            subject: { type: 'string', enum: ['patient', 'doctor', 'other_person', 'unknown'] },
            certainty: { type: 'string', enum: ['explicit', 'inferred', 'uncertain'] },
            span_start: { type: ['integer', 'null'] },
            span_end: { type: ['integer', 'null'] },
            route_if_explicit: { type: ['string', 'null'] },
            dose_if_explicit: { type: ['string', 'null'] },
          },
          required: [
            'surface_text', 'category', 'status', 'subject', 'certainty',
            'span_start', 'span_end', 'route_if_explicit', 'dose_if_explicit',
          ],
        },
      },
      corrections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target_surface_text: { type: ['string', 'null'] },
            replacement_surface_text: { type: ['string', 'null'] },
          },
          required: ['target_surface_text', 'replacement_surface_text'],
        },
      },
      missing_information: { type: 'array', items: { type: 'string' } },
    },
    required: ['mentions', 'corrections', 'missing_information'],
  },
};

const MENTION_CATEGORIES = new Set<string>(Object.values(MentionCategory));
const MENTION_STATUSES = new Set<string>(Object.values(MentionStatus));
const SUBJECT_ROLES = new Set<string>(Object.values(SubjectRole));
const CERTAINTIES = new Set<string>(Object.values(Certainty));

function requireEnum(set: Set<string>, value: unknown, field: string): string {
  if (typeof value !== 'string' || !set.has(value)) {
    throw new Error(`invalid ${field}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Structured-output extraction via an OpenAI-compatible chat completions API. */
export class LiveExtractor implements MedicationContextExtractor {
  constructor(
    public settings: Settings,
    private index: EvidenceIndex,
  ) {
    if (!settings.openai_api_key) {
      throw new Error('LiveExtractor requires OPENAI_API_KEY');
    }
  }

  async extract(turn: TranscriptTurn): Promise<TurnExtraction> {
    const body = {
      model: this.settings.extraction_model,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({ turn_id: turn.turn_id, speaker: turn.speaker, text: turn.text }),
        },
      ],
      response_format: { type: 'json_schema', json_schema: EXTRACTION_JSON_SCHEMA },
      temperature: 0,
    };
    let parsed: {
      mentions?: Array<Record<string, unknown>>;
      corrections?: Array<Record<string, unknown>>;
      missing_information?: unknown[];
    };
    try {
      const response = await fetch(`${this.settings.openai_base_url}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.openai_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`provider returned ${response.status}`);
      }
      const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      parsed = JSON.parse(json.choices[0].message.content);
    } catch (err) {
      // network, HTTP, or JSON failure
      throw new ExtractionError(`live extraction failed: ${err}`);
    }

    try {
      const mentions = (parsed.mentions ?? []).map((m) =>
        makeExtractedMention({
          surface_text: String(m.surface_text),
          category: requireEnum(MENTION_CATEGORIES, m.category, 'category') as MentionCategory,
          status: requireEnum(MENTION_STATUSES, m.status, 'status') as MentionStatus,
          subject: requireEnum(SUBJECT_ROLES, m.subject, 'subject') as SubjectRole,
          certainty: requireEnum(CERTAINTIES, m.certainty, 'certainty') as Certainty,
          source_turn_id: turn.turn_id,
          span_start: (m.span_start as number | null | undefined) ?? null,
          span_end: (m.span_end as number | null | undefined) ?? null,
          route_if_explicit: (m.route_if_explicit as string | null | undefined) ?? null,
          dose_if_explicit: (m.dose_if_explicit as string | null | undefined) ?? null,
        }),
      );
      return {
        turn_id: turn.turn_id,
        speaker: turn.speaker as string as SubjectRole,
        mentions,
        corrections: (parsed.corrections ?? []).map((c) => ({
          target_surface_text: (c.target_surface_text as string | null | undefined) ?? null,
          replacement_surface_text: (c.replacement_surface_text as string | null | undefined) ?? null,
          note: null,
        })),
        missing_information: (parsed.missing_information ?? []).map((x) => String(x)),
        should_recompute_graph: true,
        extraction_method: 'live_structured_output',
        extraction_model: this.settings.extraction_model,
      };
    } catch (err) {
      // The model produced something outside the contract: reject wholesale.
      throw new ExtractionError(`live extraction response failed validation: ${err}`);
    }
  }
}

export function buildExtractor(settings: Settings, index: EvidenceIndex): MedicationContextExtractor {
  if (!settings.demo_mode && liveExtractionAvailable(settings)) {
    return new LiveExtractor(settings, index);
  }
  return new DeterministicExtractor(index);
}
