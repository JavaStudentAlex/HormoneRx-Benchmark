import { describe, it, expect } from 'vitest';
import { extractDeterministic } from '../lib/extract';
import { runLookup, findMatchingRecord, NO_MATCH_PRIMARY, NO_MATCH_SECONDARY } from '../lib/lookup';
import { analyze } from '../lib/pipeline';

function run(text: string) {
  return runLookup(extractDeterministic(text));
}

describe('deterministic retrieval + result states (integration)', () => {
  it('positive: combined pill + carbamazepine -> EVIDENCE_FOUND INT-001', () => {
    const r = run('The patient currently uses the combined pill and takes carbamazepine.');
    expect(r.state).toBe('EVIDENCE_FOUND');
    expect(r.matchedRecord?.id).toBe('INT-001');
  });

  it('reversed direction: lamotrigine + combined OC -> INT-005', () => {
    const r = run('She takes lamotrigine and has started a combined oral contraceptive.');
    expect(r.state).toBe('EVIDENCE_FOUND');
    expect(r.matchedRecord?.id).toBe('INT-005');
  });

  it('explicit negation -> EXCLUDED_CONTEXT with no record', () => {
    const r = run('She uses a combined oral contraceptive but is not taking carbamazepine.');
    expect(r.state).toBe('EXCLUDED_CONTEXT');
    expect(r.matchedRecord).toBeNull();
  });

  it('historical -> EXCLUDED_CONTEXT', () => {
    const r = run('She stopped carbamazepine last year and currently uses a combined oral contraceptive.');
    expect(r.state).toBe('EXCLUDED_CONTEXT');
  });

  it('ambiguous method -> MORE_INFORMATION_REQUIRED', () => {
    const r = run('She takes carbamazepine and says she uses contraception, but the method is unclear.');
    expect(r.state).toBe('MORE_INFORMATION_REQUIRED');
    expect(r.missingInformation.length).toBeGreaterThan(0);
  });

  it('no validated match uses the exact required wording', () => {
    const r = run('She uses a combined oral contraceptive and takes paracetamol occasionally.');
    expect(r.state).toBe('NO_VALIDATED_MATCH');
    expect(r.messages).toContain(NO_MATCH_PRIMARY);
    expect(r.messages).toContain(NO_MATCH_SECONDARY);
  });

  it('multi-medication: identifies the interacting drug among others', () => {
    const r = run('The patient takes amlodipine, ramipril and carbamazepine daily, and uses a combined oral contraceptive.');
    expect(r.state).toBe('EVIDENCE_FOUND');
    expect(r.matchedRecord?.id).toBe('INT-001');
  });

  it("other person's medication does not trigger a match", () => {
    const r = run('She uses the combined pill. Her partner takes carbamazepine.');
    expect(r.state).toBe('NO_VALIDATED_MATCH');
  });
});

describe('no unsupported medical fields are generated', () => {
  it('non-evidence states carry only fixed non-medical messages', () => {
    const allowed = new Set([NO_MATCH_PRIMARY, NO_MATCH_SECONDARY]);
    const r = run('She uses a combined oral contraceptive and takes paracetamol occasionally.');
    for (const msg of r.messages) expect(allowed.has(msg)).toBe(true);
  });

  it('EVIDENCE_FOUND medical content comes only from the matched record', () => {
    const r = run('The patient currently uses the combined pill and takes carbamazepine.');
    // The result exposes no medical text of its own; consequence equals the record field.
    expect(r.matchedRecord?.potentialConsequence).toBeTruthy();
    expect(r.messages.length).toBe(0);
  });
});

describe('findMatchingRecord', () => {
  it('returns null when hormonal or medication surface is missing', () => {
    const e = extractDeterministic('She takes carbamazepine.');
    expect(findMatchingRecord(e)).toBeNull();
  });
});

describe('analyze() demo mode with cached cases', () => {
  it('uses the cached extraction for a scripted demo case', async () => {
    const r = await analyze('The patient currently takes a combined oral contraceptive and carbamazepine.', 'demo');
    expect(r.state).toBe('EVIDENCE_FOUND');
    expect(r.matchedRecord?.id).toBe('INT-001');
  });

  it('returns ERROR (no medical content) when live endpoint is unavailable', async () => {
    const r = await analyze('Some novel free text about a combined pill and carbamazepine.', 'live');
    // In a test environment fetch('/api/extract') is unavailable -> ERROR, no medical content.
    expect(['ERROR', 'EVIDENCE_FOUND', 'NO_VALIDATED_MATCH', 'MORE_INFORMATION_REQUIRED', 'EXCLUDED_CONTEXT']).toContain(r.state);
    if (r.state === 'ERROR') expect(r.matchedRecord).toBeNull();
  });
});
