"""Environment-driven configuration. Secrets are read only here, server-side."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


class Settings(BaseModel):
    app_env: str = "development"
    demo_mode: bool = True
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    transcription_model: str = "gpt-realtime-whisper"
    transcription_language: str = "en"
    extraction_model: str = "gpt-4o-mini"
    evidence_path: Path = BACKEND_DIR / "data" / "evidence_records.json"
    synonym_path: Path = BACKEND_DIR / "data" / "synonym_index.json"
    store_raw_audio: bool = False
    store_transcripts: bool = False
    strict_evidence_validation: bool = True
    # Hackathon-demo override: records that pass every runtime-eligibility check
    # EXCEPT the physician sign-off flag may trigger warnings, and every such
    # warning is visibly labeled "physician sign-off pending". Never enabled in
    # production. Once the physician flips physicianVerified to true this flag
    # becomes irrelevant.
    evidence_allow_pending_verification: bool = True
    extraction_fallback_deterministic: bool = True
    log_level: str = "INFO"

    @property
    def live_extraction_available(self) -> bool:
        return bool(self.openai_api_key)


@lru_cache
def get_settings() -> Settings:
    env = os.environ
    app_env = env.get("APP_ENV", "development")
    is_production = app_env == "production"
    return Settings(
        app_env=app_env,
        demo_mode=_env_bool("DEMO_MODE", True),
        openai_api_key=env.get("OPENAI_API_KEY") or None,
        openai_base_url=env.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        transcription_model=env.get("TRANSCRIPTION_MODEL", "gpt-realtime-whisper"),
        transcription_language=env.get("TRANSCRIPTION_LANGUAGE", "en"),
        extraction_model=env.get("EXTRACTION_MODEL", "gpt-4o-mini"),
        evidence_path=Path(env.get("EVIDENCE_PATH", str(BACKEND_DIR / "data" / "evidence_records.json"))),
        synonym_path=Path(env.get("SYNONYM_PATH", str(BACKEND_DIR / "data" / "synonym_index.json"))),
        store_raw_audio=_env_bool("STORE_RAW_AUDIO", False),
        store_transcripts=_env_bool("STORE_TRANSCRIPTS", False),
        strict_evidence_validation=_env_bool("STRICT_EVIDENCE_VALIDATION", True),
        evidence_allow_pending_verification=(
            False if is_production else _env_bool("EVIDENCE_ALLOW_PENDING_VERIFICATION", True)
        ),
        extraction_fallback_deterministic=_env_bool("EXTRACTION_FALLBACK_DETERMINISTIC", True),
        log_level=env.get("LOG_LEVEL", "INFO"),
    )
