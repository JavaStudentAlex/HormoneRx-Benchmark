/**
 * Speaker-role attribution.
 *
 * When a finalized turn arrives without an explicit speaker label (single-mic
 * live audio, or a client that no longer carries a doctor/patient toggle), the
 * encounter service resolves WHO IS SPEAKING here — once, at ingestion — and
 * persists the result into the event log. It is never recomputed during graph
 * rebuilds (the fleet invariant auditor depends on replay determinism).
 *
 * Explicitly supplied speakers (demo scripts, benchmark cases, tests, any wire
 * message that includes the field) always bypass attribution entirely.
 */
import { Settings, liveExtractionAvailable } from './config.ts';
import { SPEAKER_VALUES, Speaker, TranscriptTurn } from './models.ts';

export const ATTRIBUTOR_VERSION = 'deterministic-speaker-attributor/0.1.0';

export interface SpeakerAttributionInput {
  text: string;
  /** Last N resolved turns, oldest -> newest. */
  context: TranscriptTurn[];
}

export interface SpeakerAttribution {
  speaker: Speaker;
  source: 'inferred_llm' | 'inferred_heuristic';
  confidence: number | null;
  model: string | null;
}

export interface SpeakerAttributor {
  attribute(input: SpeakerAttributionInput): Promise<SpeakerAttribution>;
}

// ---------------------------------------------------------------------------
// Deterministic attributor
// ---------------------------------------------------------------------------

type WeightedCue = readonly [cue: string, weight: number];

const DOCTOR_CUES: readonly WeightedCue[] = [
  // Intake / greeting.
  ['what brings you in', 2],
  ['how can i help', 2],
  ['what can i do for you', 2],
  ['have a seat', 2],
  // Clinical second-person questions.
  ['are you taking', 2],
  ['are you using', 2],
  ['are you currently', 2],
  ['do you take', 2],
  ['do you use', 2],
  ['have you been', 2],
  ['any regular medication', 2],
  ['any allergies', 2],
  ['how long have you', 2],
  ['when did you last', 2],
  ['any other medication', 2],
  // Prescribing / instruction.
  ["i'll prescribe", 2],
  ['i will prescribe', 2],
  ["i'm going to prescribe", 2],
  ['start you on', 2],
  ["let's start", 2],
  ["we'll start", 2],
  ['i recommend', 2],
  ["i'd like you to", 2],
  ['we can switch', 2],
  ['take one tablet', 2],
  ['twice a day', 2],
  ['the dose', 2],
  // Exam / results framing.
  ['your blood pressure', 1],
  ['your results', 1],
  ['the labs show', 1],
  ['let me examine', 1],
];

const PATIENT_CUES: readonly WeightedCue[] = [
  // First-person medication statements.
  ['i take', 2],
  ["i'm taking", 2],
  ["i'm on", 2],
  ["i've been on", 2],
  ['i was on', 2],
  ['i stopped', 2],
  ['i started', 2],
  ['i was prescribed', 2],
  ['my doctor', 2],
  ['i ran out', 2],
  // First-person questions (patients ask questions too; keeps "?" from
  // reading as doctor by default).
  ['should i', 2],
  ['can i take', 2],
  ['can i still', 2],
  ['can i keep', 2],
  ['do i need', 2],
  ['is it safe for me', 2],
  // Symptoms.
  ['i feel', 1],
  ["i've been having", 1],
  ['it hurts', 1],
  ['my headaches', 1],
  ['my period', 1],
];

/** Companion self-identification is rare but decisive when present. */
const OTHER_PERSON_CUES: readonly WeightedCue[] = [
  ["i'm her husband", 3],
  ["i'm his wife", 3],
  ["i'm her mother", 3],
  ["i'm his mother", 3],
  ["i'm her partner", 3],
  ["i'm his partner", 3],
  ["i'm their", 3],
  ["i'm the patient's", 3],
];

function cueScore(lower: string, cues: readonly WeightedCue[]): number {
  let score = 0;
  for (const [cue, weight] of cues) {
    if (lower.includes(cue)) score += weight;
  }
  return score;
}

/**
 * Pure, deterministic role scoring: weighted lexical cues plus two priors from
 * the resolved conversation so far. Abstains to `unknown` unless one role wins
 * clearly — safe, because the extractor still maps first-person medication
 * statements from an unknown speaker to a patient subject
 * (deterministicExtractor.classifySubject), so warnings are not lost.
 */
export class DeterministicSpeakerAttributor implements SpeakerAttributor {
  async attribute(input: SpeakerAttributionInput): Promise<SpeakerAttribution> {
    return { speaker: this.classify(input), source: 'inferred_heuristic', confidence: null, model: ATTRIBUTOR_VERSION };
  }

