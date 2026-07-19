"""Warning lifecycle tests (spec §27.5, §18)."""
import pytest

from app.models import ResultState, WarningContext
from tests.conftest import say

pytestmark = pytest.mark.asyncio


async def test_positive_match_creates_warning(service):
    rt = service.create_encounter()
    snap = await say(service, rt, "I use the combined pill and take carbamazepine.")
    assert snap.result_state == ResultState.EVIDENCE_FOUND
    (w,) = snap.active_warnings()
    assert w.evidence_record_id == "INT-001"
    assert w.display_label == "Potentially relevant evidence found"
    assert set(w.trigger_assertion_ids) <= {a.assertion_id for a in snap.active_assertions()}


async def test_negated_context_no_warning(service):
    rt = service.create_encounter()
    snap = await say(service, rt, "I use the combined pill but I am not taking carbamazepine.")
    assert snap.result_state == ResultState.EXCLUDED_CONTEXT
    assert not snap.active_warnings()


async def test_historical_context_no_active_warning(service):
    rt = service.create_encounter()
    snap = await say(service, rt, "I use the combined pill. I stopped carbamazepine last year.")
    assert snap.result_state == ResultState.EXCLUDED_CONTEXT
    assert not snap.active_warnings()


async def test_correction_retracts_with_visible_reason(service):
    rt = service.create_encounter()
    await say(service, rt, "I use the combined pill and take Tegretol.")
    snap = await say(service, rt, "Sorry, I stopped Tegretol last year.")
    assert snap.result_state in (ResultState.RETRACTED, ResultState.EXCLUDED_CONTEXT)
    retracted = [w for w in snap.warnings if w.state == "retracted"]
    assert len(retracted) == 1
    assert "historical" in retracted[0].retraction_reason
    assert retracted[0].retracted_by_turn_id is not None


async def test_retraction_then_new_evidence(service):
    """A correction to a different interacting drug retracts the old warning and
    creates the new one in the same recompute."""
    rt = service.create_encounter()
    await say(service, rt, "I use an estrogen-containing pill and take carbamazepine.")
    snap = await say(service, rt, "Sorry, I meant lamotrigine.")
    assert snap.result_state == ResultState.EVIDENCE_FOUND
    active = snap.active_warnings()
    assert {w.evidence_record_id for w in active} == {"INT-005"}
    retracted = [w for w in snap.warnings if w.state == "retracted"]
    assert len(retracted) == 1


async def test_proposed_prescription_context(service):
    from app.models import new_id

    rt = service.create_encounter()
    await say(service, rt, "I use the combined pill.")
    snap = await service.propose_prescription(rt, event_id=new_id("evt"), surface_text="Lamotrigine")
    (w,) = snap.active_warnings()
    assert w.context == WarningContext.PROPOSED_COMBINATION
    assert "proposed" in w.display_label.lower()
    assert w.evidence_record_id == "INT-005"


async def test_cancelled_proposal_retracts(service):
    from app.models import new_id

    rt = service.create_encounter()
    await say(service, rt, "I use the combined pill.")
    snap = await service.propose_prescription(rt, event_id=new_id("evt"), surface_text="Carbamazepine")
    pid = snap.proposals[0].proposal_id
    snap = await service.cancel_prescription(rt, event_id=new_id("evt"), proposal_id=pid)
    assert not snap.active_warnings()
    retracted = [w for w in snap.warnings if w.state == "retracted"]
    assert retracted and "cancelled" in retracted[0].retraction_reason


async def test_no_record_neutral_state(service):
    rt = service.create_encounter()
    snap = await say(service, rt, "I use the combined pill and take sertraline.")
    assert snap.result_state == ResultState.NO_VALIDATED_MATCH
    assert not snap.active_warnings()


async def test_ambiguous_context_abstains(service):
    rt = service.create_encounter()
    snap = await say(service, rt, "I take carbamazepine and use the pill.")
    assert snap.result_state == ResultState.MORE_INFORMATION_REQUIRED
    assert not snap.active_warnings()


async def test_no_duplicate_warning_for_synonym_repeat(service):
    rt = service.create_encounter()
    await say(service, rt, "I use the combined pill and take carbamazepine.")
    snap = await say(service, rt, "Yes, Tegretol is what I take every day.")
    assert len(snap.active_warnings()) == 1


async def test_warning_carries_verbatim_record_payload(service):
    rt = service.create_encounter()
    await say(service, rt, "I use the combined pill and take carbamazepine.")
    payload = service.warning_payload(rt.snapshot.active_warnings()[0])
    record = service.index.get_record("INT-001")
    assert payload["evidence_record"] == record  # verbatim, no generated text


async def test_warning_labels_pending_verification(service):
    rt = service.create_encounter()
    await say(service, rt, "I use the combined pill and take carbamazepine.")
    (w,) = rt.snapshot.active_warnings()
    assert w.verification_status.value == "physician_sign_off_pending"


async def test_no_safe_state_strings(service):
    """No result payload may ever claim safety (spec §5.2)."""
    rt = service.create_encounter()
    snap = await say(service, rt, "I use the combined pill and take sertraline.")
    payload = service.result_payload(rt)
    text = str(payload).lower()
    assert "does not establish that no interaction exists" in text
    # Scan for safety claims AFTER removing the mandated disclaimer, which
    # legitimately contains the words "no interaction exists" inside a negation.
    scrubbed = text.replace("this does not establish that no interaction exists.", "")
    for banned in ("this is safe", "no interaction exists", "prescription approved", "prescription rejected"):
        assert banned not in scrubbed
