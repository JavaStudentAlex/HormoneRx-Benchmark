"""Deterministic rule-based extractor (demo mode and live-mode fallback).

Performs ONLY the permitted extraction task: locating hormonal-product and
medication surface forms from the approved vocabulary, classifying temporal
status / negation / subject from cue words in the surrounding clause, and
flagging explicit corrections. It contains no medical knowledge beyond the
approved vocabulary lists and never produces interaction content.

Ported from the original TypeScript rule extractor (src/lib/extract.ts) and
extended for multi-mention turns, speaker-aware subject attribution, and
correction detection per task spec §12 and §15.
"""
from __future__ import annotations

import re

from .evidence_index import EvidenceIndex
from .models import (
    Certainty,
    Correction,
    ExtractedMention,
    MentionCategory,
    MentionStatus,
    Speaker,
    SubjectRole,
    TranscriptTurn,
    TurnExtraction,
)

EXTRACTOR_VERSION = "deterministic-rule-extractor/0.2.0"

NEGATION_CUES = [
    "not taking", "not on", "is not", "isn't", "not currently", "denies", "denied",
    "no use of", "without", "never taken", "never used", "no longer taking",
    "don't take", "do not take", "doesn't take", "does not take", "not using",
    "don't use", "do not use", "stopped taking it before it started", "has never",
]

HISTORICAL_CUES = [
    "stopped", "discontinued", "no longer", "previously", "used to", "in the past",
    "years ago", "year ago", "months ago", "month ago", "former", "had been on",
    "was on", "came off", "quit",
]

PLANNED_CUES = [
    "planning to start", "plans to start", "planning to begin", "will start",
    "about to start", "going to start", "intends to start", "intend to start",
    "due to start", "next month", "next week", "considering starting",
    "thinking about starting", "we will start", "i'm going to prescribe",
    "i am going to prescribe", "i'll prescribe", "i will prescribe",
    "going to put you on", "let's start", "we'll start", "start you on",
]

OTHER_PERSON_CUES = [
    "my sister", "my brother", "my mother", "my father", "my mum", "my mom",
    "my dad", "my friend", "my partner", "my husband", "my wife", "my son",
    "my daughter", "her partner", "her husband", "his wife", "her wife",
    "his husband", "her son", "her daughter", "her mother", "her father",
    "her sister", "his sister", "her brother", "his brother", "family member",
    "someone else", "a friend",
]

DISCUSSION_CUES = [
    "explained what", "explained how", "told me about", "told her about",
    "asked about", "asked whether", "asked if", "talked about", "discussed",
    "what is", "heard about", "read about",
]

HORMONAL_UNCERTAIN_CUES = [
    "method is unclear", "method unclear", "unclear which", "some form of",
    "might be using", "may be using", "possibly using", "not sure which",
]

MEDICATION_UNCERTAIN_CUES = [
    "cannot recall", "can't recall", "cannot remember", "can't remember",
    "not sure what", "something for", "unnamed", "name is unknown",
    "name unknown", "forgotten the name",
]

CORRECTION_CUES = [
    "sorry, i meant", "sorry i meant", "i meant", "actually, i meant",
    "actually i meant", "no, i meant", "correction", "i misspoke",
    "that's wrong, it's", "it's actually",
]

BOUNDARY_TOKENS = [
    ". ", "; ", ", ", " but ", " and ", " who ", " although ", " though ",
    " however ", " whereas ",
]


def _clause_window(text: str, start: int, end: int) -> str:
    clause_start = 0
    for token in BOUNDARY_TOKENS:
        idx = text.rfind(token, 0, max(start, 0))
        if idx != -1:
            boundary_end = idx + len(token)
            if boundary_end <= start and boundary_end > clause_start:
                clause_start = boundary_end
    clause_end = len(text)
    for token in BOUNDARY_TOKENS:
        idx = text.find(token, end)
        if idx != -1 and idx < clause_end:
            clause_end = idx
    return text[clause_start:clause_end]


def _contains_any(haystack: str, needles: list[str]) -> bool:
    return any(n in haystack for n in needles)


def _is_boundary_char(ch: str) -> bool:
    return not ch.isalpha()


