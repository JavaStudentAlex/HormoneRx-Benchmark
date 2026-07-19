"""Extraction adapters.

MedicationContextExtractor is the interface the encounter service depends on.
The live adapter calls a server-side structured-output model; every response is
validated against the strict Pydantic contract before it may touch the graph
(spec §12.3). Prohibited medical fields cannot survive validation because the
schema forbids extra keys.
"""
from __future__ import annotations

import json
import logging
from typing import Protocol

import httpx

from .config import Settings
from .deterministic_extractor import DeterministicExtractor
from .evidence_index import EvidenceIndex
from .models import (
    Certainty,
    ExtractedMention,
    MentionCategory,
    MentionStatus,
    SubjectRole,
    TranscriptTurn,
    TurnExtraction,
)

logger = logging.getLogger("hormonerx.extractor")


class ExtractionError(Exception):
    pass


class MedicationContextExtractor(Protocol):
    async def extract(self, turn: TranscriptTurn) -> TurnExtraction: ...


EXTRACTION_SYSTEM_PROMPT = """You extract medication context from one finalized turn of a synthetic doctor-patient conversation.

Return ONLY the structured fields requested. You may identify: hormonal products, other medications, their status (current | historical | planned | negated | uncertain), the subject (patient | doctor | other_person | unknown), certainty, character spans, explicitly stated route or dose, explicit corrections, and missing information.

You must NOT output interactions, consequences, mechanisms, severity, evidence levels, citations, recommendations, or safety judgments. Do not guess a specific contraceptive method from an ambiguous phrase like "the pill" — report the surface text and let downstream code handle ambiguity. Do not invent medication names that are not in the text."""

EXTRACTION_JSON_SCHEMA = {
    "name": "turn_extraction",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "mentions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "surface_text": {"type": "string"},
                        "category": {"type": "string", "enum": ["hormonal_product", "other_medication"]},
                        "status": {"type": "string", "enum": ["current", "historical", "planned", "negated", "uncertain"]},
                        "subject": {"type": "string", "enum": ["patient", "doctor", "other_person", "unknown"]},
                        "certainty": {"type": "string", "enum": ["explicit", "inferred", "uncertain"]},
                        "span_start": {"type": ["integer", "null"]},
                        "span_end": {"type": ["integer", "null"]},
                        "route_if_explicit": {"type": ["string", "null"]},
                        "dose_if_explicit": {"type": ["string", "null"]},
                    },
                    "required": [
                        "surface_text", "category", "status", "subject", "certainty",
                        "span_start", "span_end", "route_if_explicit", "dose_if_explicit",
                    ],
                },
            },
            "corrections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "target_surface_text": {"type": ["string", "null"]},
                        "replacement_surface_text": {"type": ["string", "null"]},
                    },
                    "required": ["target_surface_text", "replacement_surface_text"],
                },
            },
            "missing_information": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["mentions", "corrections", "missing_information"],
    },
}


class LiveExtractor:
    """Structured-output extraction via an OpenAI-compatible chat completions API."""

    def __init__(self, settings: Settings, index: EvidenceIndex):
        if not settings.openai_api_key:
            raise ValueError("LiveExtractor requires OPENAI_API_KEY")
        self.settings = settings
        self.index = index

    async def extract(self, turn: TranscriptTurn) -> TurnExtraction:
        body = {
            "model": self.settings.extraction_model,
            "messages": [
                {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": json.dumps(
                        {"turn_id": turn.turn_id, "speaker": turn.speaker.value, "text": turn.text}
                    ),
                },
            ],
            "response_format": {"type": "json_schema", "json_schema": EXTRACTION_JSON_SCHEMA},
            "temperature": 0,
        }
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.post(
                    f"{self.settings.openai_base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {self.settings.openai_api_key}"},
                    json=body,
                )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            parsed = json.loads(content)
        except Exception as err:  # network, HTTP, or JSON failure
            raise ExtractionError(f"live extraction failed: {err}") from err

        try:
            mentions = [
                ExtractedMention(
                    surface_text=m["surface_text"],
                    category=MentionCategory(m["category"]),
                    status=MentionStatus(m["status"]),
                    subject=SubjectRole(m["subject"]),
                    certainty=Certainty(m["certainty"]),
                    source_turn_id=turn.turn_id,
                    span_start=m.get("span_start"),
                    span_end=m.get("span_end"),
                    route_if_explicit=m.get("route_if_explicit"),
                    dose_if_explicit=m.get("dose_if_explicit"),
                )
                for m in parsed.get("mentions", [])
            ]
            extraction = TurnExtraction(
                turn_id=turn.turn_id,
                speaker=SubjectRole(turn.speaker.value),
                mentions=mentions,
                corrections=[
                    {
                        "target_surface_text": c.get("target_surface_text"),
                        "replacement_surface_text": c.get("replacement_surface_text"),
                    }
                    for c in parsed.get("corrections", [])
                ],
                missing_information=[str(x) for x in parsed.get("missing_information", [])],
                extraction_method="live_structured_output",
                extraction_model=self.settings.extraction_model,
            )
        except Exception as err:
            # The model produced something outside the contract: reject wholesale.
            raise ExtractionError(f"live extraction response failed validation: {err}") from err
        return extraction


def build_extractor(settings: Settings, index: EvidenceIndex) -> MedicationContextExtractor:
    if not settings.demo_mode and settings.live_extraction_available:
        return LiveExtractor(settings, index)
    return DeterministicExtractor(index)
