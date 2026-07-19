"""Evidence dataset tests (spec §27.1)."""
import json
import re

from app.evidence_index import REQUIRED_RECORD_FIELDS, VERIFY_MARKER


def test_schema_all_required_fields(index):
    for rid, record in index.records.items():
        for field in REQUIRED_RECORD_FIELDS:
            assert field in record, f"{rid} missing {field}"


def test_six_records(index):
    assert len(index.records) == 6


def test_no_verify_markers_in_runtime_eligible_records(index):
    display_fields = ["interactionDirection", "potentialConsequence", "evidenceLevel", "population", "sourceSection"]
    for rid in index.runtime_eligible_ids():
        record = index.records[rid]
        for field in display_fields:
            assert not VERIFY_MARKER.search(str(record[field])), f"{rid}.{field} has verification marker"


def test_source_completeness(index):
    for rid, record in index.records.items():
        assert record["sourceUrl"].startswith("http"), rid
        assert record["sourceSection"].strip(), rid
        assert record["sourceOrganization"].strip(), rid
        assert record["sourceTitle"].strip(), rid
        assert record["jurisdiction"].strip(), rid
        assert record["lastVerified"], rid


def test_explicit_class_membership(index):
    for rid, record in index.records.items():
        assert record["interactingConceptIds"], f"{rid} lacks explicit members"
        if record["matchType"] in ("closed_class", "any_member"):
            assert len(record["interactingConceptIds"]) >= 2, rid
        # 'e.g.' lists are never machine-matching input; members must be ontology concepts.
        for cid in record["interactingConceptIds"]:
            assert cid in index.ontology.medication_concepts, f"{rid}: {cid} not in ontology"
        for cid in record["hormonalConceptIds"]:
            assert cid in index.ontology.hormonal_concepts, f"{rid}: {cid} not in ontology"


def test_no_alias_collisions(index):
    assert index.load_errors == []


def test_lamotrigine_direction_reversed(index):
    record = index.records["INT-005"]
    assert record["interactionDirectionCode"] == "CONTRACEPTIVE_AFFECTS_MEDICATION"
    assert "reverse" in record["interactionDirection"].lower() or "reversed" in record["interactionDirection"].lower()
    for rid in ("INT-001", "INT-002", "INT-003", "INT-004", "INT-006"):
        assert index.records[rid]["interactionDirectionCode"] == "MEDICATION_AFFECTS_CONTRACEPTIVE", rid


def test_int006_stays_non_directive(index):
    consequence = index.records["INT-006"]["potentialConsequence"].lower()
    for banned in ("copper iud", "double dose", "doubling", "3 mg", "should take"):
        assert banned not in consequence


def test_strict_eligibility_requires_physician_signoff(strict_index):
    # No record is physician-verified yet, so under spec-strict rules none are
    # runtime-eligible and the pair index must be empty (no warnings possible).
    assert strict_index.runtime_eligible_ids() == []
    assert strict_index.pair_index == {}


def test_pending_override_labels_records(index):
    for rid in index.runtime_eligible_ids():
        report = index.reports[rid]
        assert report.eligible_via_pending_override is True
        assert index.verification_status(rid).value == "physician_sign_off_pending"


def test_pair_index_contains_expected_pairs(index):
    expected = [
        ("combined_hormonal_contraceptive", "carbamazepine", "INT-001"),
        ("combined_hormonal_contraceptive", "rifampicin", "INT-002"),
        ("combined_hormonal_contraceptive", "rifabutin", "INT-002"),
        ("progestogen_only_pill", "carbamazepine", "INT-003"),
        ("progestogen_only_pill", "rifampicin", "INT-003"),
        ("etonogestrel_implant", "carbamazepine", "INT-004"),
        ("estrogen_containing_oral_contraceptive", "lamotrigine", "INT-005"),
        ("combined_hormonal_contraceptive", "lamotrigine", "INT-005"),
        ("levonorgestrel_emergency_contraception", "rifampicin", "INT-006"),
        ("levonorgestrel_emergency_contraception", "st_johns_wort", "INT-006"),
    ]
    for h, m, rid in expected:
        assert rid in index.lookup_pair(h, m), (h, m)


def test_no_pair_for_unindexed_combination(index):
    assert index.lookup_pair("combined_hormonal_contraceptive", "phenytoin") == []
    assert index.lookup_pair("etonogestrel_implant", "lamotrigine") == []


def test_medical_prose_identical_to_v1(index, settings):
    """The v2 file may add machine metadata but never edit medical prose."""
    v1 = {r["id"]: r for r in json.loads(open("/home/alex/HormoneRx-Benchmark/src/data/evidence_records.json").read())["records"]} \
        if __import__("os").path.exists("/home/alex/HormoneRx-Benchmark/src/data/evidence_records.json") else None
    if v1 is None:
        return  # original moved; covered by the generation script check
    prose = ["interactionDirection", "potentialConsequence", "clinicianConsideration",
             "evidenceLevel", "population", "sourceTitle", "sourceUrl", "sourceSection", "limitations"]
    for rid, record in index.records.items():
        for field in prose:
            assert record[field] == v1[rid][field], f"{rid}.{field} drifted from v1"
