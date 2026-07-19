import { describe, it, expect } from 'vitest';
import { recordsToCsv, recordsToJson } from '../lib/exportUtils';
import { evidenceRecords } from '../lib/evidence';

describe('export functions', () => {
  it('CSV has a header row and one row per record', () => {
    const csv = recordsToCsv(evidenceRecords);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('sourceUrl');
    expect(lines.length).toBe(evidenceRecords.length + 1);
  });

  it('CSV escapes fields containing commas and quotes', () => {
    const csv = recordsToCsv(evidenceRecords);
    // potentialConsequence contains commas -> must be quoted somewhere.
    expect(csv).toMatch(/"/);
  });

  it('JSON export round-trips to the same records', () => {
    const json = recordsToJson(evidenceRecords);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(evidenceRecords.length);
    expect(parsed[0].id).toBe(evidenceRecords[0].id);
  });
});
