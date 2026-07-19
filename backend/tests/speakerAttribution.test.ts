/**
 * Speaker-role attribution: heuristic classifier, LLM adapter fallback chain,
 * builder gating, and the ingestion-time resolution rules (explicit always
 * wins; inference is persisted once and never recomputed on replay).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../src/config.ts';
import { DeterministicExtractor } from '../src/deterministicExtractor.ts';
import { EncounterService } from '../src/encounterService.ts';
import { EventType, Speaker, newId } from '../src/models.ts';
import {
  ATTRIBUTOR_VERSION,
  DeterministicSpeakerAttributor,
  LlmSpeakerAttributor,
  buildSpeakerAttributor,
} from '../src/speakerAttribution.ts';
import { index, makeService, makeTurn } from './helpers.ts';

const attributor = new DeterministicSpeakerAttributor();

function attribute(text: string, context: ReturnType<typeof makeTurn>[] = []) {
  return attributor.attribute({ text, context });
}

describe('DeterministicSpeakerAttributor', () => {
  it('labels clinical second-person questions as doctor', async () => {
    const result = await attribute('Are you currently taking any regular medication?');
    expect(result.speaker).toBe('doctor');
    expect(result.source).toBe('inferred_heuristic');
    expect(result.confidence).toBeNull();
    expect(result.model).toBe(ATTRIBUTOR_VERSION);
  });

  it('labels intake greetings as doctor', async () => {
    expect((await attribute('What brings you in today?')).speaker).toBe('doctor');
  });

  it('labels prescribing language as doctor even in first person', async () => {
    const result = await attribute("I'm going to prescribe lamotrigine, start you on 25 mg.");
    expect(result.speaker).toBe('doctor');
  });

  it('labels a first-person answer after a doctor question as patient', async () => {
    const context = [makeTurn('Are you taking anything for the seizures?', 'doctor')];
    expect((await attribute('Yes, I take Tegretol.', context)).speaker).toBe('patient');
  });

  it('labels first-person symptom statements as patient', async () => {
    expect((await attribute('I feel dizzy in the mornings.')).speaker).toBe('patient');
  });

  it('labels first-person questions as patient, not doctor', async () => {
    expect((await attribute('Should I stop taking it?')).speaker).toBe('patient');
  });

  it('labels companion self-identification as other_person', async () => {
    const result = await attribute("I'm her husband — she takes her pill every morning.");
    expect(result.speaker).toBe('other_person');
    expect((await attribute('I am her husband, I just drove her here.')).speaker).toBe('other_person');
  });

  it('abstains to unknown on unattributable text', async () => {
    expect((await attribute('Okay.')).speaker).toBe('unknown');
    expect((await attribute("That's fine.")).speaker).toBe('unknown');
  });

  it('resolves a bare affirmation after a doctor question via adjacency', async () => {
    const context = [makeTurn('Any allergies to medication?', 'doctor')];
    expect((await attribute('Yes.', context)).speaker).toBe('patient');
  });

  it('is deterministic', async () => {
    const context = [makeTurn('Are you taking anything?', 'doctor')];
    const a = await attribute('Yes, I take Tegretol.', context);
    const b = await attribute('Yes, I take Tegretol.', context);
    expect(a).toEqual(b);
  });
});

describe('LlmSpeakerAttributor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const llmSettings = defaultSettings({ demo_mode: false, openai_api_key: 'sk-test' });

  function stubFetch(response: () => Promise<Response>) {
    const mock = vi.fn((_input: string | URL, _init?: RequestInit) => response());
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  function okResponse(content: unknown): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { status: 200 },
    );
  }

  it('returns the model-labeled speaker with clamped confidence', async () => {
    const mock = stubFetch(async () => okResponse({ speaker: 'doctor', confidence: 0.93 }));
    const llm = new LlmSpeakerAttributor(llmSettings, new DeterministicSpeakerAttributor());
    const result = await llm.attribute({ text: 'Any allergies?', context: [] });
    expect(result).toEqual({
      speaker: 'doctor',
      source: 'inferred_llm',
      confidence: 0.93,
      model: llmSettings.extraction_model,
    });
    const body = JSON.parse(String(mock.mock.calls[0][1]?.body));
    expect(body.temperature).toBe(0);
    expect(body.model).toBe(llmSettings.extraction_model);
    expect(body.response_format.json_schema.name).toBe('speaker_attribution');
  });

  it('uses the dedicated model override when configured', async () => {
    const mock = stubFetch(async () => okResponse({ speaker: 'patient', confidence: 1 }));
    const settings = defaultSettings({
      demo_mode: false,
      openai_api_key: 'sk-test',
      speaker_attribution_model: 'gpt-4o',
    });
    const llm = new LlmSpeakerAttributor(settings, new DeterministicSpeakerAttributor());
    const result = await llm.attribute({ text: 'I take Tegretol.', context: [] });
    expect(result.model).toBe('gpt-4o');
    expect(JSON.parse(String(mock.mock.calls[0][1]?.body)).model).toBe('gpt-4o');
  });

  it('falls back to the heuristic on HTTP errors', async () => {
    stubFetch(async () => new Response('overloaded', { status: 500 }));
    const llm = new LlmSpeakerAttributor(llmSettings, new DeterministicSpeakerAttributor());
    const result = await llm.attribute({ text: 'What brings you in today?', context: [] });
    expect(result.source).toBe('inferred_heuristic');
    expect(result.speaker).toBe('doctor');
  });

  it('falls back when the model returns an out-of-enum speaker', async () => {
    stubFetch(async () => okResponse({ speaker: 'narrator', confidence: 0.9 }));
    const llm = new LlmSpeakerAttributor(llmSettings, new DeterministicSpeakerAttributor());
    const result = await llm.attribute({ text: 'I take Tegretol.', context: [] });
    expect(result.source).toBe('inferred_heuristic');
    expect(result.speaker).toBe('patient');
  });

  it('falls back when the request rejects (timeout/abort)', async () => {
    stubFetch(async () => {
      throw new DOMException('aborted', 'TimeoutError');
    });
    const llm = new LlmSpeakerAttributor(llmSettings, new DeterministicSpeakerAttributor());
    const result = await llm.attribute({ text: 'Okay.', context: [] });
    expect(result.source).toBe('inferred_heuristic');
    expect(result.speaker).toBe('unknown');
  });

  it('requires an API key', () => {
    expect(() => new LlmSpeakerAttributor(defaultSettings(), new DeterministicSpeakerAttributor())).toThrow();
  });
});

describe('buildSpeakerAttributor', () => {
  it('is deterministic in demo mode', () => {
    expect(buildSpeakerAttributor(defaultSettings())).toBeInstanceOf(DeterministicSpeakerAttributor);
  });

  it('is LLM-backed only with a key outside demo mode', () => {
    expect(
      buildSpeakerAttributor(defaultSettings({ demo_mode: false, openai_api_key: 'sk-test' })),
    ).toBeInstanceOf(LlmSpeakerAttributor);
    expect(buildSpeakerAttributor(defaultSettings({ demo_mode: false }))).toBeInstanceOf(
      DeterministicSpeakerAttributor,
    );
  });
});

describe('ingestion-time speaker resolution', () => {
  it('infers and persists the speaker for a label-less turn', async () => {
    const service = makeService();
    const runtime = service.createEncounter();
    const snapshot = await service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: 'Are you currently taking any regular medication?',
    });
    const turn = snapshot.turns[0];
    expect(turn.speaker).toBe('doctor');
    expect(turn.speaker_source).toBe('inferred_heuristic');
    const event = runtime.store.eventsOf(EventType.TRANSCRIPT_FINAL_RECEIVED)[0];
    expect(event.speaker).toBe('doctor');
    const provenance = event.payload.speaker_attribution as Record<string, unknown>;
    expect(provenance.source).toBe('inferred_heuristic');
    expect(provenance.model).toBe(ATTRIBUTOR_VERSION);
    expect(typeof provenance.attribution_ms).toBe('number');
  });

  it('never overrides an explicitly supplied speaker', async () => {
    const service = makeService();
    const runtime = service.createEncounter();
    const snapshot = await service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: 'Are you currently taking any regular medication?',
      speaker: Speaker.PATIENT,
    });
    const turn = snapshot.turns[0];
    expect(turn.speaker).toBe('patient');
    expect(turn.speaker_source).toBeUndefined();
    const event = runtime.store.eventsOf(EventType.TRANSCRIPT_FINAL_RECEIVED)[0];
    expect(event.payload.speaker_attribution).toBeUndefined();
  });

  it('treats a client speaker.changed as an explicit override', async () => {
    const service = makeService();
    const runtime = service.createEncounter();
    await service.changeSpeaker(runtime, Speaker.DOCTOR);
    const snapshot = await service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: 'I take Tegretol.',
    });
    expect(snapshot.turns[0].speaker).toBe('doctor');
    expect(snapshot.turns[0].speaker_source).toBeUndefined();
  });

  it('kill switch restores the legacy active_speaker fallback', async () => {
    const settings = defaultSettings({ speaker_attribution_enabled: false });
    const service = new EncounterService(settings, index, new DeterministicExtractor(index));
    const runtime = service.createEncounter();
    const snapshot = await service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: 'Are you currently taking any regular medication?',
    });
    expect(snapshot.turns[0].speaker).toBe('patient'); // legacy default
    expect(snapshot.turns[0].speaker_source).toBe('default');
  });

  it('serializes rapid label-less turns so inference sees prior resolutions', async () => {
    const service = makeService();
    const runtime = service.createEncounter();
    // Fire both without awaiting the first: the per-encounter mutex must let
    // turn 2's attribution see turn 1's resolved doctor label (a bare "Yes."
    // is only attributable via question->answer adjacency).
    const first = service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: 'Are you taking any regular medication?',
    });
    const second = service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: 'Yes.',
    });
    await Promise.all([first, second]);
    const turns = runtime.snapshot.turns;
    expect(turns).toHaveLength(2);
    // Sequences number store events, not turns — only their order matters.
    expect(turns[1].sequence).toBeGreaterThan(turns[0].sequence);
    expect(turns[0].speaker).toBe('doctor');
    expect(turns[1].speaker).toBe('patient');
  });

  it('rebuilds deterministically from a log containing inferred turns', async () => {
    const service = makeService();
    const runtime = service.createEncounter();
    await service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: 'Are you taking any regular medication?',
    });
    await service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: 'Yes, I take Tegretol and the combined pill.',
    });
    const stateA = service.reducer.rebuild(runtime.store.events);
    const stateB = service.reducer.rebuild(runtime.store.events);
    expect(JSON.stringify([...stateA.assertions.values()])).toBe(
      JSON.stringify([...stateB.assertions.values()]),
    );
    expect(stateA.assertions.size).toBeGreaterThan(0);
    const rebuiltTurn = stateA.turns.find((t) => t.turn_id === 'turn-1');
    expect(rebuiltTurn?.speaker).toBe('doctor');
    expect(rebuiltTurn?.speaker_source).toBe('inferred_heuristic');
  });
});
