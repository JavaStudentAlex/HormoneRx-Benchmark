import pytest

from app.config import Settings
from app.deterministic_extractor import DeterministicExtractor
from app.encounter_service import EncounterService
from app.evidence_index import EvidenceIndex
from app.models import Speaker, TranscriptTurn, new_id, utcnow


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings()


@pytest.fixture(scope="session")
def index(settings) -> EvidenceIndex:
    return EvidenceIndex(
        settings.evidence_path,
        settings.synonym_path,
        strict=True,
        allow_pending_verification=True,
    )


@pytest.fixture(scope="session")
def strict_index(settings) -> EvidenceIndex:
    """Spec-strict eligibility: physician sign-off required, no override."""
    return EvidenceIndex(
        settings.evidence_path,
        settings.synonym_path,
        strict=True,
        allow_pending_verification=False,
    )


@pytest.fixture()
def service(settings, index) -> EncounterService:
    return EncounterService(settings, index, DeterministicExtractor(index))


def make_turn(text: str, speaker: str = "patient", sequence: int = 1) -> TranscriptTurn:
    return TranscriptTurn(
        turn_id=f"turn-{sequence}",
        sequence=sequence,
        speaker=Speaker(speaker),
        text=text,
        is_final=True,
        received_at=utcnow(),
    )


async def say(service, runtime, text, speaker="patient", **kwargs):
    return await service.process_final_turn(
        runtime,
        event_id=kwargs.pop("event_id", new_id("evt")),
        text=text,
        speaker=Speaker(speaker),
        **kwargs,
    )
