/**
 * Sound agent — near-line summarizer of finalized audio segments.
 *
 * Given a finalized segment (transcript + optional acoustic features), it emits
 * APPENDED events for the event log, NOT real-time inference:
 *   - SOUND_MENTIONS_EXTRACTED  — a TurnExtraction-shaped medication/hormonal
 *     summary that feeds the EXISTING deterministic normalize -> reduce -> lookup
 *     path (stays strictly inside the extraction-only safety boundary).
 *   - AFFECT_SEGMENT_RECEIVED   — acoustic + emotion + distress JSON. ADVISORY:
 *     it carries confidence + provenance and NEVER enters pair eligibility or the
 *     warning engine.
 *   - RELATIONAL_SIGNAL_RECEIVED — talk-ratio / acknowledgement / possible
 *     dismissal at the encounter level (speculative; human review only).
 *
 * Layer 1 (this module, always-on, deterministic): a lexical distress heuristic
 * over the transcript + passthrough of any acoustic (eGeMAPS) features supplied.
 * Layer 2 (pluggable via AffectModel): a GPU SER model (e.g. SenseVoice /
 * audeering wav2vec2 AVD) or gpt-4o-audio, invoked only when audio is available.
 */
import {
  type AcousticFeatures,
  type AffectSegment,
  type CategoricalEmotion,
  type DistressFlag,
  EventType,
  type EncounterEvent,
  type RelationalSignal,
  type Speaker,
  type TranscriptTurn,
  type TurnExtraction,
  newId,
  utcnow,
} from './models.ts';

const RELIABILITY_AFFECT =
  'Heuristic affect signal — not a clinical determination. For human attention only.';
const RELIABILITY_RELATIONAL =
  'Speculative relational-safety signal — surfaces a raw conversational pattern for human review; asserts no conclusion.';

/** Layer-1 lexical distress cues (English). Deliberately explainable, not a model. */
const DISTRESS_CUES: Record<string, string[]> = {
  fear_anxiety: ['scared', 'afraid', 'anxious', 'anxiety', 'worried', 'worry', 'nervous', 'panic', 'panicking', 'terrified', 'frightened'],
  pain_distress: ['pain', 'hurts', 'hurting', 'suffering', 'unbearable', 'overwhelmed', 'crying', 'in tears', 'exhausted'],
  hopeless_dismissed: ['hopeless', 'no one listens', 'not listening', 'nobody cares', 'give up', 'giving up', "can't cope", 'cannot cope'],
  negated_wellbeing: ['not okay', 'not ok', 'not fine', 'not well', "don't feel right", 'something is wrong'],
};

/** Doctor acknowledgement cues — used only for the speculative relational signal. */
const ACK_CUES = ['understand', 'i hear you', 'that sounds', 'sorry to hear', "let's", 'we can', 'i can see', 'thank you for telling'];

const NEGATIVE_TEXT_EMOTIONS = ['fear', 'sadness', 'anger'];

/** Pluggable Layer-2 model (GPU SER / gpt-4o-audio). Absent in text-only runs. */
export interface AffectModel {
  name: string;
  /** Returns categorical/dimensional emotion + acoustic-event tags for an audio segment. */
  infer(input: { transcript: string; audioPath?: string; acoustic?: AcousticFeatures }): Promise<{
    categorical_emotion?: CategoricalEmotion;
    events?: string[];
    acoustic?: AcousticFeatures;
  }>;
}

export const NO_ACOUSTIC: AcousticFeatures = {
  f0_mean_hz: null, f0_std_hz: null, jitter: null, shimmer: null, hnr_db: null,
  loudness: null, speaking_rate_wps: null, pause_ratio: null, voice_breaks: null,
  feature_set: 'none-text-only', extractor: 'text-heuristic/0.1',
};

export const SOUND_AGENT_VERSION = 'sound-agent/0.1-text';

function lc(s: string): string {
  return s.toLowerCase();
}

/** Layer-1 text distress heuristic. Deterministic and explainable. */
export function textDistress(transcript: string): DistressFlag {
  const text = lc(transcript);
  const basis: string[] = [];
  for (const [category, cues] of Object.entries(DISTRESS_CUES)) {
    if (cues.some((c) => text.includes(c))) basis.push(`lexical:${category}`);
  }
  let level: DistressFlag['level'] = 'none';
  if (basis.length === 1) level = 'low';
  else if (basis.length >= 2) level = 'elevated';
  // A single hopeless/dismissed cue is weighted up.
  if (basis.includes('lexical:hopeless_dismissed') && level === 'low') level = 'elevated';
  return { level, basis, confidence: 'low', reliability: RELIABILITY_AFFECT };
}

