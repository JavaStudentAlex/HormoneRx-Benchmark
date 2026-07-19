"""Per-encounter runtime: event routing, the graph update algorithm (spec §14),
warning reconciliation, latency measurement, and state publication.

Concurrency: one asyncio.Lock per encounter serializes finalized-turn
processing so two turns can never interleave graph updates (spec §19.5).
Idempotency: duplicate event IDs / provider item IDs are rejected before any
state changes (spec §19.6).
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from .config import Settings
from .deterministic_extractor import DeterministicExtractor
from .event_store import EncounterEventStore
from .evidence_index import EvidenceIndex
from .extractor import ExtractionError, MedicationContextExtractor
from .graph_reducer import EncounterGraphReducer, GraphState
from .graph_validator import GraphValidator
from .models import (
    EncounterSnapshot,
    EventType,
    MentionCategory,
    PrescriptionProposal,
    ResultState,
    Speaker,
    TranscriptTurn,
    TurnLatency,
    WarningRecord,
    new_id,
    utcnow,
)
from .normalizer import ConceptNormalizer
from .warning_engine import ReconcileOutcome, WarningEngine

logger = logging.getLogger("hormonerx.encounter")


class DuplicateEventError(Exception):
    pass


class EncounterRuntime:
    def __init__(self, encounter_id: str, synthetic_demo: bool = True):
        self.encounter_id = encounter_id
        self.synthetic_demo = synthetic_demo
        self.store = EncounterEventStore(encounter_id)
        self.lock = asyncio.Lock()
        self.snapshot = EncounterSnapshot(encounter_id=encounter_id, synthetic_demo=synthetic_demo)
        self.warnings: list[WarningRecord] = []
        self.latencies: list[TurnLatency] = []
        self.subscribers: set = set()  # WebSocket connections
        self.active_speaker: Speaker = Speaker.PATIENT
        self.created_at = utcnow()


class EncounterService:
    def __init__(
        self,
        settings: Settings,
        index: EvidenceIndex,
        extractor: MedicationContextExtractor,
    ):
        self.settings = settings
        self.index = index
        self.extractor = extractor
        self.fallback_extractor = DeterministicExtractor(index)
        self.normalizer = ConceptNormalizer(index)
        self.reducer = EncounterGraphReducer(index)
        self.validator = GraphValidator(index)
        self.warning_engine = WarningEngine(index)
        self.encounters: dict[str, EncounterRuntime] = {}

    # -- lifecycle ----------------------------------------------------------

    def create_encounter(self, synthetic_demo: bool = True) -> EncounterRuntime:
        encounter_id = new_id("enc")
        runtime = EncounterRuntime(encounter_id, synthetic_demo=synthetic_demo)
        self.encounters[encounter_id] = runtime
        return runtime

    def get(self, encounter_id: str) -> EncounterRuntime:
        return self.encounters[encounter_id]

    async def start_session(self, runtime: EncounterRuntime) -> None:
        async with runtime.lock:
            runtime.store.append(EventType.SESSION_STARTED, {"synthetic_demo": runtime.synthetic_demo})
            await self._recompute(runtime, latest_turn=None)

    async def stop_session(self, runtime: EncounterRuntime) -> None:
        async with runtime.lock:
            runtime.store.append(EventType.SESSION_STOPPED, {})
            await self._recompute(runtime, latest_turn=None)

    async def reset_encounter(self, runtime: EncounterRuntime) -> None:
        async with runtime.lock:
            runtime.store.append(EventType.SESSION_RESET, {})
            runtime.warnings = []
            runtime.latencies = []
            await self._recompute(runtime, latest_turn=None)

    async def change_speaker(self, runtime: EncounterRuntime, speaker: Speaker) -> None:
        runtime.active_speaker = speaker
        runtime.store.append(EventType.SPEAKER_CHANGED, {"speaker": speaker.value}, speaker=speaker)

    # -- transcript events --------------------------------------------------

    def record_partial(self, runtime: EncounterRuntime, text: str, speaker: Speaker) -> None:
        """Partials update captions only. They never touch the graph (spec §7.4)."""
        if self.settings.store_transcripts:
            runtime.store.append(
                EventType.TRANSCRIPT_PARTIAL_RECEIVED,
                {"text": text},
                speaker=speaker,
            )

    async def process_final_turn(
        self,
        runtime: EncounterRuntime,
        *,
        event_id: str,
        text: str,
        speaker: Speaker,
        sequence: int | None = None,
        provider_item_id: str | None = None,
        started_at_ms: int | None = None,
        ended_at_ms: int | None = None,
    ) -> EncounterSnapshot:
        async with runtime.lock:
            if runtime.store.has_event_id(event_id):
                raise DuplicateEventError(f"duplicate event_id {event_id}")
            if provider_item_id and runtime.store.has_provider_item(provider_item_id):
                raise DuplicateEventError(f"duplicate provider_item_id {provider_item_id}")
            if not text.strip():
                raise ValueError("final transcript text is empty")
            if runtime.snapshot.status == "stopped":
                logger.info("encounter %s stopped; ignoring final turn", runtime.encounter_id)
                return runtime.snapshot

            received_at = utcnow()
            t0 = time.perf_counter()

            seq = sequence if sequence is not None else runtime.store.next_sequence()
            arrived_late = any(
                e.sequence > seq
                for e in runtime.store.events_of(EventType.TRANSCRIPT_FINAL_RECEIVED)
            )
            turn = TranscriptTurn(
                turn_id=f"turn-{seq}",
                provider_item_id=provider_item_id,
                sequence=seq,
                speaker=speaker,
                text=text,
                is_final=True,
                started_at_ms=started_at_ms,
                ended_at_ms=ended_at_ms,
                received_at=received_at,
                arrived_late=arrived_late,
            )
            runtime.store.append(
                EventType.TRANSCRIPT_FINAL_RECEIVED,
                {"turn": turn.model_dump(mode="json")},
                event_id=event_id,
                provider_item_id=provider_item_id,
                speaker=speaker,
                sequence=seq,
            )

            # Realtime feedback: the UI shows the turn as in-analysis until the
            # recompute publishes the next result (matters for live-model latency).
            await self._broadcast(
                runtime,
                {"type": "result.processing", "turn_id": turn.turn_id, "speaker": speaker.value},
            )

            # Structured extraction with validated output; deterministic fallback on failure.
            try:
                extraction = await self.extractor.extract(turn)
            except ExtractionError as err:
                runtime.store.append(
                    EventType.EXTRACTION_FAILED,
                    {"turn_id": turn.turn_id, "error": str(err)},
                    speaker=speaker,
                )
                if self.settings.extraction_fallback_deterministic:
                    extraction = await self.fallback_extractor.extract(turn)
                    extraction = extraction.model_copy(update={"extraction_method": "deterministic_fallback"})
                else:
                    snapshot = self._snapshot_with_error(runtime)
                    await self._broadcast(runtime, {"type": "processing.error", "detail": "Extraction failed for the last turn. The transcript is retained; no medical content was generated."})
                    return snapshot

            normalized = self.normalizer.normalize(extraction.mentions)
            t1 = time.perf_counter()

            runtime.store.append(
                EventType.MENTIONS_EXTRACTED,
                {
                    "turn_id": turn.turn_id,
                    "extraction_method": extraction.extraction_method,
                    "extraction_model": extraction.extraction_model,
                    "normalized_mentions": [nm.model_dump(mode="json") for nm in normalized],
                    "corrections": [c.model_dump(mode="json") for c in extraction.corrections],
                    "missing_information": extraction.missing_information,
                },
                speaker=speaker,
            )

            snapshot = await self._recompute(runtime, latest_turn=turn, timings=(t0, t1))
            return snapshot

    # -- proposals ----------------------------------------------------------

    async def propose_prescription(
        self, runtime: EncounterRuntime, *, event_id: str, surface_text: str
    ) -> EncounterSnapshot:
        async with runtime.lock:
            if runtime.store.has_event_id(event_id):
                raise DuplicateEventError(f"duplicate event_id {event_id}")
            concept_id = self.index.alias_to_medication.get(surface_text.lower().strip())
            proposal = PrescriptionProposal(
                proposal_id=new_id("prop"),
                surface_text=surface_text,
                concept_id=concept_id,
                canonical_name=self.index.ontology.canonical_name(concept_id) if concept_id else None,
                source_event_id=event_id,
            )
            runtime.store.append(
                EventType.PRESCRIPTION_PROPOSED,
                {"proposal": proposal.model_dump(mode="json")},
                event_id=event_id,
            )
            return await self._recompute(runtime, latest_turn=None)

    async def cancel_prescription(
        self, runtime: EncounterRuntime, *, event_id: str, proposal_id: str
    ) -> EncounterSnapshot:
        async with runtime.lock:
            if runtime.store.has_event_id(event_id):
                raise DuplicateEventError(f"duplicate event_id {event_id}")
            runtime.store.append(
                EventType.PRESCRIPTION_CANCELLED,
                {"proposal_id": proposal_id},
                event_id=event_id,
            )
            return await self._recompute(runtime, latest_turn=None)

    # -- core recompute (spec §14) ------------------------------------------

    async def _recompute(
        self,
        runtime: EncounterRuntime,
        latest_turn: TranscriptTurn | None,
        timings: tuple[float, float] | None = None,
    ) -> EncounterSnapshot:
        state: GraphState = self.reducer.rebuild(runtime.store.events)
        t2 = time.perf_counter()

        outcome: ReconcileOutcome = self.warning_engine.reconcile(runtime.warnings, state, latest_turn)

        violations = self.validator.validate(state, outcome.warnings)
        if violations:
            logger.error("graph invariant violations in %s: %s", runtime.encounter_id, violations)
            runtime.store.append(EventType.GRAPH_RECOMPUTED, {"violations": violations})
            snapshot = self._snapshot_with_error(runtime)
            await self._broadcast(runtime, {"type": "processing.error", "detail": "Internal graph consistency check failed. No result is shown for this state."})
            return snapshot

        runtime.warnings = outcome.warnings
        for w in outcome.created:
            runtime.store.append(EventType.WARNING_CREATED, {"warning": w.model_dump(mode="json")})
        for w in outcome.updated:
            runtime.store.append(EventType.WARNING_UPDATED, {"warning": w.model_dump(mode="json")})
        for w in outcome.retracted:
            runtime.store.append(EventType.WARNING_RETRACTED, {"warning": w.model_dump(mode="json")})
        runtime.store.append(
            EventType.GRAPH_RECOMPUTED,
            {
                "active_assertions": len(state.active()),
                "matches": [m.model_dump(mode="json") for m in outcome.matches],
                "result_state": outcome.result_state.value,
            },
        )

        t3 = time.perf_counter()
        if timings is not None and latest_turn is not None:
            t0, t1 = timings
            latency = TurnLatency(
                turn_id=latest_turn.turn_id,
                received_to_extraction_ms=round((t1 - t0) * 1000, 2),
                extraction_to_graph_ms=round((t2 - t1) * 1000, 2),
                graph_to_result_ms=round((t3 - t2) * 1000, 2),
                total_ms=round((t3 - t0) * 1000, 2),
            )
            runtime.latencies.append(latency)

        snapshot = EncounterSnapshot(
            encounter_id=runtime.encounter_id,
            version=runtime.snapshot.version + 1,
            status=state.status,
            synthetic_demo=runtime.synthetic_demo,
            started_at=state.started_at,
            stopped_at=state.stopped_at,
            turns=state.turns,
            mentions=state.mentions,
            assertions=sorted(state.assertions.values(), key=lambda a: a.valid_from),
            proposals=list(state.proposals.values()),
            matches=outcome.matches,
            warnings=runtime.warnings,
            result_state=outcome.result_state,
            lookup_reason=outcome.lookup_reason,
            missing_information=outcome.missing_information,
            excluded_notes=outcome.excluded_notes,
            conflict_notes=outcome.conflict_notes,
            messages=outcome.messages,
            latencies=runtime.latencies,
        )
        runtime.snapshot = snapshot

        await self._publish_update(runtime, outcome)
        return snapshot

    def _snapshot_with_error(self, runtime: EncounterRuntime) -> EncounterSnapshot:
        snapshot = runtime.snapshot.model_copy(
            update={
                "version": runtime.snapshot.version + 1,
                "result_state": ResultState.PROCESSING_ERROR,
                "lookup_reason": "A processing error occurred. The transcript is retained and no medical content is shown for this state.",
            }
        )
        runtime.snapshot = snapshot
        return snapshot

    # -- websocket publication ---------------------------------------------

    async def _publish_update(self, runtime: EncounterRuntime, outcome: ReconcileOutcome) -> None:
        snapshot = runtime.snapshot
        graph_event = {
            "type": "graph.updated",
            "encounter_id": runtime.encounter_id,
            "version": snapshot.version,
            "status": snapshot.status,
            "turns": [t.model_dump(mode="json") for t in snapshot.turns],
            "active_assertions": [a.model_dump(mode="json") for a in snapshot.active_assertions()],
            "inactive_assertions": [
                a.model_dump(mode="json") for a in snapshot.assertions if not a.is_active
            ],
            "proposals": [p.model_dump(mode="json") for p in snapshot.proposals],
        }
        result_event = {
            "type": "result.updated",
            "encounter_id": runtime.encounter_id,
            "version": snapshot.version,
            "result": self.result_payload(runtime),
        }
        await self._broadcast(runtime, graph_event)
        for w in outcome.created:
            await self._broadcast(runtime, {"type": "warning.created", "warning": self.warning_payload(w)})
        for w in outcome.updated:
            await self._broadcast(runtime, {"type": "warning.updated", "warning": self.warning_payload(w)})
        for w in outcome.retracted:
            await self._broadcast(runtime, {"type": "warning.retracted", "warning": self.warning_payload(w)})
        await self._broadcast(runtime, result_event)

    def warning_payload(self, warning: WarningRecord) -> dict:
        """Warning + the full verbatim evidence record it references."""
        payload = warning.model_dump(mode="json")
        payload["evidence_record"] = self.index.get_record(warning.evidence_record_id)
        return payload

    def result_payload(self, runtime: EncounterRuntime) -> dict:
        snapshot = runtime.snapshot
        return {
            "state": snapshot.result_state.value,
            "lookup_reason": snapshot.lookup_reason,
            "missing_information": snapshot.missing_information,
            "excluded_notes": snapshot.excluded_notes,
            "conflict_notes": snapshot.conflict_notes,
            "messages": snapshot.messages,
            "active_warnings": [self.warning_payload(w) for w in snapshot.active_warnings()],
            "warning_history": [
                self.warning_payload(w) for w in snapshot.warnings if w.state == "retracted"
            ],
            "latency_ms": snapshot.latencies[-1].model_dump(mode="json") if snapshot.latencies else None,
        }

    def snapshot_payload(self, runtime: EncounterRuntime) -> dict:
        snapshot = runtime.snapshot
        return {
            "type": "encounter.snapshot",
            "encounter_id": runtime.encounter_id,
            "version": snapshot.version,
            "status": snapshot.status,
            "active_speaker": runtime.active_speaker.value,
            "turns": [t.model_dump(mode="json") for t in snapshot.turns],
            "active_assertions": [a.model_dump(mode="json") for a in snapshot.active_assertions()],
            "inactive_assertions": [a.model_dump(mode="json") for a in snapshot.assertions if not a.is_active],
            "proposals": [p.model_dump(mode="json") for p in snapshot.proposals],
            "result": self.result_payload(runtime),
        }

    async def _broadcast(self, runtime: EncounterRuntime, message: dict) -> None:
        dead = []
        for ws in list(runtime.subscribers):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            runtime.subscribers.discard(ws)
