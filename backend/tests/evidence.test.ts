/** Evidence dataset tests (spec §27.1). */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BACKEND_DIR } from '../src/config.ts';
import { REQUIRED_RECORD_FIELDS, VERIFY_MARKER } from '../src/evidenceIndex.ts';
import { index, strictIndex } from './helpers.ts';

describe('evidence dataset', () => {
  it('has all required schema fields on every record', () => {
    for (const [rid, record] of Object.entries(index.records)) {
      for (const field of REQUIRED_RECORD_FIELDS) {
        expect(record, `${rid} missing ${field}`).toHaveProperty(field);
      }
    }
  });

  it('contains exactly six records', () => {
    expect(Object.keys(index.records)).toHaveLength(6);
  });

  it('has no verification markers in runtime-eligible display fields', () => {
    const displayFields = ['interactionDirection', 'potentialConsequence', 'evidenceLevel', 'population', 'sourceSection'];
    for (const rid of index.runtimeEligibleIds()) {
      const record = index.records[rid];
      for (const field of displayFields) {
        expect(VERIFY_MARKER.test(String(record[field])), `${rid}.${field} has verification marker`).toBe(false);
      }
    }
  });

  it('has complete source metadata on every record', () => {
    for (const [rid, record] of Object.entries(index.records)) {
      expect(String(record.sourceUrl).startsWith('http'), rid).toBe(true);
      expect(String(record.sourceSection).trim(), rid).toBeTruthy();
      expect(String(record.sourceOrganization).trim(), rid).toBeTruthy();
      expect(String(record.sourceTitle).trim(), rid).toBeTruthy();
      expect(String(record.jurisdiction).trim(), rid).toBeTruthy();
      expect(record.lastVerified, rid).toBeTruthy();
    }
  });

  it('uses explicit class membership from ontology concepts only', () => {
    for (const [rid, record] of Object.entries(index.records)) {
      const members = record.interactingConceptIds as string[];
      expect(members.length, `${rid} lacks explicit members`).toBeGreaterThan(0);
      if (record.matchType === 'closed_class' || record.matchType === 'any_member') {
        expect(members.length, rid).toBeGreaterThanOrEqual(2);
      }
      // 'e.g.' lists are never machine-matching input; members must be ontology concepts.
      for (const cid of members) {
        expect(cid in index.ontology.medication_concepts, `${rid}: ${cid} not in ontology`).toBe(true);
      }
      for (const cid of record.hormonalConceptIds as string[]) {
        expect(cid in index.ontology.hormonal_concepts, `${rid}: ${cid} not in ontology`).toBe(true);
      }
    }
  });

  it('has no alias collisions', () => {
    expect(index.load_errors).toEqual([]);
  });

  it('keeps the lamotrigine interaction direction reversed', () => {
    const record = index.records['INT-005'];
    expect(record.interactionDirectionCode).toBe('CONTRACEPTIVE_AFFECTS_MEDICATION');
    const direction = String(record.interactionDirection).toLowerCase();
    expect(direction.includes('reverse') || direction.includes('reversed')).toBe(true);
    for (const rid of ['INT-001', 'INT-002', 'INT-003', 'INT-004', 'INT-006']) {
      expect(index.records[rid].interactionDirectionCode, rid).toBe('MEDICATION_AFFECTS_CONTRACEPTIVE');
    }
  });

  it('keeps INT-006 non-directive', () => {
    const consequence = String(index.records['INT-006'].potentialConsequence).toLowerCase();
    for (const banned of ['copper iud', 'double dose', 'doubling', '3 mg', 'should take']) {
      expect(consequence).not.toContain(banned);
    }
  });

  it('strict eligibility requires physician sign-off', () => {
    // No record is physician-verified yet, so under spec-strict rules none are
    // runtime-eligible and the pair index must be empty (no warnings possible).
    expect(strictIndex.runtimeEligibleIds()).toEqual([]);
    expect(strictIndex.pair_index.size).toBe(0);
  });

  it('labels pending-override records as sign-off pending', () => {
    for (const rid of index.runtimeEligibleIds()) {
      const report = index.reports[rid];
      expect(report.eligible_via_pending_override).toBe(true);
      expect(index.verificationStatus(rid)).toBe('physician_sign_off_pending');
    }
  });

  it('contains the expected concept pairs in the pair index', () => {
    const expected: Array<[string, string, string]> = [
      ['combined_hormonal_contraceptive', 'carbamazepine', 'INT-001'],
      ['combined_hormonal_contraceptive', 'rifampicin', 'INT-002'],
      ['combined_hormonal_contraceptive', 'rifabutin', 'INT-002'],
      ['progestogen_only_pill', 'carbamazepine', 'INT-003'],
      ['progestogen_only_pill', 'rifampicin', 'INT-003'],
      ['etonogestrel_implant', 'carbamazepine', 'INT-004'],
      ['estrogen_containing_oral_contraceptive', 'lamotrigine', 'INT-005'],
      ['combined_hormonal_contraceptive', 'lamotrigine', 'INT-005'],
      ['levonorgestrel_emergency_contraception', 'rifampicin', 'INT-006'],
      ['levonorgestrel_emergency_contraception', 'st_johns_wort', 'INT-006'],
    ];
    for (const [h, m, rid] of expected) {
      expect(index.lookupPair(h, m), `${h} × ${m}`).toContain(rid);
    }
  });

  it('returns no pair for unindexed combinations', () => {
    expect(index.lookupPair('combined_hormonal_contraceptive', 'phenytoin')).toEqual([]);
    expect(index.lookupPair('etonogestrel_implant', 'lamotrigine')).toEqual([]);
  });

  it('keeps medical prose identical to v1 (when the v1 file exists)', () => {
    // The v2 file may add machine metadata but never edit medical prose.
    const v1Path = path.resolve(BACKEND_DIR, '..', 'src', 'data', 'evidence_records.json');
    if (!existsSync(v1Path)) {
      return; // original moved; covered by the generation script check
    }
    const v1 = Object.fromEntries(
      (JSON.parse(readFileSync(v1Path, 'utf8')).records as Array<{ id: string }>).map((r) => [r.id, r]),
    ) as Record<string, Record<string, unknown>>;
    const prose = ['interactionDirection', 'potentialConsequence', 'clinicianConsideration',
      'evidenceLevel', 'population', 'sourceTitle', 'sourceUrl', 'sourceSection', 'limitations'];
    for (const [rid, record] of Object.entries(index.records)) {
      for (const field of prose) {
        expect(record[field], `${rid}.${field} drifted from v1`).toEqual(v1[rid][field]);
      }
    }
  });
});
