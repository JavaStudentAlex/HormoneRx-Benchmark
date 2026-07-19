/** Context classification tests: status, subject, corrections (spec §27.3, §15). */
import { describe, expect, it } from 'vitest';

import { DeterministicExtractor } from '../src/deterministicExtractor.ts';
import { ExtractedMention, MentionCategory, Speaker, TurnExtraction } from '../src/models.ts';
import { index, makeTurn } from './helpers.ts';

function extract(text: string, speaker: Speaker = 'patient'): TurnExtraction {
  return new DeterministicExtractor(index).extractSync(makeTurn(text, speaker));
}

function find(extraction: TurnExtraction, category: MentionCategory): ExtractedMention[] {
  return extraction.mentions.filter((m) => m.category === category);
}

describe('context classification', () => {
  it('classifies current use', () => {
    const e = extract('I take carbamazepine.');
    const [m] = find(e, 'other_medication');
    expect(m.status).toBe('current');
    expect(m.subject).toBe('patient');
  });

  it('attributes third-person clinical notes to the patient', () => {
    const e = extract('She is on Tegretol.', 'doctor');
    const [m] = find(e, 'other_medication');
    expect(m.subject).toBe('patient');
    expect(m.status).toBe('current');
  });

  it('classifies historical use', () => {
    const e = extract('I stopped carbamazepine last year.');
    const [m] = find(e, 'other_medication');
    expect(m.status).toBe('historical');
  });

  it('classifies negation', () => {
    const e = extract('I do not take carbamazepine.');
    const [m] = find(e, 'other_medication');
    expect(m.status).toBe('negated');
  });

  it('classifies "denies" as negation', () => {
    const e = extract('She denies any use of rifampicin.', 'doctor');
    const [m] = find(e, 'other_medication');
    expect(m.status).toBe('negated');
  });

  it('classifies planned use', () => {
    const e = extract('I am planning to start lamotrigine next month.');
    const [m] = find(e, 'other_medication');
    expect(m.status).toBe('planned');
  });

  it('treats doctor "we will start" as planned patient use', () => {
    const e = extract('We will start carbamazepine next week.', 'doctor');
    const [m] = find(e, 'other_medication');
    expect(m.status).toBe('planned');
    expect(m.subject).toBe('patient');
  });

  it('attributes family-member statements to the other person', () => {
    const e = extract('My sister takes carbamazepine.');
    const [m] = find(e, 'other_medication');
    expect(m.subject).toBe('other_person');
  });

  it('marks doctor discussion as uncertain, not patient medication', () => {
    const e = extract('The doctor explained what carbamazepine is.', 'doctor');
    const [m] = find(e, 'other_medication');
    expect(m.status).toBe('uncertain');
  });

  it('binds negation to the nearest entity', () => {
    const e = extract('She uses a combined oral contraceptive but is not taking carbamazepine.', 'doctor');
    const hormonal = find(e, 'hormonal_product');
    const meds = find(e, 'other_medication');
    expect(hormonal[0].status).toBe('current');
    expect(meds[0].status).toBe('negated');
  });

  it('extracts multiple medications from one turn', () => {
    const e = extract(
      'The patient takes amlodipine, ramipril and carbamazepine daily, and uses a combined oral contraceptive.',
      'doctor',
    );
    const meds = find(e, 'other_medication');
    const surfaces = new Set(meds.map((m) => m.surface_text.toLowerCase()));
    for (const expected of ['amlodipine', 'ramipril', 'carbamazepine']) {
      expect(surfaces).toContain(expected);
    }
    expect(meds.every((m) => m.status === 'current')).toBe(true);
  });

  it('detects explicit corrections', () => {
    const e = extract('Sorry, I meant lamotrigine.');
    expect(e.corrections.length).toBeGreaterThan(0);
    expect(e.corrections[0].replacement_surface_text?.toLowerCase()).toBe('lamotrigine');
  });

  it('flags uncertain medication names as missing information', () => {
    const e = extract('She takes something for her epilepsy but cannot recall the name.', 'doctor');
    expect(e.missing_information).toContain('Specific medication name is not stated.');
  });

  it('produces spans pointing at the surface text', () => {
    const text = 'I take Tegretol.';
    const e = extract(text);
    const [m] = find(e, 'other_medication');
    expect(text.slice(m.span_start as number, m.span_end as number)).toBe('Tegretol');
  });
});
