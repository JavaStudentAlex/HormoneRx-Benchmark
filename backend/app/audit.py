"""Synthetic session audit export (spec §29).

The export answers: what was heard, what was extracted, what graph state was
created, which record matched, and why a warning changed — with schema and
model versions. Raw audio is never included.
"""
from __future__ import annotations

from .encounter_service import EncounterRuntime
from .models import SCHEMA_VERSION, EventType


def build_audit_export(runtime: EncounterRuntime, extractor_label: str) -> dict:
    snapshot = runtime.snapshot
    return {
        "audit_version": "0.2.0",
        "schema_version": SCHEMA_VERSION,
        "extraction_model": extractor_label,
        "encounter": {
            "encounter_id": runtime.encounter_id,
            "synthetic_demo": runtime.synthetic_demo,
            "status": snapshot.status,
            "started_at": snapshot.started_at.isoformat() if snapshot.started_at else None,
            "stopped_at": snapshot.stopped_at.isoformat() if snapshot.stopped_at else None,
            "created_at": runtime.created_at.isoformat(),
        },
        "final_transcript_turns": [t.model_dump(mode="json") for t in snapshot.turns],
        "extracted_mentions": [nm.model_dump(mode="json") for nm in snapshot.mentions],
        "graph_assertions": [a.model_dump(mode="json") for a in snapshot.assertions],
        "proposals": [p.model_dump(mode="json") for p in snapshot.proposals],
        "evidence_matches": [m.model_dump(mode="json") for m in snapshot.matches],
        "warning_lifecycle": [w.model_dump(mode="json") for w in snapshot.warnings],
        "result": {
            "state": snapshot.result_state.value,
            "lookup_reason": snapshot.lookup_reason,
            "missing_information": snapshot.missing_information,
            "excluded_notes": snapshot.excluded_notes,
        },
        "latency_measurements": [latency.model_dump(mode="json") for latency in snapshot.latencies],
        "event_log": [
            e.model_dump(mode="json")
            for e in runtime.store.events
            if e.event_type != EventType.TRANSCRIPT_PARTIAL_RECEIVED
        ],
        "processing_errors": [
            e.model_dump(mode="json")
            for e in runtime.store.events_of(EventType.EXTRACTION_FAILED, EventType.TRANSCRIPTION_FAILED)
        ],
    }