  classify({ text, context }: SpeakerAttributionInput): Speaker {
    const lower = text.toLowerCase();
    const isQuestion = lower.includes('?');
    const scores: Record<'doctor' | 'patient' | 'other_person', number> = {
      doctor: cueScore(lower, DOCTOR_CUES),
      patient: cueScore(lower, PATIENT_CUES),
      other_person: cueScore(lower, OTHER_PERSON_CUES),
    };

    // Generic clinical question: second-person + question mark.
    if (isQuestion && /\byour?\b/.test(lower)) scores.doctor += 2;
    // First-person declarative sentences lean patient.
    if (!isQuestion && /^\s*i\b/.test(lower)) scores.patient += 1;
    // Affirmation followed by a first-person statement ("Yes, I ...").
    if (/^\s*(yes|no)[,.! ]/.test(lower) && /\bi\b/.test(lower)) scores.patient += 1;

    const last = context.length > 0 ? context[context.length - 1] : null;
    if (last) {
      // Two-party alternation prior.
      if (last.speaker === Speaker.DOCTOR) scores.patient += 1;
      else if (last.speaker === Speaker.PATIENT) scores.doctor += 1;
      // Question -> answer adjacency: a doctor question makes a short
      // affirmation or first-person reply read as the patient.
      if (
        last.speaker === Speaker.DOCTOR &&
        last.text.includes('?') &&
        /^\s*(yes|no|i |it'?s |it is )/.test(lower)
      ) {
        scores.patient += 2;
      }
    }

    const ranked = (Object.entries(scores) as Array<[Speaker, number]>).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    const [winner, winnerScore] = ranked[0];
    const runnerUpScore = ranked[1][1];
    if (winnerScore >= 2 && winnerScore - runnerUpScore >= 1) return winner;
    return Speaker.UNKNOWN;
  }
}

// ---------------------------------------------------------------------------
// LLM attributor
// ---------------------------------------------------------------------------

export const SPEAKER_ATTRIBUTION_SYSTEM_PROMPT = `You label who is speaking in one finalized turn of a synthetic doctor-patient consultation.

Given the recent turns with their known speaker roles and the new turn's text, output ONLY the role of the NEW turn's speaker: doctor (the clinician: asks clinical questions, prescribes, instructs), patient (describes own symptoms or medications, answers the clinician), other_person (a companion speaking about the patient), or unknown when the text is not clearly attributable. Output no other content.`;

export const SPEAKER_ATTRIBUTION_JSON_SCHEMA = {
  name: 'speaker_attribution',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      speaker: { type: 'string', enum: ['doctor', 'patient', 'other_person', 'unknown'] },
      confidence: { type: 'number' },
    },
    required: ['speaker', 'confidence'],
  },
};

/**
 * One small structured-output call per finalized turn. Any failure (network,
 * HTTP, parse, out-of-enum) silently falls back to the deterministic
 * attributor — this sits inside the serialized per-encounter turn pipeline, so
 * it must always resolve, and quickly.
 */
export class LlmSpeakerAttributor implements SpeakerAttributor {
  constructor(
    public settings: Settings,
    private fallback: DeterministicSpeakerAttributor,
  ) {
    if (!settings.openai_api_key) {
      throw new Error('LlmSpeakerAttributor requires OPENAI_API_KEY');
    }
  }

  async attribute(input: SpeakerAttributionInput): Promise<SpeakerAttribution> {
    const model = this.settings.speaker_attribution_model ?? this.settings.extraction_model;
    const body = {
      model,
      messages: [
        { role: 'system', content: SPEAKER_ATTRIBUTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            recent_turns: input.context.map((t) => ({ speaker: t.speaker, text: t.text })),
            new_turn_text: input.text,
          }),
        },
      ],
      response_format: { type: 'json_schema', json_schema: SPEAKER_ATTRIBUTION_JSON_SCHEMA },
      temperature: 0,
    };
    try {
      const response = await fetch(`${this.settings.openai_base_url}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.openai_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.settings.speaker_attribution_timeout_ms),
      });
      if (!response.ok) {
        throw new Error(`provider returned ${response.status}`);
      }
      const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      const parsed = JSON.parse(json.choices[0].message.content) as {
        speaker?: unknown;
        confidence?: unknown;
      };
      if (typeof parsed.speaker !== 'string' || !SPEAKER_VALUES.includes(parsed.speaker)) {
        throw new Error(`invalid speaker ${JSON.stringify(parsed.speaker)}`);
      }
      const confidence =
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? Math.min(1, Math.max(0, parsed.confidence))
          : null;
      return { speaker: parsed.speaker as Speaker, source: 'inferred_llm', confidence, model };
    } catch {
      return this.fallback.attribute(input);
    }
  }
}

export function buildSpeakerAttributor(settings: Settings): SpeakerAttributor {
  const deterministic = new DeterministicSpeakerAttributor();
  if (!settings.demo_mode && liveExtractionAvailable(settings)) {
    return new LlmSpeakerAttributor(settings, deterministic);
  }
  return deterministic;
}
