"""Context classification tests: status, subject, corrections (spec §27.3, §15)."""
from app.deterministic_extractor import DeterministicExtractor
from app.models import MentionCategory, MentionStatus, SubjectRole
from tests.conftest import make_turn


def extract(index, text, speaker="patient"):
    return DeterministicExtractor(index).extract_sync(make_turn(text, speaker))


def find(extraction, category):
    return [m for m in extraction.mentions if m.category == category]


def test_current_use(index):
    e = extract(index, "I take carbamazepine.")
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert m.status == MentionStatus.CURRENT
    assert m.subject == SubjectRole.PATIENT


def test_third_person_note_is_patient(index):
    e = extract(index, "She is on Tegretol.", speaker="doctor")
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert m.subject == SubjectRole.PATIENT
    assert m.status == MentionStatus.CURRENT


def test_historical_use(index):
    e = extract(index, "I stopped carbamazepine last year.")
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert m.status == MentionStatus.HISTORICAL


def test_negation(index):
    e = extract(index, "I do not take carbamazepine.")
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert m.status == MentionStatus.NEGATED


def test_denies(index):
    e = extract(index, "She denies any use of rifampicin.", speaker="doctor")
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert m.status == MentionStatus.NEGATED


def test_planned_use(index):
    e = extract(index, "I am planning to start lamotrigine next month.")
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert m.status == MentionStatus.PLANNED


def test_doctor_we_will_start_is_planned_patient(index):
    e = extract(index, "We will start carbamazepine next week.", speaker="doctor")
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert m.status == MentionStatus.PLANNED
    assert m.subject == SubjectRole.PATIENT


def test_other_person(index):
    e = extract(index, "My sister takes carbamazepine.")
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert m.subject == SubjectRole.OTHER_PERSON


def test_doctor_discussion_not_patient_medication(index):
    e = extract(index, "The doctor explained what carbamazepine is.", speaker="doctor")
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert m.status == MentionStatus.UNCERTAIN


def test_negation_binds_to_nearest_entity(index):
    e = extract(index, "She uses a combined oral contraceptive but is not taking carbamazepine.", speaker="doctor")
    hormonal = find(e, MentionCategory.HORMONAL_PRODUCT)
    meds = find(e, MentionCategory.OTHER_MEDICATION)
    assert hormonal[0].status == MentionStatus.CURRENT
    assert meds[0].status == MentionStatus.NEGATED


def test_multiple_medications(index):
    e = extract(index, "The patient takes amlodipine, ramipril and carbamazepine daily, and uses a combined oral contraceptive.", speaker="doctor")
    meds = find(e, MentionCategory.OTHER_MEDICATION)
    surfaces = {m.surface_text.lower() for m in meds}
    assert {"amlodipine", "ramipril", "carbamazepine"} <= surfaces
    assert all(m.status == MentionStatus.CURRENT for m in meds)


def test_correction_detected(index):
    e = extract(index, "Sorry, I meant lamotrigine.")
    assert e.corrections
    assert e.corrections[0].replacement_surface_text.lower() == "lamotrigine"


def test_uncertain_medication_name(index):
    e = extract(index, "She takes something for her epilepsy but cannot recall the name.", speaker="doctor")
    assert "Specific medication name is not stated." in e.missing_information


def test_spans_point_at_surface(index):
    text = "I take Tegretol."
    e = extract(index, text)
    (m,) = find(e, MentionCategory.OTHER_MEDICATION)
    assert text[m.span_start : m.span_end] == "Tegretol"
