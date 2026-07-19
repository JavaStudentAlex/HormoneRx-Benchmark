/**
 * Graph engine tests (spec §27.4): provenance, supersession, idempotency,
 * out-of-order recomputation, isolation, reset.
 */
import { describe, expect, it } from 'vitest';

import { DuplicateEventError } from '../src/encounterService.ts';
import { activeAssertions, activeWarnings } from '../src/models.ts';
import { makeService, say } from './helpers.ts';

describe('graph engine', () => {
  it('gives every active assertion transcript provenance', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I take carbamazepine.');
    const snap = rt.snapshot;
    const turnIds = new Set(snap.turns.map((t) => t.turn_id));
    for (const a of activeAssertions(snap)) {
      expect(turnIds).toContain(a.source_turn_id);
    }
  });

  it('supersession deactivates and links both assertions', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I take carbamazepine.');
    const snap = await say(service, rt, 'Actually, I stopped carbamazepine last year.');
    const carb = snap.assertions.filter((a) => a.concept_id === 'carbamazepine');
    expect(carb).toHaveLength(2);
    const old = carb.find((a) => a.predicate === 'CURRENTLY_TAKES')!;
    const fresh = carb.find((a) => a.predicate === 'HISTORICALLY_USED')!;
    expect(old.is_active).toBe(false);
    expect(old.superseded_by_assertion_id).toBe(fresh.assertion_id);
    expect(fresh.is_active).toBe(true);
    expect(fresh.supersedes_assertion_id).toBe(old.assertion_id);
  });

  it('corrections supersede a different concept of the same category', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I take carbamazepine.');
    const snap = await say(service, rt, 'Sorry, I meant lamotrigine.');
    const active = new Set(activeAssertions(snap).map((a) => a.concept_id));
    expect(active).toContain('lamotrigine');
    expect(active).not.toContain('carbamazepine');
    const carb = snap.assertions.find((a) => a.concept_id === 'carbamazepine')!;
    expect(carb.is_active).toBe(false);
  });

  it('rejects duplicate event ids', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I take carbamazepine.', { event_id: 'evt-dup' });
    await expect(say(service, rt, 'I take carbamazepine.', { event_id: 'evt-dup' })).rejects.toThrow(
      DuplicateEventError,
    );
    expect(rt.snapshot.turns).toHaveLength(1);
  });

  it('rejects duplicate provider item ids', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I take carbamazepine.', { provider_item_id: 'item-1' });
    await expect(
      say(service, rt, 'I take carbamazepine.', { provider_item_id: 'item-1' }),
    ).rejects.toThrow(DuplicateEventError);
    expect(rt.snapshot.turns).toHaveLength(1);
  });

  it('recomputes correctly for out-of-order events', async () => {
    // A late-arriving earlier turn is replayed in sequence order: the later
    // 'stopped' statement must still win even though it was processed first.
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I stopped carbamazepine last year.', { sequence: 5 });
    const snap = await say(service, rt, 'I take carbamazepine.', { sequence: 2 });
    expect(snap.turns[0].sequence).toBe(2);
    const activeCarb = activeAssertions(snap).filter((a) => a.concept_id === 'carbamazepine');
    expect(activeCarb).toHaveLength(1);
    expect(activeCarb[0].predicate).toBe('HISTORICALLY_USED');
  });

  it('flags late-arriving turns', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I use the combined pill.', { sequence: 5 });
    const snap = await say(service, rt, 'I take carbamazepine.', { sequence: 2 });
    const late = snap.turns.find((t) => t.sequence === 2)!;
    expect(late.arrived_late).toBe(true);
  });

  it('isolates encounters from each other', async () => {
    const service = makeService();
    const rt1 = service.createEncounter();
    const rt2 = service.createEncounter();
    await say(service, rt1, 'I take carbamazepine and use the combined pill.');
    expect(rt1.snapshot.result_state).toBe('EVIDENCE_FOUND');
    expect(rt2.snapshot.result_state).toBe('LISTENING');
    expect(rt2.snapshot.assertions).toEqual([]);
  });

  it('clears all state on reset', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await say(service, rt, 'I take carbamazepine and use the combined pill.');
    expect(rt.snapshot.result_state).toBe('EVIDENCE_FOUND');
    await service.resetEncounter(rt);
    expect(rt.snapshot.result_state).toBe('LISTENING');
    expect(rt.snapshot.assertions).toEqual([]);
    expect(activeWarnings(rt.snapshot)).toEqual([]);
  });

  it('never makes patient assertions from other-person statements', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    const snap = await say(service, rt, 'My sister takes carbamazepine.');
    const carb = snap.assertions.filter((a) => a.concept_id === 'carbamazepine');
    expect(carb.every((a) => a.subject === 'other_person')).toBe(true);
  });

  it('abstains on a same-turn contradiction', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    const snap = await say(service, rt, 'I take carbamazepine, but I am not taking carbamazepine.');
    expect(snap.result_state).toBe('MORE_INFORMATION_REQUIRED');
    expect(activeAssertions(snap).filter((a) => a.concept_id === 'carbamazepine')).toEqual([]);
  });

  it('ignores turns after the session stopped', async () => {
    const service = makeService();
    const rt = service.createEncounter();
    await service.startSession(rt);
    await service.stopSession(rt);
    const snap = await say(service, rt, 'I take carbamazepine.');
    expect(snap.turns).toEqual([]);
  });
});