/** Cheap text-modality categorical emotion (Layer-1 fallback for the transcript). */
export function textEmotion(transcript: string): CategoricalEmotion | null {
  const d = textDistress(transcript);
  if (d.level === 'none') return null;
  const label = d.basis.includes('lexical:fear_anxiety')
    ? 'fear'
    : d.basis.includes('lexical:pain_distress')
      ? 'sadness'
      : 'concern';
  return { label, score: d.level === 'elevated' ? 0.6 : 0.35, model: 'text-cue/0.1', modality: 'text' };
}

export class SoundAgent {
  private model: AffectModel | null;

  constructor(model: AffectModel | null = null) {
    this.model = model;
  }

  /** Build the AFFECT_SEGMENT_RECEIVED payload for one finalized segment. */
  async affectFor(
    encounterId: string,
    turn: Pick<TranscriptTurn, 'turn_id' | 'speaker' | 'text'>,
    acoustic: AcousticFeatures = NO_ACOUSTIC,
  ): Promise<AffectSegment> {
    let categorical = textEmotion(turn.text);
    let events: string[] = [];
    let acousticOut = acoustic;
    const models = [SOUND_AGENT_VERSION];

    if (this.model) {
      const out = await this.model.infer({ transcript: turn.text, acoustic });
      if (out.categorical_emotion) categorical = out.categorical_emotion;
      if (out.events) events = out.events;
      if (out.acoustic) acousticOut = out.acoustic;
      models.push(this.model.name);
    }

    return {
      segment_id: newId('seg'),
      encounter_id: encounterId,
      source_turn_id: turn.turn_id,
      speaker: turn.speaker,
      transcript: turn.text,
      acoustic: acousticOut,
      categorical_emotion: categorical,
      events,
      distress_flag: textDistress(turn.text),
      advisory: true,
      provenance: { models, created_at: utcnow() },
    };
  }

  /** Wrap an affect segment as an appendable, advisory event. */
  affectEvent(encounterId: string, segment: AffectSegment, sequence: number): EncounterEvent {
    return {
      event_id: newId('evt'),
      encounter_id: encounterId,
      event_type: EventType.AFFECT_SEGMENT_RECEIVED,
      occurred_at: utcnow(),
      sequence,
      provider_item_id: null,
      speaker: segment.speaker,
      payload: { affect: segment },
      schema_version: '1.0',
    };
  }

  /**
   * Wrap a TurnExtraction (produced by the deterministic/live extractor over the
   * segment transcript) as the sound agent's SOUND_MENTIONS_EXTRACTED event. This
   * is the "summarize -> insert into the DB" seam: identical payload shape to the
   * live path, so the reducer folds it in unchanged.
   */
  mentionsEvent(encounterId: string, extraction: TurnExtraction, speaker: Speaker, sequence: number): EncounterEvent {
    return {
      event_id: newId('evt'),
      encounter_id: encounterId,
      event_type: EventType.SOUND_MENTIONS_EXTRACTED,
      occurred_at: utcnow(),
      sequence,
      provider_item_id: null,
      speaker,
      payload: { extraction },
      schema_version: '1.0',
    };
  }

  /** Encounter-level relational-safety signal from the segment sequence. */
  relationalSignal(
    encounterId: string,
    turns: Array<{ speaker: Speaker; text: string; distress: DistressFlag }>,
  ): RelationalSignal {
    let doctorWords = 0;
    let totalWords = 0;
    let doctorTurns = 0;
    let patientTurns = 0;
    let patientDistressTurns = 0;
    let acknowledged: boolean | null = null;

    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const words = t.text.trim().split(/\s+/).filter(Boolean).length;
      totalWords += words;
      if (t.speaker === 'doctor') {
        doctorWords += words;
        doctorTurns++;
      } else if (t.speaker === 'patient') {
        patientTurns++;
        if (t.distress.level !== 'none') {
          patientDistressTurns++;
          // Did the next doctor turn acknowledge the distress?
          const next = turns[i + 1];
          if (next && next.speaker === 'doctor') {
            const ackd = ACK_CUES.some((c) => lc(next.text).includes(c));
            acknowledged = acknowledged === false ? false : ackd;
          } else {
            acknowledged = false;
          }
        }
      }
    }

    return {
      encounter_id: encounterId,
      clinician_talk_ratio: totalWords ? Math.round((doctorWords / totalWords) * 1000) / 1000 : null,
      patient_turns: patientTurns,
      doctor_turns: doctorTurns,
      patient_distress_turns: patientDistressTurns,
      patient_emotion_acknowledged: patientDistressTurns ? acknowledged : null,
      possible_dismissal: patientDistressTurns > 0 && acknowledged === false,
      confidence: 'speculative',
      reliability: RELIABILITY_RELATIONAL,
    };
  }
}
