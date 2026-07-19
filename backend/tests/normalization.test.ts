/** Normalization tests (spec §27.2). */
import { describe, expect, it } from 'vitest';

import {
  ExtractedMention,
  MentionCategory,
  makeExtractedMention,
} from '../src/models.ts';
import { ConceptNormalizer } from '../src/normalizer.ts';
import { index } from './helpers.ts';

function mention(surface: string, category: MentionCategory = 'other_medication'): ExtractedMention {
  return makeExtractedMention({
    surface_text: surface,
    category,
    status: 'current',
    subject: 'patient',
    certainty: 'explicit',
    source_turn_id: 'turn-1',
  });
}

const normalizer = new ConceptNormalizer(index);

describe('hormonal normalization', () => {
  it.each([
    ['combined pill', 'combined_hormonal_contraceptive'],
    ['COC', 'combined_hormonal_contraceptive'],
    ['combined oral contraceptive', 'combined_hormonal_contraceptive'],
    ['Nexplanon', 'etonogestrel_implant'],
    ['morning-after pill', 'levonorgestrel_emergency_contraception'],
    ['mini pill', 'progestogen_only_pill'],
    ['estrogen-containing pill', 'estrogen_containing_oral_contraceptive'],
  ])('normalizes %s -> %s', (surface, expected) => {
    const result = normalizer.normalizeOne(mention(surface, 'hormonal_product'));
    expect(result.concept_id).toBe(expected);
    expect(result.normalization_status).toBe('normalized');
  });
});

describe('medication normalization', () => {
  it.each([
    ['Tegretol', 'carbamazepine'],
    ['carbamazepine', 'carbamazepine'],
    ['carbamazapine', 'carbamazepine'], // documented misspelling
    ['carbamezapine', 'carbamazepine'], // documented misspelling
    ['Lamictal', 'lamotrigine'],
    ['rifampin', 'rifampicin'], // US name -> UK concept
    ['rifampicin', 'rifampicin'],
    ['Mycobutin', 'rifabutin'],
    ["St John's wort", 'st_johns_wort'],
  ])('normalizes %s -> %s', (surface, expected) => {
    const result = normalizer.normalizeOne(mention(surface));
    expect(result.concept_id).toBe(expected);
    expect(result.normalization_status).toBe('normalized');
  });
});

describe('ambiguity and unknowns', () => {
  it('treats "the pill" as ambiguous, never guessed', () => {
    const result = normalizer.normalizeOne(mention('the pill', 'hormonal_product'));
    expect(result.normalization_status).toBe('ambiguous');
    expect(result.concept_id).toBeNull();
    expect(result.candidate_concept_ids).toContain('combined_hormonal_contraceptive');
    expect(result.missing_information).toBeTruthy();
  });

  it('treats class words as ambiguous, not concepts', () => {
    const result = normalizer.normalizeOne(mention('enzyme inducer'));
    expect(result.normalization_status).toBe('ambiguous');
    expect(result.concept_id).toBeNull();
  });

  it('keeps unknown medications unknown', () => {
    const result = normalizer.normalizeOne(mention('zaltrapan'));
    expect(result.normalization_status).toBe('unknown');
    expect(result.concept_id).toBeNull();
    expect(result.missing_information).toBeTruthy();
  });

  it('recognizes the non-interacting lexicon', () => {
    const result = normalizer.normalizeOne(mention('paracetamol'));
    expect(result.normalization_status).toBe('non_interacting');
    expect(result.concept_id).toBeNull();
  });
});
