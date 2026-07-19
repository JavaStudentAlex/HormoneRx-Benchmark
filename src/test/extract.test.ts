import { describe, it, expect } from 'vitest';
import { extractDeterministic } from '../lib/extract';

describe('synonym normalization', () => {
  it('normalizes brand names to generic identifiers', () => {
    const e = extractDeterministic('She uses Nexplanon and takes Tegretol.');
    expect(e.hormonalProduct.normalized).toBe('Etonogestrel implant');
    expect(e.otherMedication.normalized).toBeTruthy();
    expect(e.shouldSearchEvidence).toBe(true);
  });

  it('normalizes a misspelled medication via documented synonyms', () => {
    const e = extractDeterministic('She uses a combined oral contraceptive and takes carbamazapine daily.');
    expect(e.otherMedication.raw?.toLowerCase()).toBe('carbamazapine');
    expect(e.shouldSearchEvidence).toBe(true);
  });
});

describe('negation classification', () => {
  it('classifies an explicitly negated medication', () => {
    const e = extractDeterministic('She uses a combined oral contraceptive but is not taking carbamazepine.');
    expect(e.otherMedication.status).toBe('negated');
    expect(e.hormonalProduct.status).toBe('current');
    expect(e.shouldSearchEvidence).toBe(false);
  });

  it('classifies a denied medication', () => {
    const e = extractDeterministic('She has the etonogestrel implant and denies any use of rifampicin.');
    expect(e.otherMedication.status).toBe('negated');
  });
});

describe('historical / temporality classification', () => {
  it('classifies past use as historical', () => {
    const e = extractDeterministic('She stopped carbamazepine last year and currently uses a combined oral contraceptive.');
    expect(e.otherMedication.status).toBe('historical');
    expect(e.shouldSearchEvidence).toBe(false);
  });

  it('classifies planned medication as planned', () => {
    const e = extractDeterministic('She uses a combined oral contraceptive and is planning to start carbamazepine next month.');
    expect(e.otherMedication.status).toBe('planned');
  });

  it('attributes a medication belonging to another person', () => {
    const e = extractDeterministic('She uses the combined pill. Her partner takes carbamazepine.');
    expect(e.otherMedication.status).toBe('other_person');
  });
});

describe('ambiguity detection', () => {
  it('marks an unspecified hormonal method as uncertain', () => {
    const e = extractDeterministic('She takes carbamazepine and says she uses contraception, but the method is unclear.');
    expect(e.hormonalProduct.normalized).toBeNull();
    expect(e.missingInformation.length).toBeGreaterThan(0);
  });

  it('marks an unnamed medication as uncertain', () => {
    const e = extractDeterministic('She uses a combined oral contraceptive and takes something for her epilepsy but cannot recall the name.');
    expect(e.otherMedication.status).toBe('uncertain');
    expect(e.shouldSearchEvidence).toBe(false);
  });
});
