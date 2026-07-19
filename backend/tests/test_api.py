"""API tests (spec §27): REST + WebSocket contract, snapshot on reconnect,
duplicate handling, audit export."""
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def create_encounter() -> str:
    response = client.post("/api/encounters", json={"synthetic_demo": True})
    assert response.status_code == 200
    return response.json()["encounter_id"]


def test_health():
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "evidence" in body
    assert body["evidence"]["recordCount"] == 6


def test_evidence_endpoint_lists_eligibility():
    body = client.get("/api/evidence").json()
    assert len(body["records"]) == 6
    assert "pendingPhysicianSignOff" in body["eligibility"]


def test_realtime_session_without_key_is_503():
    response = client.post("/api/realtime/session")
    assert response.status_code == 503


def test_text_turn_flow():
    enc = create_encounter()
    response = client.post(
        f"/api/encounters/{enc}/text-turn",
        json={"speaker": "patient", "text": "I take carbamazepine and use the combined pill."},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["result"]["state"] == "EVIDENCE_FOUND"
    assert body["result"]["active_warnings"][0]["evidence_record_id"] == "INT-001"
    # Medical wording is served verbatim from the record.
    assert body["result"]["active_warnings"][0]["evidence_record"]["id"] == "INT-001"


def test_duplicate_text_turn_conflict():
    enc = create_encounter()
    payload = {"event_id": "evt-1", "speaker": "patient", "text": "I take carbamazepine."}
    assert client.post(f"/api/encounters/{enc}/text-turn", json=payload).status_code == 200
    assert client.post(f"/api/encounters/{enc}/text-turn", json=payload).status_code == 409


def test_empty_turn_rejected():
    enc = create_encounter()
    response = client.post(
        f"/api/encounters/{enc}/text-turn", json={"speaker": "patient", "text": "   "}
    )
    assert response.status_code == 422


def test_unknown_encounter_404():
    assert client.get("/api/encounters/enc-nope/snapshot").status_code == 404


def test_proposal_endpoints():
    enc = create_encounter()
    client.post(f"/api/encounters/{enc}/text-turn", json={"speaker": "patient", "text": "I use the combined pill."})
    body = client.post(
        f"/api/encounters/{enc}/proposals", json={"medication_surface_text": "Lamotrigine"}
    ).json()
    assert body["result"]["state"] == "EVIDENCE_FOUND"
    proposal_id = body["proposals"][0]["proposal_id"]
    body = client.post(
        f"/api/encounters/{enc}/proposals/cancel", json={"proposal_id": proposal_id}
    ).json()
    assert body["result"]["state"] in ("RETRACTED", "MORE_INFORMATION_REQUIRED")
    assert body["result"]["active_warnings"] == []


def test_websocket_snapshot_and_final_turn():
    enc = create_encounter()
    with client.websocket_connect(f"/ws/encounters/{enc}") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "encounter.snapshot"
        ws.send_json(
            {
                "type": "transcript.final",
                "event_id": "evt-ws-1",
                "sequence": 1,
                "speaker": "patient",
                "text": "I take Tegretol and use the combined pill.",
            }
        )
        types = []
        record_ids = []
        for _ in range(10):
            msg = ws.receive_json()
            types.append(msg["type"])
            if msg["type"] == "warning.created":
                record_ids.append(msg["warning"]["evidence_record_id"])
            if msg["type"] == "result.updated":
                final_result = msg
                break
        assert "graph.updated" in types
        assert "warning.created" in types
        assert record_ids == ["INT-001"]
        assert final_result["result"]["state"] == "EVIDENCE_FOUND"
        assert final_result["result"]["latency_ms"]["total_ms"] > 0

        # Duplicate final event over WS is acknowledged, not reprocessed.
        ws.send_json(
            {
                "type": "transcript.final",
                "event_id": "evt-ws-1",
                "sequence": 1,
                "speaker": "patient",
                "text": "I take Tegretol and use the combined pill.",
            }
        )
        msg = ws.receive_json()
        assert msg["type"] == "event.duplicate"

    # Reconnect: snapshot reflects current state.
    with client.websocket_connect(f"/ws/encounters/{enc}") as ws:
        snapshot = ws.receive_json()
        assert snapshot["result"]["state"] == "EVIDENCE_FOUND"
        assert len(snapshot["turns"]) == 1


def test_websocket_partial_only_updates_captions():
    enc = create_encounter()
    with client.websocket_connect(f"/ws/encounters/{enc}") as ws:
        ws.receive_json()
        ws.send_json({"type": "transcript.partial", "speaker": "patient", "text": "I take carbam"})
        msg = ws.receive_json()
        assert msg["type"] == "caption.updated"
        assert msg["provisional"] is True
    snapshot = client.get(f"/api/encounters/{enc}/snapshot").json()
    assert snapshot["turns"] == []
    assert snapshot["result"]["state"] == "LISTENING"


def test_audit_export_completeness():
    enc = create_encounter()
    client.post(f"/api/encounters/{enc}/text-turn", json={"speaker": "patient", "text": "I take Tegretol and use the combined pill."})
    client.post(f"/api/encounters/{enc}/text-turn", json={"speaker": "patient", "text": "Sorry, I stopped Tegretol last year."})
    audit = client.get(f"/api/encounters/{enc}/audit").json()
    assert audit["final_transcript_turns"]
    assert audit["extracted_mentions"]
    assert audit["graph_assertions"]
    assert audit["warning_lifecycle"]
    retracted = [w for w in audit["warning_lifecycle"] if w["state"] == "retracted"]
    assert retracted and retracted[0]["retraction_reason"]
    assert audit["latency_measurements"]
    assert audit["event_log"]
    assert "raw_audio" not in str(audit)


def test_demo_scripts_listed():
    body = client.get("/api/demo-scripts").json()
    ids = [s["id"] for s in body["scripts"]]
    assert "demo-1-incremental-positive" in ids
    assert len(ids) == 5
