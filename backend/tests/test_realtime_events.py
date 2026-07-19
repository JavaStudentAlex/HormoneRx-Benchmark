"""Realtime event-routing tests (spec §27.6): partials never touch the graph,
provider relay parsing, stop semantics."""
import json

import pytest

from app.config import Settings
from app.models import ResultState, Speaker
from app.realtime_session import ProviderRelay, RealtimeSessionError
from tests.conftest import say

pytestmark = pytest.mark.asyncio


async def test_partial_deltas_never_update_graph(service):
    rt = service.create_encounter()
    await service.start_session(rt)
    version_before = rt.snapshot.version
    # A partial containing a full positive pair must not create anything.
    service.record_partial(rt, "I use the combined pill and take carbamazepine", Speaker.PATIENT)
    assert rt.snapshot.version == version_before
    assert rt.snapshot.assertions == []
    assert rt.snapshot.active_warnings() == []
    assert rt.snapshot.result_state == ResultState.LISTENING


async def test_partials_not_stored_by_default(service):
    rt = service.create_encounter()
    service.record_partial(rt, "I use the combined pill", Speaker.PATIENT)
    from app.models import EventType

    assert service.settings.store_transcripts is False
    assert rt.store.events_of(EventType.TRANSCRIPT_PARTIAL_RECEIVED) == []


async def test_stop_listening_stops_processing(service):
    rt = service.create_encounter()
    await service.start_session(rt)
    await service.stop_session(rt)
    snap = await say(service, rt, "I use the combined pill and take carbamazepine.")
    assert snap.turns == []
    assert snap.active_warnings() == []


async def test_speaker_change_recorded(service):
    from app.models import EventType

    rt = service.create_encounter()
    await service.change_speaker(rt, Speaker.DOCTOR)
    assert rt.active_speaker == Speaker.DOCTOR
    assert len(rt.store.events_of(EventType.SPEAKER_CHANGED)) == 1


async def test_provider_relay_routes_delta_and_completed():
    partials, finals = [], []

    async def on_partial(text):
        partials.append(text)

    async def on_final(item_id, text):
        finals.append((item_id, text))

    relay = ProviderRelay(Settings(), on_partial, on_final)
    await relay.handle_provider_event(
        json.dumps({"type": "conversation.item.input_audio_transcription.delta", "delta": "I take "})
    )
    await relay.handle_provider_event(
        json.dumps(
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "item_id": "item_7",
                "transcript": "I take Tegretol.",
            }
        )
    )
    assert partials == ["I take "]
    assert finals == [("item_7", "I take Tegretol.")]


async def test_relay_requires_api_key():
    relay = ProviderRelay(Settings(openai_api_key=None), None, None)
    with pytest.raises(RealtimeSessionError):
        await relay.connect(websockets_connect=lambda *a, **k: None)


async def test_mint_client_secret_requires_key():
    from app.realtime_session import mint_client_secret

    with pytest.raises(RealtimeSessionError):
        await mint_client_secret(Settings(openai_api_key=None))
