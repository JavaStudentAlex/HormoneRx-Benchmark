"""Append-only encounter event log (spec §10).

Nothing in the encounter is ever mutated in place without a log entry that
explains how the change happened. The derived graph snapshot is rebuilt from
this log, so every state the UI ever showed can be reconstructed and audited.
"""
from __future__ import annotations

from datetime import datetime, timezone

from .models import EncounterEvent, EventType, Speaker, new_id


class EncounterEventStore:
    def __init__(self, encounter_id: str):
        self.encounter_id = encounter_id
        self._events: list[EncounterEvent] = []
        self._next_sequence = 1
        self._seen_event_ids: set[str] = set()
        self._seen_provider_item_ids: set[str] = set()

    @property
    def events(self) -> list[EncounterEvent]:
        return list(self._events)

    def next_sequence(self) -> int:
        return self._next_sequence

    def has_event_id(self, event_id: str) -> bool:
        return event_id in self._seen_event_ids

    def has_provider_item(self, provider_item_id: str) -> bool:
        return provider_item_id in self._seen_provider_item_ids

    def append(
        self,
        event_type: EventType,
        payload: dict | None = None,
        *,
        event_id: str | None = None,
        provider_item_id: str | None = None,
        speaker: Speaker | None = None,
        sequence: int | None = None,
        occurred_at: datetime | None = None,
    ) -> EncounterEvent:
        event = EncounterEvent(
            event_id=event_id or new_id("evt"),
            encounter_id=self.encounter_id,
            event_type=event_type,
            sequence=sequence if sequence is not None else self._next_sequence,
            provider_item_id=provider_item_id,
            speaker=speaker,
            payload=payload or {},
            **({"occurred_at": occurred_at} if occurred_at else {}),
        )
        self._events.append(event)
        self._seen_event_ids.add(event.event_id)
        if provider_item_id:
            self._seen_provider_item_ids.add(provider_item_id)
        self._next_sequence = max(self._next_sequence, event.sequence) + 1
        return event

    def events_of(self, *types: EventType) -> list[EncounterEvent]:
        wanted = set(types)
        return [e for e in self._events if e.event_type in wanted]
