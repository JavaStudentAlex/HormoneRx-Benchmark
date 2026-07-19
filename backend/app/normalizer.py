"""Deterministic concept normalization controlled by the approved synonym index.

An unknown medication name is never assigned to a concept or class merely
because an extraction model believes it belongs there (spec §13.3). Ambiguous
aliases ("the pill", "contraception", class words) normalize to AMBIGUOUS with
an explicit missing-information message and can never trigger a match.
"""
from __future__ import annotations

from .evidence_index import EvidenceIndex
from .models import (
    ExtractedMention,
    MentionCategory,
    NormalizationStatus,
    NormalizedMention,
)


class ConceptNormalizer:
    def __init__(self, index: EvidenceIndex):
        self.index = index
        self.ontology = index.ontology

    def normalize(self, mentions: list[ExtractedMention]) -> list[NormalizedMention]:
        return [self.normalize_one(m) for m in mentions]

    def normalize_one(self, mention: ExtractedMention) -> NormalizedMention:
        surface = (mention.normalized_candidate or mention.surface_text).lower().strip()
        raw_surface = mention.surface_text.lower().strip()

        if mention.category == MentionCategory.HORMONAL_PRODUCT:
            concept_id = self.ontology_hormonal(surface) or self.ontology_hormonal(raw_surface)
            if concept_id:
                return NormalizedMention(
                    mention=mention,
                    concept_id=concept_id,
                    canonical_name=self.ontology.canonical_name(concept_id),
                    normalization_status=NormalizationStatus.NORMALIZED,
                )
            ambiguous = self._ambiguous(surface, raw_surface, self.ontology.ambiguous_hormonal_aliases)
            if ambiguous is not None:
                alias, entry = ambiguous
                return NormalizedMention(
                    mention=mention,
                    normalization_status=NormalizationStatus.AMBIGUOUS,
                    missing_information=entry["missingInformation"],
                    candidate_concept_ids=list(entry.get("candidates", [])),
                )
            return NormalizedMention(
                mention=mention,
                normalization_status=NormalizationStatus.UNKNOWN,
                missing_information="The stated hormonal product could not be normalized against the approved synonym index.",
            )

        concept_id = self.ontology_medication(surface) or self.ontology_medication(raw_surface)
        if concept_id:
            return NormalizedMention(
                mention=mention,
                concept_id=concept_id,
                canonical_name=self.ontology.canonical_name(concept_id),
                normalization_status=NormalizationStatus.NORMALIZED,
            )
        ambiguous = self._ambiguous(surface, raw_surface, self.ontology.ambiguous_medication_aliases)
        if ambiguous is not None:
            alias, entry = ambiguous
            return NormalizedMention(
                mention=mention,
                normalization_status=NormalizationStatus.AMBIGUOUS,
                missing_information=entry["missingInformation"],
                candidate_concept_ids=list(entry.get("candidates", [])),
            )
        if surface in self.ontology.non_interacting_medications or raw_surface in self.ontology.non_interacting_medications:
            return NormalizedMention(
                mention=mention,
                canonical_name=raw_surface,
                normalization_status=NormalizationStatus.NON_INTERACTING,
            )
        return NormalizedMention(
            mention=mention,
            normalization_status=NormalizationStatus.UNKNOWN,
            missing_information="The stated medication could not be normalized against the approved synonym index.",
        )

    def ontology_hormonal(self, surface: str) -> str | None:
        return self.index.alias_to_hormonal.get(surface)

    def ontology_medication(self, surface: str) -> str | None:
        return self.index.alias_to_medication.get(surface)

    @staticmethod
    def _ambiguous(surface: str, raw_surface: str, table: dict[str, dict]) -> tuple[str, dict] | None:
        for key in (surface, raw_surface):
            if key in table:
                return key, table[key]
        return None
