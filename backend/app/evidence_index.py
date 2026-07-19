"""Evidence dataset loading, validation, runtime eligibility, and the
deterministic pair index (spec §13, §22, §23).

All medical wording shown anywhere in the system comes verbatim from the record
payloads loaded here. Nothing in this module infers drug classes or invents
matches: a lookup succeeds only when (hormonal concept id, medication concept id)
is an explicitly indexed pair derived from a record's explicit membership lists.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .models import VerificationStatus

VERIFY_MARKER = re.compile(r"\[VERIFY\]|to be confirmed|exact wording to be confirmed", re.IGNORECASE)

REQUIRED_RECORD_FIELDS = [
    "id", "hormonalProduct", "hormonalSynonyms", "interactingMedication", "medicationSynonyms",
    "interactionDirection", "potentialConsequence", "clinicianConsideration", "evidenceLevel",
    "population", "sourceTitle", "sourceOrganization", "sourceUrl", "sourceSection", "jurisdiction",
    "lastVerified", "physicianVerified", "limitations",
    "matchType", "hormonalConceptIds", "interactingConceptIds", "interactionDirectionCode",
]

ALLOWED_MATCH_TYPES = {"specific_pair", "any_member", "closed_class"}
ALLOWED_DIRECTION_CODES = {
    "MEDICATION_AFFECTS_CONTRACEPTIVE",
    "CONTRACEPTIVE_AFFECTS_MEDICATION",
    "BIDIRECTIONAL_OR_COMPLEX",
}


class EvidenceValidationError(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


@dataclass
class EligibilityReport:
    record_id: str
    physician_verified: bool
    schema_valid: bool
    problems: list[str] = field(default_factory=list)
    runtime_eligible: bool = False
    eligible_via_pending_override: bool = False


@dataclass
class Ontology:
    hormonal_concepts: dict[str, dict]
    medication_concepts: dict[str, dict]
    ambiguous_hormonal_aliases: dict[str, dict]
    ambiguous_medication_aliases: dict[str, dict]
    non_interacting_medications: list[str]

    def canonical_name(self, concept_id: str) -> str:
        if concept_id in self.hormonal_concepts:
            return self.hormonal_concepts[concept_id]["canonicalName"]
        if concept_id in self.medication_concepts:
            return self.medication_concepts[concept_id]["canonicalName"]
        return concept_id


class EvidenceIndex:
    """Immutable-at-runtime evidence store + deterministic indices."""

    def __init__(
        self,
        evidence_path: Path,
        synonym_path: Path,
        strict: bool = True,
        allow_pending_verification: bool = False,
    ):
        self.evidence_path = evidence_path
        self.synonym_path = synonym_path
        self.strict = strict
        self.allow_pending_verification = allow_pending_verification

        raw = json.loads(Path(evidence_path).read_text())
        self.dataset_version: str = raw.get("datasetVersion", "unknown")
        self.records: dict[str, dict] = {r["id"]: r for r in raw.get("records", [])}

        onto_raw = json.loads(Path(synonym_path).read_text())
        self.ontology = Ontology(
            hormonal_concepts=onto_raw["hormonalConcepts"],
            medication_concepts=onto_raw["medicationConcepts"],
            ambiguous_hormonal_aliases=onto_raw.get("ambiguousHormonalAliases", {}),
            ambiguous_medication_aliases=onto_raw.get("ambiguousMedicationAliases", {}),
            non_interacting_medications=onto_raw.get("nonInteractingMedications", []),
        )

        self.reports: dict[str, EligibilityReport] = {}
        self.alias_to_hormonal: dict[str, str] = {}
        self.alias_to_medication: dict[str, str] = {}
        self.pair_index: dict[tuple[str, str], list[str]] = {}

        errors = self._validate_and_build()
        if errors and self.strict:
            raise EvidenceValidationError(errors)
        self.load_errors = errors

    # -- validation ---------------------------------------------------------

    def _validate_and_build(self) -> list[str]:
        errors: list[str] = []
        errors.extend(self._build_alias_indices())

        for rid, record in self.records.items():
            report = EligibilityReport(record_id=rid, physician_verified=bool(record.get("physicianVerified")), schema_valid=True)
            for f in REQUIRED_RECORD_FIELDS:
                if f not in record:
                    report.schema_valid = False
                    report.problems.append(f"missing field {f}")
            if record.get("matchType") not in ALLOWED_MATCH_TYPES:
                report.schema_valid = False
                report.problems.append(f"invalid matchType {record.get('matchType')!r}")
            if record.get("interactionDirectionCode") not in ALLOWED_DIRECTION_CODES:
                report.schema_valid = False
                report.problems.append(f"invalid interactionDirectionCode {record.get('interactionDirectionCode')!r}")
            if not str(record.get("sourceUrl", "")).startswith("http"):
                report.schema_valid = False
                report.problems.append("sourceUrl is not a URL")
            if not str(record.get("sourceSection", "")).strip():
                report.schema_valid = False
                report.problems.append("sourceSection is empty")
            for cid in record.get("hormonalConceptIds", []):
                if cid not in self.ontology.hormonal_concepts:
                    report.schema_valid = False
                    report.problems.append(f"unknown hormonal concept {cid}")
            members = record.get("interactingConceptIds", [])
            if not members:
                report.schema_valid = False
                report.problems.append("interactingConceptIds is empty (explicit membership required)")
            for cid in members:
                if cid not in self.ontology.medication_concepts:
                    report.schema_valid = False
                    report.problems.append(f"unknown medication concept {cid}")
            # Text fields displayed to users must carry no unresolved verification language.
            display_fields = ["interactionDirection", "potentialConsequence", "evidenceLevel", "population", "sourceSection"]
            has_verify_marker = any(VERIFY_MARKER.search(str(record.get(f, ""))) for f in display_fields)
            if has_verify_marker:
                report.problems.append("unresolved verification marker in display field")

            eligible_except_signoff = report.schema_valid and not has_verify_marker
            report.runtime_eligible = eligible_except_signoff and report.physician_verified
            if not report.runtime_eligible and eligible_except_signoff and self.allow_pending_verification:
                report.runtime_eligible = True
                report.eligible_via_pending_override = True

            if not report.schema_valid:
                errors.append(f"{rid}: " + "; ".join(report.problems))
            self.reports[rid] = report

        errors.extend(self._build_pair_index())
        return errors

    def _build_alias_indices(self) -> list[str]:
        errors: list[str] = []
        for concept_id, concept in self.ontology.hormonal_concepts.items():
            for alias in [concept["canonicalName"], *concept.get("aliases", [])]:
                key = alias.lower().strip()
                existing = self.alias_to_hormonal.get(key)
                if existing and existing != concept_id:
                    errors.append(f"hormonal alias collision: {key!r} -> {existing} and {concept_id}")
                self.alias_to_hormonal[key] = concept_id
        for concept_id, concept in self.ontology.medication_concepts.items():
            for alias in [concept["canonicalName"], *concept.get("aliases", [])]:
                key = alias.lower().strip()
                existing = self.alias_to_medication.get(key)
                if existing and existing != concept_id:
                    errors.append(f"medication alias collision: {key!r} -> {existing} and {concept_id}")
                self.alias_to_medication[key] = concept_id
        # An alias must not be simultaneously ambiguous and concrete.
        for key in self.ontology.ambiguous_hormonal_aliases:
            if key.lower() in self.alias_to_hormonal:
                errors.append(f"alias {key!r} is both ambiguous and concrete (hormonal)")
        for key in self.ontology.ambiguous_medication_aliases:
            if key.lower() in self.alias_to_medication:
                errors.append(f"alias {key!r} is both ambiguous and concrete (medication)")
        # Cross-category collisions would corrupt category assignment.
        overlap = set(self.alias_to_hormonal) & set(self.alias_to_medication)
        for key in overlap:
            errors.append(f"alias {key!r} appears in both hormonal and medication indices")
        return errors

    def _build_pair_index(self) -> list[str]:
        errors: list[str] = []
        for rid, record in self.records.items():
            report = self.reports.get(rid)
            if report is None or not report.runtime_eligible:
                continue
            for h in record.get("hormonalConceptIds", []):
                for m in record.get("interactingConceptIds", []):
                    self.pair_index.setdefault((h, m), [])
                    if rid not in self.pair_index[(h, m)]:
                        self.pair_index[(h, m)].append(rid)
        return errors

    # -- queries ------------------------------------------------------------

    def lookup_pair(self, hormonal_concept_id: str, medication_concept_id: str) -> list[str]:
        return list(self.pair_index.get((hormonal_concept_id, medication_concept_id), []))

    def get_record(self, record_id: str) -> dict:
        return self.records[record_id]

    def verification_status(self, record_id: str) -> VerificationStatus:
        if self.records[record_id].get("physicianVerified"):
            return VerificationStatus.PHYSICIAN_VERIFIED
        return VerificationStatus.SIGN_OFF_PENDING

    def runtime_eligible_ids(self) -> list[str]:
        return [rid for rid, rep in self.reports.items() if rep.runtime_eligible]

    def eligibility_summary(self) -> dict:
        return {
            "datasetVersion": self.dataset_version,
            "recordCount": len(self.records),
            "runtimeEligible": self.runtime_eligible_ids(),
            "pendingPhysicianSignOff": [
                rid for rid, rep in self.reports.items() if rep.eligible_via_pending_override
            ],
            "excluded": {
                rid: rep.problems for rid, rep in self.reports.items() if not rep.runtime_eligible
            },
            "allowPendingVerification": self.allow_pending_verification,
        }
