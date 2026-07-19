import { describe, it, expect } from 'vitest';
import { evidenceDataset, evidenceRecords } from '../lib/evidence';
import demo from '../data/demo_cases.json';
import benchmark from '../data/benchmark_cases.json';

const REQUIRED_FIELDS = [
  'id', 'hormonalProduct', 'hormonalSynonyms', 'interactingMedication', 'medicationSynonyms',
  'interactionDirection', 'potentialConsequence', 'clinicianConsideration', 'evidenceLevel',
  'population', 'sourceTitle', 'sourceOrganization', 'sourceUrl', 'sourceSection', 'jurisdiction',
  'lastVerified', 'physicianVerified', 'limitations',
];

describe('evidence_records.json schema', () => {
  it('contains exactly six records', () => {
    expect(evidenceRecords).toHaveLength(6);
  });

  it('every record has all required fields', () => {
    for (const r of evidenceRecords) {
      for (const f of REQUIRED_FIELDS) {
        expect(r, `record ${(r as any).id} missing ${f}`).toHaveProperty(f);
      }
    }
  });

  it('clinicianConsideration is the fixed non-directive string', () => {
    for (const r of evidenceRecords) {
      expect(r.clinicianConsideration).toBe('Evidence to review in the individual clinical context.');
    }
  });

  it('has no unresolved [VERIFY] placeholders in any field', () => {
    for (const r of evidenceRecords) {
      for (const value of Object.values(r)) {
        const s = Array.isArray(value) ? value.join(' ') : String(value);
        expect(s.includes('[VERIFY]'), `record ${r.id} contains [VERIFY]`).toBe(false);
      }
    }
  });

  it('physicianVerified is boolean; any true record has non-empty sourceSection', () => {
    for (const r of evidenceRecords) {
      expect(typeof r.physicianVerified).toBe('boolean');
      if (r.physicianVerified) {
        expect(r.sourceSection.trim().length).toBeGreaterThan(0);
        expect(r.sourceUrl.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('record ids are unique', () => {
    const ids = evidenceRecords.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lamotrigine record (INT-005) is the reversed direction', () => {
    const rec = evidenceRecords.find((r) => r.id === 'INT-005')!;
    expect(rec.interactingMedication).toBe('Lamotrigine');
    expect(rec.interactionDirection.toLowerCase()).toContain('reduce exposure to the interacting medication');
  });

  it('levonorgestrel EC record (INT-006) consequence carries no dosing directive', () => {
    const rec = evidenceRecords.find((r) => r.id === 'INT-006')!;
    const c = rec.potentialConsequence.toLowerCase();
    expect(c).not.toContain('double');
    expect(c).not.toContain('copper');
    expect(c).not.toMatch(/should (use|take|switch)/);
  });

  it('dataset version is present', () => {
    expect(evidenceDataset.datasetVersion).toBeTruthy();
  });
});

describe('demo_cases.json', () => {
  it('has five cases with cached extractions', () => {
    const cases = (demo as any).cases;
    expect(cases).toHaveLength(5);
    for (const c of cases) {
      expect(c).toHaveProperty('cachedExtraction');
      expect(c.cachedExtraction).toHaveProperty('shouldSearchEvidence');
    }
  });
});

describe('benchmark_cases.json', () => {
  const cases = (benchmark as any).cases;
  it('has 18-20 cases matching the declared distribution', () => {
    expect(cases.length).toBeGreaterThanOrEqual(18);
    expect(cases.length).toBeLessThanOrEqual(20);
  });

  it('every case has immutable gold-label fields', () => {
    for (const c of cases) {
      for (const f of ['id', 'category', 'input', 'expectedResultState', 'expectedAbstention', 'rationale']) {
        expect(c, `case ${c.id} missing ${f}`).toHaveProperty(f);
      }
    }
  });

  it('only references products/medications present in the evidence dataset', () => {
    const validRecordIds = new Set(evidenceRecords.map((r) => r.id));
    for (const c of cases) {
      if (c.expectedEvidenceRecordId) {
        expect(validRecordIds.has(c.expectedEvidenceRecordId), `case ${c.id} references unknown record`).toBe(true);
      }
    }
  });
});
