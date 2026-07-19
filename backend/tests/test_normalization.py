"""Normalization tests (spec §27.2)."""
import pytest

from app.models import Certainty, ExtractedMention, MentionCategory, MentionStatus, SubjectRole
from app.normalizer import ConceptNormalizer


def mention(surface: str, category=MentionCategory.OTHER_MEDICATION) -> ExtractedMention:
    return ExtractedMention(
        surface_text=surface,
        category=category,
        status=MentionStatus.CURRENT,
        subject=SubjectRole.PATIENT,
        certainty=Certainty.EXPLICIT,
        source_turn_id="turn-1",
    )


@pytest.fixture()
def normalizer(index):
    return ConceptNormalizer(index)


@pytest.mark.parametrize(
    "surface,expected",
    [
        ("combined pill", "combined_hormonal_contraceptive"),
        ("COC", "combined_hormonal_contraceptive"),
        ("combined oral contraceptive", "combined_hormonal_contraceptive"),
        ("Nexplanon", "etonogestrel_implant"),
        ("morning-after pill", "levonorgestrel_emergency_contraception"),
        ("mini pill", "progestogen_only_pill"),
        ("estrogen-containing pill", "estrogen_containing_oral_contraceptive"),
    ],
)
def test_hormonal_normalization(normalizer, surface, expected):
    result = normalizer.normalize_one(mention(surface, MentionCategory.HORMONAL_PRODUCT))
    assert result.concept_id == expected
    assert result.normalization_status.value == "normalized"


@pytest.mark.parametrize(
    "surface,expected",
    [
        ("Tegretol", "carbamazepine"),
        ("carbamazepine", "carbamazepine"),
        ("carbamazapine", "carbamazepine"),   # documented misspelling
        ("carbamezapine", "carbamazepine"),   # documented misspelling
        ("Lamictal", "lamotrigine"),
        ("rifampin", "rifampicin"),           # US name -> UK concept
        ("rifampicin", "rifampicin"),
        ("Mycobutin", "rifabutin"),
        ("St John's wort", "st_johns_wort"),
    ],
)
def test_medication_normalization(normalizer, surface, expected):
    result = normalizer.normalize_one(mention(surface))
    assert result.concept_id == expected
    assert result.normalization_status.value == "normalized"


def test_the_pill_is_ambiguous_not_guessed(normalizer):
    result = normalizer.normalize_one(mention("the pill", MentionCategory.HORMONAL_PRODUCT))
    assert result.normalization_status.value == "ambiguous"
    assert result.concept_id is None
    assert "combined_hormonal_contraceptive" in result.candidate_concept_ids
    assert result.missing_information


def test_class_word_is_ambiguous_not_a_concept(normalizer):
    result = normalizer.normalize_one(mention("enzyme inducer"))
    assert result.normalization_status.value == "ambiguous"
    assert result.concept_id is None


def test_unknown_medication_stays_unknown(normalizer):
    result = normalizer.normalize_one(mention("zaltrapan"))
    assert result.normalization_status.value == "unknown"
    assert result.concept_id is None
    assert result.missing_information


def test_non_interacting_lexicon(normalizer):
    result = normalizer.normalize_one(mention("paracetamol"))
    assert result.normalization_status.value == "non_interacting"
    assert result.concept_id is None
