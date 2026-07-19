"""Graph engine tests (spec §27.4): provenance, supersession, idempotency,
out-of-order recomputation, isolation, reset."""
import pytest

from app.encounter_service import DuplicateEventError
from app.models import Predicate, ResultState, SubjectRole
from tests.conftest import say

pytestmark = pytest.mark.asyncio


async def test_assertions_have_provenance(service):
    rt = service.create_encounter()
    await say(service, rt, "I take carbamazepine.")
    snap = rt.snapshot
    for a in snap.active_assertions():
        assert a.source_turn_id in {t.turn_id for t in snap.turns}


async def test_supersession_deactivates_and_links(service):
    rt = service.create_encounter()
    await say(service, rt, "I take carbamazepine.")
    snap = await say(service, rt, "Actually, I stopped carbamazepine last year.")
    carb = [a for a in snap.assertions if a.concept_id == "carbamazepine"]
    assert len(carb) == 2
    old = next(a for a in carb if a.predicate == Predicate.CURRENTLY_TAKES)
    new = next(a for a in carb if a.predicate == Predicate.HISTORICALLY_USED)
    assert not old.is_active and old.superseded_by_assertion_id == new.assertion_id
    assert new.is_active and new.supersedes_assertion_id == old.assertion_id


async def test_correction_supersedes_different_concept(service):
    rt = service.create_encounter()
    await say(service, rt, "I take carbamazepine.")
    snap = await say(service, rt, "Sorry, I meant lamotrigine.")
    active = {a.concept_id for a in snap.active_assertions()}
    assert "lamotrigine" in active
    assert "carbamazepine" not in active
    carb = next(a for a in snap.assertions if a.concept_id == "carbamazepine")
    assert not carb.is_active


async def test_duplicate_event_id_rejected(service):
    rt = service.create_encounter()
    await say(service, rt, "I take carbamazepine.", event_id="evt-dup")
    with pytest.raises(DuplicateEventError):
        await say(service, rt, "I take carbamazepine.", event_id="evt-dup")
    assert len(rt.snapshot.turns) == 1


async def test_duplicate_provider_item_rejected(service):
    rt = service.create_encounter()
    await say(service, rt, "I take carbamazepine.", provider_item_id="item-1")
    with pytest.raises(DuplicateEventError):
        await say(service, rt, "I take carbamazepine.", provider_item_id="item-1")
    assert len(rt.snapshot.turns) == 1


async def test_out_of_order_events_recompute_correctly(service):
    """A late-arriving earlier turn is replayed in sequence order: the later
    'stopped' statement must still win even though it was processed first."""
    rt = service.create_encounter()
    snap = await say(service, rt, "I stopped carbamazepine last year.", sequence=5)
    snap = await say(service, rt, "I take carbamazepine.", sequence=2)
    assert snap.turns[0].sequence == 2
    active_carb = [a for a in snap.active_assertions() if a.concept_id == "carbamazepine"]
    assert len(active_carb) == 1
    assert active_carb[0].predicate == Predicate.HISTORICALLY_USED


async def test_late_turn_flagged(service):
    rt = service.create_encounter()
    await say(service, rt, "I use the combined pill.", sequence=5)
    snap = await say(service, rt, "I take carbamazepine.", sequence=2)
    late = next(t for t in snap.turns if t.sequence == 2)
    assert late.arrived_late is True


async def test_encounter_isolation(service):
    rt1 = service.create_encounter()
    rt2 = service.create_encounter()
    await say(service, rt1, "I take carbamazepine and use the combined pill.")
    assert rt1.snapshot.result_state == ResultState.EVIDENCE_FOUND
    assert rt2.snapshot.result_state == ResultState.LISTENING
    assert rt2.snapshot.assertions == []


async def test_reset_clears_state(service):
    rt = service.create_encounter()
    await say(service, rt, "I take carbamazepine and use the combined pill.")
    assert rt.snapshot.result_state == ResultState.EVIDENCE_FOUND
    await service.reset_encounter(rt)
    assert rt.snapshot.result_state == ResultState.LISTENING
    assert rt.snapshot.assertions == []
    assert rt.snapshot.active_warnings() == []


async def test_other_person_never_patient_assertion(service):
    rt = service.create_encounter()
    snap = await say(service, rt, "My sister takes carbamazepine.")
    carb = [a for a in snap.assertions if a.concept_id == "carbamazepine"]
    assert all(a.subject == SubjectRole.OTHER_PERSON for a in carb)


async def test_contradiction_in_one_turn_abstains(service):
    rt = service.create_encounter()
    snap = await say(service, rt, "I take carbamazepine, but I am not taking carbamazepine.")
    assert snap.result_state == ResultState.MORE_INFORMATION_REQUIRED
    assert not [a for a in snap.active_assertions() if a.concept_id == "carbamazepine"]


async def test_stopped_session_ignores_turns(service):
    rt = service.create_encounter()
    await service.start_session(rt)
    await service.stop_session(rt)
    snap = await say(service, rt, "I take carbamazepine.")
    assert snap.turns == []
