"""Pydantic models for the HormoneRx real-time encounter engine.

The extraction model may only ever produce TurnExtraction-shaped data (mentions,
corrections, missing information). It never produces interactions, consequences,
mechanisms, severity, citations, or advice — those exist only in the curated
evidence dataset and are attached by deterministic code.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "1.0"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


class Speaker(StrEnum):
    DOCTOR = "doctor"
    PATIENT = "patient"
    OTHER_PERSON = "other_person"
    UNKNOWN = "unknown"


class SubjectRole(StrEnum):
    PATIENT = "patient"
    DOCTOR = "doctor"
    OTHER_PERSON = "other_person"
    UNKNOWN = "unknown"


class MentionCategory(StrEnum):
    HORMONAL_PRODUCT = "hormonal_product"
    OTHER_MEDICATION = "other_medication"


class MentionStatus(StrEnum):
    CURRENT = "current"
    HISTORICAL = "historical"
    PLANNED = "planned"
    NEGATED = "negated"
    UNCERTAIN = "uncertain"


class Certainty(StrEnum):
    EXPLICIT = "explicit"
    INFERRED = "inferred"
    UNCERTAIN = "uncertain"


class NormalizationStatus(StrEnum):
    NORMALIZED = "normalized"
    AMBIGUOUS = "ambiguous"
    NON_INTERACTING = "non_interacting"
    UNKNOWN = "unknown"


class ResultState(StrEnum):
    LISTENING = "LISTENING"
    PROCESSING = "PROCESSING"
    EVIDENCE_FOUND = "EVIDENCE_FOUND"
    NO_VALIDATED_MATCH = "NO_VALIDATED_MATCH"
    MORE_INFORMATION_REQUIRED = "MORE_INFORMATION_REQUIRED"
    EXCLUDED_CONTEXT = "EXCLUDED_CONTEXT"
    RETRACTED = "RETRACTED"
    PROCESSING_ERROR = "PROCESSING_ERROR"


class EventType(StrEnum):
    SESSION_STARTED = "SESSION_STARTED"
    SESSION_STOPPED = "SESSION_STOPPED"
    TRANSCRIPT_PARTIAL_RECEIVED = "TRANSCRIPT_PARTIAL_RECEIVED"
    TRANSCRIPT_FINAL_RECEIVED = "TRANSCRIPT_FINAL_RECEIVED"
    MENTIONS_EXTRACTED = "MENTIONS_EXTRACTED"
    ASSERTION_ADDED = "ASSERTION_ADDED"
    ASSERTION_SUPERSEDED = "ASSERTION_SUPERSEDED"
    ASSERTION_RETRACTED = "ASSERTION_RETRACTED"
    PRESCRIPTION_PROPOSED = "PRESCRIPTION_PROPOSED"
    PRESCRIPTION_CANCELLED = "PRESCRIPTION_CANCELLED"
    SPEAKER_CHANGED = "SPEAKER_CHANGED"
    GRAPH_RECOMPUTED = "GRAPH_RECOMPUTED"
    EVIDENCE_MATCH_CREATED = "EVIDENCE_MATCH_CREATED"
    EVIDENCE_MATCH_REMOVED = "EVIDENCE_MATCH_REMOVED"
    WARNING_CREATED = "WARNING_CREATED"
    WARNING_UPDATED = "WARNING_UPDATED"
    WARNING_RETRACTED = "WARNING_RETRACTED"
    EXTRACTION_FAILED = "EXTRACTION_FAILED"
    TRANSCRIPTION_FAILED = "TRANSCRIPTION_FAILED"
    SESSION_RESET = "SESSION_RESET"


class Predicate(StrEnum):
    CURRENTLY_USES = "CURRENTLY_USES"
    CURRENTLY_TAKES = "CURRENTLY_TAKES"
    HISTORICALLY_USED = "HISTORICALLY_USED"
    PLANS_TO_TAKE = "PLANS_TO_TAKE"
    NEGATED_USE_OF = "NEGATED_USE_OF"


class WarningContext(StrEnum):
    ACTIVE_COMBINATION = "active_combination"
    PROPOSED_COMBINATION = "proposed_combination"


class VerificationStatus(StrEnum):
    PHYSICIAN_VERIFIED = "physician_verified"
    SIGN_OFF_PENDING = "physician_sign_off_pending"


# ---------------------------------------------------------------------------
# Event envelope (append-only log entries), spec §10.3
# ---------------------------------------------------------------------------

class EncounterEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: str
    encounter_id: str
    event_type: EventType
    occurred_at: datetime = Field(default_factory=utcnow)
    sequence: int
    provider_item_id: str | None = None
    speaker: Speaker | None = None
    payload: dict = Field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Transcript
# ---------------------------------------------------------------------------

class TranscriptTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    turn_id: str
    provider_item_id: str | None = None
    sequence: int
    speaker: Speaker
    text: str
    is_final: bool
    started_at_ms: int | None = None
    ended_at_ms: int | None = None
    received_at: datetime = Field(default_factory=utcnow)
    arrived_late: bool = False


# ---------------------------------------------------------------------------
# Extraction contract (the ONLY model-producible structure), spec §12
# ---------------------------------------------------------------------------

class ExtractedMention(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mention_id: str = Field(default_factory=lambda: new_id("m"))
    surface_text: str
    normalized_candidate: str | None = None
    category: MentionCategory
    status: MentionStatus
    subject: SubjectRole
    certainty: Certainty
    source_turn_id: str = ""
    span_start: int | None = None
    span_end: int | None = None
    route_if_explicit: str | None = None
    dose_if_explicit: str | None = None


class Correction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_surface_text: str | None = None
    replacement_surface_text: str | None = None
    note: str | None = None


class TurnExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    turn_id: str
    speaker: SubjectRole
    mentions: list[ExtractedMention] = Field(default_factory=list)
    corrections: list[Correction] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)
    should_recompute_graph: bool = True
    extraction_method: str = "deterministic"
    extraction_model: str = "deterministic-rule-extractor/0.2.0"


class NormalizedMention(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mention: ExtractedMention
    concept_id: str | None = None
    canonical_name: str | None = None
    normalization_status: NormalizationStatus
    normalization_method: str = "approved_synonym_index/0.2.0"
    missing_information: str | None = None
    candidate_concept_ids: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Encounter graph
# ---------------------------------------------------------------------------

class GraphAssertion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assertion_id: str
    subject: SubjectRole
    predicate: Predicate
    concept_id: str
    canonical_name: str
    category: MentionCategory
    status: MentionStatus
    source_turn_id: str
    mention_id: str | None = None
    certainty: Certainty = Certainty.EXPLICIT
    is_active: bool = True
    valid_from: datetime = Field(default_factory=utcnow)
    valid_to: datetime | None = None
    normalization_method: str = "approved_synonym_index/0.2.0"
    supersedes_assertion_id: str | None = None
    superseded_by_assertion_id: str | None = None
    origin: str = "speech"  # "speech" | "ui_proposal"
    proposal_id: str | None = None


class PrescriptionProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal_id: str
    surface_text: str
    concept_id: str | None = None
    canonical_name: str | None = None
    route_if_explicit: str | None = None
    dose_if_explicit: str | None = None
    status: str = "planned"  # "planned" | "cancelled"
    source_event_id: str = ""
    created_at: datetime = Field(default_factory=utcnow)
    cancelled_at: datetime | None = None


class EvidenceMatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_id: str
    hormonal_concept_id: str
    medication_concept_id: str
    hormonal_assertion_id: str
    medication_assertion_id: str
    context: WarningContext


class WarningRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    warning_id: str
    state: str  # "active" | "updated" | "retracted"
    display_label: str = "Potentially relevant evidence found"
    evidence_record_id: str
    context: WarningContext
    verification_status: VerificationStatus
    hormonal_concept_id: str
    medication_concept_id: str
    trigger_assertion_ids: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    retracted_at: datetime | None = None
    retraction_reason: str | None = None
    retracted_by_turn_id: str | None = None


class TurnLatency(BaseModel):
    model_config = ConfigDict(extra="forbid")

    turn_id: str
    received_to_extraction_ms: float
    extraction_to_graph_ms: float
    graph_to_result_ms: float
    total_ms: float


class EncounterSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    encounter_id: str
    version: int = 0
    status: str = "created"  # created | listening | stopped | reset
    synthetic_demo: bool = True
    schema_version: str = SCHEMA_VERSION
    started_at: datetime | None = None
    stopped_at: datetime | None = None
    turns: list[TranscriptTurn] = Field(default_factory=list)
    mentions: list[NormalizedMention] = Field(default_factory=list)
    assertions: list[GraphAssertion] = Field(default_factory=list)
    proposals: list[PrescriptionProposal] = Field(default_factory=list)
    matches: list[EvidenceMatch] = Field(default_factory=list)
    warnings: list[WarningRecord] = Field(default_factory=list)
    result_state: ResultState = ResultState.LISTENING
    lookup_reason: str = "No finalized medication context has been analyzed yet."
    missing_information: list[str] = Field(default_factory=list)
    excluded_notes: list[str] = Field(default_factory=list)
    conflict_notes: list[str] = Field(default_factory=list)
    messages: list[str] = Field(default_factory=list)
    latencies: list[TurnLatency] = Field(default_factory=list)

    def active_assertions(self) -> list[GraphAssertion]:
        return [a for a in self.assertions if a.is_active]

    def active_warnings(self) -> list[WarningRecord]:
        return [w for w in self.warnings if w.state in ("active", "updated")]
