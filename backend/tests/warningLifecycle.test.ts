/** Warning lifecycle tests (spec §27.5, §18). */
import { describe, expect, it } from 'vitest';

import { activeAssertions, activeWarnings, newId } from '../src/models.ts';
import { makeService, say } from './helpers.ts';

describe('warning lifecycle', () => {
  it('creates a warning on a positive match', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    const snap = await say(service, rt, 'I use the combined pill and take carbamazepine.');
    expect(snap.result_state).toBe('EVIDENCE_FOUND');
    const warnings = activeWarnings(snap);
    expect(warnings).toHaveLength(1);
    const [w] = warnings;
    expect(w.evidence_record_id).toBe('INT-001');
    expect(w.display_label).toBe('Potentially relevant evidence found');
    const activeIds = new Set(activeAssertions(snap).map((a) => a.assertion_id));
    for (const aid of w.trigger_assertion_ids) {
      expect(activeIds).toContain(aid);
    }
  });

  it('creates no warning in a negated context', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    const snap = await say(service, rt, 'I use the combined pill but I am not taking carbamazepine.');
    expect(snap.result_state).toBe('EXCLUDED_CONTEXT');
    expect(activeWarnings(snap)).toEqual([]);
  });

  it('creates no active warning for historical use', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    const snap = await say(service, rt, 'I use the combined pill. I stopped carbamazepine last year.');
    expect(snap.result_state).toBe('EXCLUDED_CONTEXT');
    expect(activeWarnings(snap)).toEqual([]);
  });

  it('retracts with a visible reason after a correction', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill and take Tegretol.');
    const snap = await say(service, rt, 'Sorry, I stopped Tegretol last year.');
    expect(['RETRACTED', 'EXCLUDED_CONTEXT']).toContain(snap.result_state);
    const retracted = snap.warnings.filter((w) => w.state === 'retracted');
    expect(retracted).toHaveLength(1);
    expect(retracted[0].retraction_reason).toContain('historical');
    expect(retracted[0].retracted_by_turn_id).not.toBeNull();
  });

  it('retracts the old warning and creates the new one in the same recompute', async () => {
    // A correction to a different interacting drug retracts the old warning and
    // creates the new one in the same recompute.
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use an estrogen-containing pill and take carbamazepine.');
    const snap = await say(service, rt, 'Sorry, I meant lamotrigine.');
    expect(snap.result_state).toBe('EVIDENCE_FOUND');
    const active = activeWarnings(snap);
    expect(new Set(active.map((w) => w.evidence_record_id))).toEqual(new Set(['INT-005']));
    expect(snap.warnings.filter((w) => w.state === 'retracted')).toHaveLength(1);
  });

  it('labels proposed-prescription warnings with the proposed context', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill.');
    const snap = await service.proposePrescription(rt, {
      event_id: newId('evt'),
      surface_text: 'Lamotrigine',
    });
    const warnings = activeWarnings(snap);
    expect(warnings).toHaveLength(1);
    const [w] = warnings;
    expect(w.context).toBe('proposed_combination');
    expect(w.display_label.toLowerCase()).toContain('proposed');
    expect(w.evidence_record_id).toBe('INT-005');
  });

  it('retracts when a proposal is cancelled', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill.');
    let snap = await service.proposePrescription(rt, {
      event_id: newId('evt'),
      surface_text: 'Carbamazepine',
    });
    const pid = snap.proposals[0].proposal_id;
    snap = await service.cancelPrescription(rt, { event_id: newId('evt'), proposal_id: pid });
    expect(activeWarnings(snap)).toEqual([]);
    const retracted = snap.warnings.filter((w) => w.state === 'retracted');
    expect(retracted.length).toBeGreaterThan(0);
    expect(retracted[0].retraction_reason).toContain('cancelled');
  });

  it('stays neutral when no record matches', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    const snap = await say(service, rt, 'I use the combined pill and take sertraline.');
    expect(snap.result_state).toBe('NO_VALIDATED_MATCH');
    expect(activeWarnings(snap)).toEqual([]);
  });

  it('abstains on ambiguous context', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    const snap = await say(service, rt, 'I take carbamazepine and use the pill.');
    expect(snap.result_state).toBe('MORE_INFORMATION_REQUIRED');
    expect(activeWarnings(snap)).toEqual([]);
  });

  it('never duplicates a warning for a synonym repeat', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill and take carbamazepine.');
    const snap = await say(service, rt, 'Yes, Tegretol is what I take every day.');
    expect(activeWarnings(snap)).toHaveLength(1);
  });

  it('carries the verbatim evidence record in the warning payload', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill and take carbamazepine.');
    const payload = service.warningPayload(activeWarnings(rt.snapshot)[0]);
    const record = service.index.getRecord('INT-001');
    expect(payload.evidence_record).toEqual(record); // verbatim, no generated text
  });

  it('labels warnings pending physician verification', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill and take carbamazepine.');
    const [w] = activeWarnings(rt.snapshot);
    expect(w.verification_status).toBe('physician_sign_off_pending');
  });

  it('never emits safety-claim strings (spec §5.2)', async () => {
    // No result payload may ever claim safety.
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill and take sertraline.');
    const payload = service.resultPayload(rt);
    const text = JSON.stringify(payload).toLowerCase();
    expect(text).toContain('does not establish that no interaction exists');
    // Scan for safety claims AFTER removing the mandated disclaimer, which
    // legitimately contains the words "no interaction exists" inside a negation.
    const scrubbed = text.replaceAll('this does not establish that no interaction exists.', '');
    for (const banned of ['this is safe', 'no interaction exists', 'prescription approved', 'prescription rejected']) {
      expect(scrubbed).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Danger-moment and contradiction coverage (v0.2.1 improvement pass)
// ---------------------------------------------------------------------------

describe('danger moments and contradictions', () => {
  it('re-creates the warning on re-affirmation after a flip-flop', async () => {
    // Flip-flop: negation retracts, re-affirmation must re-warn immediately.
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill and take carbamazepine.');
    let snap = await say(service, rt, 'Wait, no — I am not taking carbamazepine.');
    expect(activeWarnings(snap)).toEqual([]);
    snap = await say(service, rt, 'No wait, I do take carbamazepine every day.');
    expect(snap.result_state).toBe('EVIDENCE_FOUND');
    expect(new Set(activeWarnings(snap).map((w) => w.evidence_record_id))).toEqual(new Set(['INT-001']));
    expect(snap.warnings.filter((w) => w.state === 'retracted')).toHaveLength(1);
    // Both polarity flips are surfaced as resolved contradictions.
    expect(snap.conflict_notes).toHaveLength(2);
  });

  it('switches records when the hormonal product is corrected', async () => {
    // 'Sorry, I meant the combined pill' must supersede the earlier pill product
    // and move the warning from INT-003 to INT-001 in one recompute.
    const service = makeService();
    const rt = service.createEncounter();
    let snap = await say(service, rt, 'I take the mini pill and carbamazepine.');
    expect(new Set(activeWarnings(snap).map((w) => w.evidence_record_id))).toEqual(new Set(['INT-003']));
    snap = await say(service, rt, 'Sorry, I meant the combined pill.');
    expect(snap.result_state).toBe('EVIDENCE_FOUND');
    expect(new Set(activeWarnings(snap).map((w) => w.evidence_record_id))).toEqual(new Set(['INT-001']));
    const retracted = snap.warnings.filter((w) => w.state === 'retracted');
    expect(retracted).toHaveLength(1);
    expect(retracted[0].evidence_record_id).toBe('INT-003');
    const pop = snap.assertions.filter((a) => a.concept_id === 'progestogen_only_pill');
    expect(pop.length).toBeGreaterThan(0);
    expect(pop[0].is_active).toBe(false);
  });

  it('treats a planned hormonal product as a proposed pair', async () => {
    // Danger moment: contraception is being CONSIDERED while an enzyme inducer is
    // current — warn at proposal time, labeled proposed-context.
    const service = makeService();
    const rt = service.createEncounter();
    const snap = await say(
      service,
      rt,
      'She takes carbamazepine and is considering starting the combined pill.',
      { speaker: 'doctor' },
    );
    expect(snap.result_state).toBe('EVIDENCE_FOUND');
    const warnings = activeWarnings(snap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].evidence_record_id).toBe('INT-001');
    expect(warnings[0].context).toBe('proposed_combination');
  });

  it('produces a conflict note on a polarity flip', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I take carbamazepine.');
    const snap = await say(service, rt, 'Actually, I am not taking carbamazepine.');
    expect(snap.conflict_notes.some((n) => n.includes('contradicts the earlier statement'))).toBe(true);
    // Resolved flips are informational; they never abstain by themselves.
    expect(snap.result_state).not.toBe('MORE_INFORMATION_REQUIRED');
  });

  it('asks for clarification when multiple pill products are active', async () => {
    // Two mutually exclusive pill products active at once: warn on both
    // (cautious) AND ask which one is actually in use.
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the mini pill and take carbamazepine.');
    const snap = await say(service, rt, 'I also use the combined pill.');
    const records = new Set(activeWarnings(snap).map((w) => w.evidence_record_id));
    expect(records).toEqual(new Set(['INT-001', 'INT-003']));
    expect(snap.missing_information.some((m) => m.includes('confirm which one is in use'))).toBe(true);
    expect(snap.result_state).toBe('EVIDENCE_FOUND');
  });
});
