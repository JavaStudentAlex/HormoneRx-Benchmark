"""FastAPI application: session control, encounter WebSocket, text fallback,
demo-script replay, audit export, benchmark trigger, and realtime credentials
(spec §19, §21).
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .audit import build_audit_export
from .config import get_settings
from .deterministic_extractor import EXTRACTOR_VERSION
from .encounter_service import DuplicateEventError, EncounterService
from .evidence_index import EvidenceIndex, EvidenceValidationError
from .extractor import build_extractor
from .models import EventType, Speaker, new_id
from .realtime_session import RealtimeSessionError, mint_client_secret

logger = logging.getLogger("hormonerx")

settings = get_settings()
logging.basicConfig(level=settings.log_level)

try:
    evidence_index = EvidenceIndex(
        settings.evidence_path,
        settings.synonym_path,
        strict=settings.strict_evidence_validation,
        allow_pending_verification=settings.evidence_allow_pending_verification,
    )
except EvidenceValidationError as err:
    # Strict mode: fail startup listing schema errors (spec §36).
    raise SystemExit(f"Evidence validation failed in strict mode:\n- " + "\n- ".join(err.errors))

extractor = build_extractor(settings, evidence_index)
service = EncounterService(settings, evidence_index, extractor)

DEMO_SCRIPTS = json.loads((Path(__file__).resolve().parent.parent / "data" / "demo_scripts.json").read_text())

app = FastAPI(title="HormoneRx Realtime Backend", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class CreateEncounterRequest(BaseModel):
    synthetic_demo: bool = True


class TextTurnRequest(BaseModel):
    event_id: str = Field(default_factory=lambda: new_id("evt"))
    speaker: Speaker = Speaker.PATIENT
    text: str
    sequence: int | None = None


class ProposalRequest(BaseModel):
    event_id: str = Field(default_factory=lambda: new_id("evt"))
    medication_surface_text: str


class CancelProposalRequest(BaseModel):
    event_id: str = Field(default_factory=lambda: new_id("evt"))
    proposal_id: str


# ---------------------------------------------------------------------------
# Health and metadata
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "app_env": settings.app_env,
        "demo_mode": settings.demo_mode,
        "live_extraction_available": settings.live_extraction_available,
        "live_transcription_available": bool(settings.openai_api_key),
        "extraction_model": (
            settings.extraction_model if settings.live_extraction_available and not settings.demo_mode else EXTRACTOR_VERSION
        ),
        "transcription_model": settings.transcription_model,
        "evidence": evidence_index.eligibility_summary(),
    }


@app.get("/api/evidence")
async def evidence() -> dict:
    return {
        "datasetVersion": evidence_index.dataset_version,
        "records": list(evidence_index.records.values()),
        "eligibility": evidence_index.eligibility_summary(),
    }


@app.get("/api/demo-scripts")
async def demo_scripts() -> dict:
    return DEMO_SCRIPTS


# ---------------------------------------------------------------------------
# Realtime credentials (spec §21.1)
# ---------------------------------------------------------------------------

@app.post("/api/realtime/session")
async def realtime_session() -> dict:
    try:
        return await mint_client_secret(settings)
    except RealtimeSessionError as err:
        raise HTTPException(status_code=503, detail=str(err))


# ---------------------------------------------------------------------------
# Encounters (spec §21.2)
# ---------------------------------------------------------------------------

@app.post("/api/encounters")
async def create_encounter(body: CreateEncounterRequest) -> dict:
    runtime = service.create_encounter(synthetic_demo=body.synthetic_demo)
    return {"encounter_id": runtime.encounter_id, "status": "created", "synthetic_demo": runtime.synthetic_demo}


def _get_runtime(encounter_id: str):
    try:
        return service.get(encounter_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown encounter")


@app.post("/api/encounters/{encounter_id}/start")
async def start_encounter(encounter_id: str) -> dict:
    runtime = _get_runtime(encounter_id)
    await service.start_session(runtime)
    return {"status": runtime.snapshot.status}


@app.post("/api/encounters/{encounter_id}/stop")
async def stop_encounter(encounter_id: str) -> dict:
    runtime = _get_runtime(encounter_id)
    await service.stop_session(runtime)
    return {"status": runtime.snapshot.status}


@app.post("/api/encounters/{encounter_id}/reset")
async def reset_encounter(encounter_id: str) -> dict:
    runtime = _get_runtime(encounter_id)
    await service.reset_encounter(runtime)
    return {"status": "reset"}


@app.post("/api/encounters/{encounter_id}/text-turn")
async def text_turn(encounter_id: str, body: TextTurnRequest) -> dict:
    """Text fallback: a typed statement processed exactly like a finalized turn."""
    runtime = _get_runtime(encounter_id)
    try:
        snapshot = await service.process_final_turn(
            runtime,
            event_id=body.event_id,
            text=body.text,
            speaker=body.speaker,
            sequence=body.sequence,
        )
    except DuplicateEventError as err:
        raise HTTPException(status_code=409, detail=str(err))
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err))
    return service.snapshot_payload(runtime)


@app.post("/api/encounters/{encounter_id}/proposals")
async def propose(encounter_id: str, body: ProposalRequest) -> dict:
    runtime = _get_runtime(encounter_id)
    try:
        await service.propose_prescription(
            runtime, event_id=body.event_id, surface_text=body.medication_surface_text
        )
    except DuplicateEventError as err:
        raise HTTPException(status_code=409, detail=str(err))
    return service.snapshot_payload(runtime)


@app.post("/api/encounters/{encounter_id}/proposals/cancel")
async def cancel_proposal(encounter_id: str, body: CancelProposalRequest) -> dict:
    runtime = _get_runtime(encounter_id)
    try:
        await service.cancel_prescription(runtime, event_id=body.event_id, proposal_id=body.proposal_id)
    except DuplicateEventError as err:
        raise HTTPException(status_code=409, detail=str(err))
    return service.snapshot_payload(runtime)


@app.get("/api/encounters/{encounter_id}/audit")
async def audit(encounter_id: str) -> dict:
    runtime = _get_runtime(encounter_id)
    label = getattr(extractor, "settings", None)
    extractor_label = settings.extraction_model if label else EXTRACTOR_VERSION
    return build_audit_export(runtime, extractor_label)


@app.get("/api/encounters/{encounter_id}/snapshot")
async def snapshot(encounter_id: str) -> dict:
    runtime = _get_runtime(encounter_id)
    return service.snapshot_payload(runtime)


# ---------------------------------------------------------------------------
# Demo-script replay
# ---------------------------------------------------------------------------

@app.post("/api/encounters/{encounter_id}/demo-script/{script_id}")
async def play_demo_script(encounter_id: str, script_id: str, speed: float = 1.0) -> dict:
    runtime = _get_runtime(encounter_id)
    script = next((s for s in DEMO_SCRIPTS["scripts"] if s["id"] == script_id), None)
    if script is None:
        raise HTTPException(status_code=404, detail="unknown demo script")
    asyncio.create_task(_replay_script(runtime, script, max(speed, 0.1)))
    return {"status": "playing", "script_id": script_id, "turns": len(script["turns"])}


async def _replay_script(runtime, script: dict, speed: float) -> None:
    for i, turn in enumerate(script["turns"]):
        text = turn["text"]
        speaker = Speaker(turn["speaker"])
        # Progressive partial captions (display only — never analyzed).
        words = text.split(" ")
        step = max(len(words) // 3, 1)
        for cut in range(step, len(words), step):
            partial = " ".join(words[:cut])
            await service._broadcast(
                runtime,
                {"type": "caption.updated", "speaker": speaker.value, "text": partial, "provisional": True},
            )
            await asyncio.sleep(0.25 / speed)
        await asyncio.sleep(0.2 / speed)
        try:
            await service.process_final_turn(
                runtime,
                event_id=new_id("evt"),
                text=text,
                speaker=speaker,
                provider_item_id=f"{script['id']}-item-{i + 1}",
            )
        except DuplicateEventError:
            logger.info("demo replay skipped duplicate turn %s", i)
        await asyncio.sleep(turn.get("pause_ms", 900) / 1000.0 / speed)


# ---------------------------------------------------------------------------
# Encounter WebSocket (spec §21.3)
# ---------------------------------------------------------------------------

@app.websocket("/ws/encounters/{encounter_id}")
async def encounter_ws(websocket: WebSocket, encounter_id: str) -> None:
    try:
        runtime = service.get(encounter_id)
    except KeyError:
        await websocket.close(code=4404)
        return
    await websocket.accept()
    runtime.subscribers.add(websocket)
    # A (re)connecting client always receives the current snapshot first.
    await websocket.send_json(service.snapshot_payload(runtime))
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "processing.error", "detail": "invalid JSON"})
                continue
            await _handle_client_event(runtime, websocket, message)
    except WebSocketDisconnect:
        pass
    finally:
        runtime.subscribers.discard(websocket)


@app.websocket("/ws/encounters/{encounter_id}/audio")
async def encounter_audio_ws(websocket: WebSocket, encounter_id: str) -> None:
    """Live-mode fallback transport: browser PCM16 frames relayed server-side to
    the realtime transcription provider (spec §7.2 alternative architecture).
    Requires OPENAI_API_KEY; the browser never sees provider credentials.

    Not exercisable without a provider key — see MORNING_REVIEW.md.
    """
    from .realtime_session import ProviderRelay, RealtimeSessionError

    try:
        runtime = service.get(encounter_id)
    except KeyError:
        await websocket.close(code=4404)
        return
    await websocket.accept()

    async def on_partial(text: str) -> None:
        await service._broadcast(
            runtime,
            {"type": "caption.updated", "speaker": runtime.active_speaker.value, "text": text, "provisional": True},
        )

    async def on_final(item_id: str | None, text: str) -> None:
        try:
            await service.process_final_turn(
                runtime,
                event_id=new_id("evt"),
                text=text,
                speaker=runtime.active_speaker,
                provider_item_id=item_id,
            )
        except DuplicateEventError:
            logger.info("audio relay ignored duplicate provider item %s", item_id)

    relay = ProviderRelay(settings, on_partial, on_final)
    try:
        await relay.connect()
    except RealtimeSessionError as err:
        runtime.store.append(EventType.TRANSCRIPTION_FAILED, {"error": str(err)})
        await websocket.send_json({"type": "processing.error", "detail": f"Live transcription unavailable: {err}"})
        await websocket.close(code=4503)
        return

    pump_task = asyncio.create_task(relay.pump())
    try:
        while True:
            frame = await websocket.receive()
            if frame.get("bytes") is not None:
                await relay.send_audio(frame["bytes"])
            elif frame.get("text") is not None:
                control = json.loads(frame["text"])
                if control.get("type") == "speaker.changed":
                    await service.change_speaker(runtime, Speaker(control.get("speaker", "patient")))
            elif frame.get("type") == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        pump_task.cancel()
        await relay.close()


async def _handle_client_event(runtime, websocket: WebSocket, message: dict) -> None:
    msg_type = message.get("type", "")
    try:
        if msg_type == "transcript.partial":
            speaker = Speaker(message.get("speaker", runtime.active_speaker.value))
            service.record_partial(runtime, message.get("text", ""), speaker)
            await service._broadcast(
                runtime,
                {
                    "type": "caption.updated",
                    "speaker": speaker.value,
                    "text": message.get("text", ""),
                    "provisional": True,
                },
            )
        elif msg_type == "transcript.final":
            await service.process_final_turn(
                runtime,
                event_id=message.get("event_id") or new_id("evt"),
                text=message.get("text", ""),
                speaker=Speaker(message.get("speaker", runtime.active_speaker.value)),
                sequence=message.get("sequence"),
                provider_item_id=message.get("provider_item_id"),
                started_at_ms=message.get("started_at_ms"),
                ended_at_ms=message.get("ended_at_ms"),
            )
        elif msg_type == "speaker.changed":
            await service.change_speaker(runtime, Speaker(message.get("speaker", "patient")))
        elif msg_type == "prescription.proposed":
            await service.propose_prescription(
                runtime,
                event_id=message.get("event_id") or new_id("evt"),
                surface_text=message.get("medication_surface_text", ""),
            )
        elif msg_type == "prescription.cancelled":
            await service.cancel_prescription(
                runtime,
                event_id=message.get("event_id") or new_id("evt"),
                proposal_id=message.get("proposal_id", ""),
            )
        elif msg_type == "session.start":
            await service.start_session(runtime)
        elif msg_type == "session.stop":
            await service.stop_session(runtime)
        elif msg_type == "encounter.reset":
            await service.reset_encounter(runtime)
        elif msg_type == "snapshot.request":
            await websocket.send_json(service.snapshot_payload(runtime))
        else:
            await websocket.send_json({"type": "processing.error", "detail": f"unknown event type {msg_type!r}"})
    except DuplicateEventError:
        # Idempotent: a duplicate final event is acknowledged but not reprocessed.
        await websocket.send_json({"type": "event.duplicate", "event_id": message.get("event_id")})
    except ValueError as err:
        await websocket.send_json({"type": "processing.error", "detail": str(err)})