class _SurfaceMatch:
    __slots__ = ("surface", "index", "category")

    def __init__(self, surface: str, index: int, category: MentionCategory):
        self.surface = surface
        self.index = index
        self.category = category


class DeterministicExtractor:
    """Rule-based extractor over the approved vocabulary only."""

    def __init__(self, index: EvidenceIndex):
        self.index = index
        onto = index.ontology
        hormonal_terms = set(index.alias_to_hormonal) | set(onto.ambiguous_hormonal_aliases)
        medication_terms = (
            set(index.alias_to_medication)
            | set(onto.ambiguous_medication_aliases)
            | set(onto.non_interacting_medications)
        )
        # Longest surface form first so the most specific term wins.
        self._hormonal_terms = sorted(hormonal_terms, key=len, reverse=True)
        self._medication_terms = sorted(medication_terms, key=len, reverse=True)

    async def extract(self, turn: TranscriptTurn) -> TurnExtraction:
        return self.extract_sync(turn)

    def extract_sync(self, turn: TranscriptTurn) -> TurnExtraction:
        text = turn.text
        lower = text.lower()
        missing: list[str] = []
        mentions: list[ExtractedMention] = []

        matches = self._find_matches(lower)
        for m in matches:
            window = _clause_window(lower, m.index, m.index + len(m.surface))
            status = self._classify_status(window)
            subject = self._classify_subject(window, lower, turn.speaker, status)
            certainty = Certainty.EXPLICIT
            if status == MentionStatus.UNCERTAIN:
                certainty = Certainty.UNCERTAIN
            mentions.append(
                ExtractedMention(
                    surface_text=text[m.index : m.index + len(m.surface)],
                    normalized_candidate=None,
                    category=m.category,
                    status=status,
                    subject=subject,
                    certainty=certainty,
                    source_turn_id=turn.turn_id,
                    span_start=m.index,
                    span_end=m.index + len(m.surface),
                )
            )

        has_hormonal = any(m.category == MentionCategory.HORMONAL_PRODUCT for m in mentions)
        if not has_hormonal and _contains_any(lower, HORMONAL_UNCERTAIN_CUES):
            # "some form of hormonal contraception" style statements without a
            # matched vocabulary surface still record an uncertain hormonal mention.
            mentions.append(
                ExtractedMention(
                    surface_text="contraception (method unspecified)",
                    category=MentionCategory.HORMONAL_PRODUCT,
                    status=MentionStatus.UNCERTAIN,
                    subject=self._default_subject(turn.speaker),
                    certainty=Certainty.UNCERTAIN,
                    source_turn_id=turn.turn_id,
                )
            )
            missing.append("Specific hormonal contraceptive method is not stated.")

        has_medication = any(m.category == MentionCategory.OTHER_MEDICATION for m in mentions)
        if not has_medication and _contains_any(lower, MEDICATION_UNCERTAIN_CUES):
            mentions.append(
                ExtractedMention(
                    surface_text="medication (name not stated)",
                    category=MentionCategory.OTHER_MEDICATION,
                    status=MentionStatus.UNCERTAIN,
                    subject=self._default_subject(turn.speaker),
                    certainty=Certainty.UNCERTAIN,
                    source_turn_id=turn.turn_id,
                )
            )
            missing.append("Specific medication name is not stated.")

        corrections = self._detect_corrections(lower, mentions)

        return TurnExtraction(
            turn_id=turn.turn_id,
            speaker=SubjectRole(turn.speaker.value),
            mentions=mentions,
            corrections=corrections,
            missing_information=missing,
            should_recompute_graph=bool(mentions or corrections),
            extraction_method="deterministic",
            extraction_model=EXTRACTOR_VERSION,
        )

    # -- matching -----------------------------------------------------------

    def _find_matches(self, lower: str) -> list[_SurfaceMatch]:
        found: list[_SurfaceMatch] = []
        used: list[tuple[int, int]] = []

        def scan(terms: list[str], category: MentionCategory) -> None:
            for term in terms:
                start = 0
                while True:
                    idx = lower.find(term, start)
                    if idx == -1:
                        break
                    end = idx + len(term)
                    before = " " if idx == 0 else lower[idx - 1]
                    after = " " if end >= len(lower) else lower[end]
                    overlaps = any(idx < e and end > s for s, e in used)
                    if _is_boundary_char(before) and _is_boundary_char(after) and not overlaps:
                        found.append(_SurfaceMatch(term, idx, category))
                        used.append((idx, end))
                    start = idx + 1

        scan(self._hormonal_terms, MentionCategory.HORMONAL_PRODUCT)
        scan(self._medication_terms, MentionCategory.OTHER_MEDICATION)
        return sorted(found, key=lambda m: m.index)

    # -- classification -----------------------------------------------------

    @staticmethod
    def _classify_status(window: str) -> MentionStatus:
        # Precedence: negated > historical > planned > uncertain-discussion > current.
        if _contains_any(window, NEGATION_CUES):
            return MentionStatus.NEGATED
        if _contains_any(window, HISTORICAL_CUES):
            return MentionStatus.HISTORICAL
        if _contains_any(window, PLANNED_CUES):
            return MentionStatus.PLANNED
        if _contains_any(window, DISCUSSION_CUES):
            return MentionStatus.UNCERTAIN
        return MentionStatus.CURRENT

    def _classify_subject(
        self,
        window: str,
        full_lower: str,
        speaker: Speaker,
        status: MentionStatus,
    ) -> SubjectRole:
        if _contains_any(window, OTHER_PERSON_CUES):
            return SubjectRole.OTHER_PERSON
        if speaker == Speaker.DOCTOR:
            # A doctor's planned-prescription statement or an explicit statement
            # about the patient ("you take") is attributed to the patient. A pure
            # question or discussion without those anchors is not a patient assertion.
            if re.search(r"\bi (take|use|am on)\b|\bi'm on\b", window):
                return SubjectRole.DOCTOR
            if status == MentionStatus.PLANNED:
                return SubjectRole.PATIENT
            if re.search(r"\byou\b|\byour\b|the patient|she takes|he takes|she uses|he uses|she is on|he is on", window):
                if "?" in full_lower and not re.search(r"she takes|he takes|she uses|he uses|the patient", window):
                    return SubjectRole.UNKNOWN
                return SubjectRole.PATIENT
            if _contains_any(window, DISCUSSION_CUES) or "?" in full_lower:
                return SubjectRole.UNKNOWN
            return SubjectRole.PATIENT
        if speaker == Speaker.OTHER_PERSON:
            return SubjectRole.OTHER_PERSON
        # Patient speech and unknown speakers: first-person and third-person
        # clinical-note phrasing both describe the patient by default.
        if speaker == Speaker.UNKNOWN:
            return SubjectRole.PATIENT if re.search(r"\bi\b|\bshe\b|\bhe\b|the patient|\bmy\b", full_lower) else SubjectRole.UNKNOWN
        return SubjectRole.PATIENT

    @staticmethod
    def _default_subject(speaker: Speaker) -> SubjectRole:
        if speaker == Speaker.OTHER_PERSON:
            return SubjectRole.OTHER_PERSON
        return SubjectRole.PATIENT

    # -- corrections --------------------------------------------------------

    @staticmethod
    def _detect_corrections(lower: str, mentions: list[ExtractedMention]) -> list[Correction]:
        if not _contains_any(lower, CORRECTION_CUES):
            return []
        # The replacement is the current-status mention in the correcting turn —
        # a medication ("I meant lamotrigine") or a hormonal product
        # ("I meant the combined pill"). The reducer supersedes the latest prior
        # assertion of the same category.
        replacement = None
        for category in (MentionCategory.OTHER_MEDICATION, MentionCategory.HORMONAL_PRODUCT):
            for m in mentions:
                if m.category == category and m.status == MentionStatus.CURRENT:
                    replacement = m.surface_text
                    break
            if replacement:
                break
        return [
            Correction(
                target_surface_text=None,  # resolved by the reducer: latest prior assertion of same category
                replacement_surface_text=replacement,
                note="explicit correction cue in turn",
            )
        ]
