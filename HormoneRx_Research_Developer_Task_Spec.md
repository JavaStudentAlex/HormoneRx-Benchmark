# HormoneRx Real-Time Research and Implementation Specification

**Document type:** Researcher-developer task specification  
**Project:** HormoneRx Benchmark / Hormone-Aware Prescribing Infrastructure  
**Scope:** Real-time doctor-patient conversation transcription, encounter graph construction, deterministic evidence validation, and cautious clinician warning  
**Primary implementation language:** Python  
**Frontend:** Existing Lovable-generated React/TypeScript application  
**Status:** MVP implementation specification  
**Date:** 2026-07-19  

---

## 1. Executive directive

Build a **real-time, audio-first research prototype** that listens during a doctor-patient consultation, converts finalized speech turns into a structured encounter graph, and continuously checks the active or proposed medication combination against a small, physician-reviewed evidence dataset covering hormonal contraceptives and medication interactions.

The system must be able to:

1. Start and stop a live listening session with explicit user action.
2. Display live transcription while the consultation is occurring.
3. Analyze only stable, finalized transcript turns for medical context.
4. identify hormonal products, other medications, their status, their subject, and their temporal context.
5. Build and update an encounter-level graph throughout the visit.
6. Add a proposed prescription as a new graph assertion.
7. Recompute evidence matches whenever the graph changes.
8. Surface a cautious, source-linked warning only when a verified evidence record deterministically matches the graph.
9. Retract or downgrade a warning when later speech corrects, negates, or historicizes an earlier statement.
10. Record enough provenance to explain exactly which transcript turn, graph assertion, and evidence record produced each result.

The product must **not** decide that a patient is safe, in danger, correctly treated, incorrectly treated, or eligible for a specific prescription. It is an evidence-surfacing system, not an autonomous clinical decision-maker.

The lasting research contribution is:

- a machine-readable evidence layer;
- an event and graph schema for real-time medication-context tracking;
- a synthetic streaming consultation benchmark;
- a reproducible evaluation pipeline;
- a transparent warning and retraction protocol.

---

## 2. Deliberate scope revision

The previous project context prioritized a text-only consultation demo and explicitly treated live recording as out of scope. This specification deliberately revises that decision.

The new MVP is **audio-first**, but it must preserve the earlier safety architecture:

- the sound model performs speech-to-text only;
- the extraction model produces constrained structured context only;
- the Python graph engine owns encounter state;
- deterministic code owns evidence matching;
- the curated evidence file owns all visible medical claims;
- the system never generates free-form prescribing advice.

This scope expansion is permitted only because audio is treated as an input modality around the existing narrow evidence task. The project must not expand into a general clinical scribe, full EHR, comprehensive drug-interaction checker, diagnostic assistant, or persistent patient knowledge graph.

---

## 3. One-sentence product definition

> HormoneRx is a real-time clinical-conversation listener that transcribes finalized speech turns, maintains a provenance-linked encounter medication graph, and retrieves physician-verified hormone-medication evidence whenever the current or proposed patient context matches an indexed evidence record.

---

## 4. Research question

The core research question is:

> Can an AI-assisted real-time pipeline correctly preserve medication names, hormonal context, subject attribution, negation, temporality, and corrections from a doctor-patient conversation, update an encounter graph incrementally, and retrieve the correct physician-verified evidence record without generating unsupported medical advice?

The system is evaluated as a sequence-processing and evidence-retrieval system, not as a prescribing system.

### 4.1 Capabilities being studied

- Live medication-name transcription.
- Hormonal-product recognition.
- Synonym normalization.
- Current versus historical use.
- Planned versus active prescriptions.
- Affirmed versus negated medication mentions.
- Patient versus doctor versus another-person attribution.
- Incremental graph construction.
- Correction and retraction handling.
- Deterministic evidence retrieval.
- Citation completeness.
- Warning timing and premature-warning prevention.
- End-to-end latency.

### 4.2 Claims that must not be made

Do not claim that the system:

- validates a prescription clinically;
- detects all harmful combinations;
- determines that a patient is in danger;
- recommends a medication, dose, or contraceptive method;
- establishes that a no-match result is safe;
- performs comprehensive drug-interaction checking;
- has been clinically validated;
- is ready for autonomous deployment;
- is compliant with all medical-device, privacy, or data-protection obligations merely because the prototype avoids names.

---

## 5. Required terminology

Use the following language consistently in code, documentation, and the user interface.

### 5.1 Preferred terms

- **Potentially relevant evidence found**
- **Evidence match**
- **Evidence relevance check**
- **Encounter medication graph**
- **Proposed prescription assertion**
- **Physician-verified evidence record**
- **More information required**
- **Excluded context**
- **No record in the current prototype dataset**
- **Warning retracted after correction**
- **Research prototype**

### 5.2 Prohibited terms

- Safe
- Unsafe
- Dangerous
- No interaction
- Prescription approved
- Prescription rejected
- Correct dose
- Wrong dose
- Contraindicated, unless that exact term is present and supported in the verified evidence record
- Clinical validation passed

The application may use an amber or neutral warning presentation, but must never use a green “safe” result.

---

## 6. High-level system architecture

```text
Browser microphone
        |
        v
Realtime speech-to-text session
        |
        | partial transcript deltas -> caption display only
        |
        | finalized transcript turns
        v
Python transcript event router
        |
        v
Structured medication-context extraction
        |
        v
Append-only encounter event log
        |
        v
Derived encounter graph snapshot
        |
        v
Graph consistency and eligibility validation
        |
        v
Deterministic normalized evidence lookup
        |
        +--> EVIDENCE_FOUND
        +--> MORE_INFORMATION_REQUIRED
        +--> EXCLUDED_CONTEXT
        +--> NO_VALIDATED_MATCH
        +--> RETRACTED
        |
        v
WebSocket update to Lovable/React UI
```

### 6.1 Recommended division of responsibilities

| Component | Responsibility | Must not do |
|---|---|---|
| Realtime sound model | Convert audio to transcript deltas and final turns | Decide medical relevance |
| Browser UI | Capture microphone, show captions, label speaker, show graph and warning state | Store permanent API key |
| Python API | Session control, event routing, graph state, matching, audit, benchmark | Generate uncited medical advice |
| Extraction model | Convert finalized text into constrained entities and context | Invent interactions or recommendations |
| Evidence index | Normalize approved names and perform exact deterministic lookup | Infer unknown drug classes |
| Evidence dataset | Provide approved medical content and provenance | Change at runtime |
| Benchmark runner | Compare outputs with immutable gold labels | Modify labels to improve results |

---

## 7. Real-time interaction requirements during the doctor visit

This section is mandatory. A system that only uploads a recording after the appointment does not satisfy the real-time MVP.

### 7.1 Session start

The Live Consultation page must include:

- `Start listening` button;
- `Stop listening` button;
- microphone permission status;
- visible recording/listening indicator;
- active speaker control;
- current session duration;
- `Clear encounter` control;
- text-input fallback;
- persistent research-prototype and consent notice.

The system must not begin capturing audio automatically when the page loads.

Before capture starts, the UI must communicate that:

- audio is being processed for live transcription;
- this is a prototype;
- the system does not make prescribing decisions;
- synthetic conversations should be used for the hackathon demonstration;
- raw audio is not retained by default in the MVP.

### 7.2 Audio transport

Preferred browser architecture:

```text
Browser microphone
    -> WebRTC connection to realtime transcription service
    -> transcript events returned to browser
    -> finalized turns sent to Python backend
```

The backend must mint temporary or ephemeral client credentials. A normal long-lived API key must never be exposed in browser JavaScript or in the Lovable bundle.

Alternative architecture, permitted only if WebRTC integration blocks the build:

```text
Browser microphone
    -> browser WebSocket to Python
    -> Python server-side realtime transcription connection
```

The fallback may be less efficient but is acceptable for the MVP if it is stable and secrets remain server-side.

### 7.3 Model configuration

The live transcription model must be configured through environment variables rather than permanently hard-coded.

Recommended initial configuration as of this specification:

```text
TRANSCRIPTION_PROVIDER=openai
TRANSCRIPTION_MODEL=gpt-realtime-whisper
TRANSCRIPTION_LANGUAGE=en
```

The official OpenAI documentation currently describes `gpt-realtime-whisper` as the low-latency, natively streaming option for live transcript deltas. The developer must still test the selected model with the actual microphone, room noise, accents, and medication vocabulary.

Required fallback:

- a prerecorded synthetic audio file;
- text input;
- deterministic demo transcript events.

The demo must not fail completely because the live model, network, or microphone fails.

### 7.4 Partial versus finalized transcription

The application must distinguish two classes of transcript data.

#### Partial transcript delta

- Display as live captions.
- Style as provisional.
- Do not update the medical graph.
- Do not trigger an evidence warning.
- Do not store as a permanent encounter assertion.

#### Finalized transcript turn

- Store as a transcript event.
- Assign a stable event ID and provider item ID.
- Send to the extraction pipeline.
- Update the encounter event log.
- Recompute the graph.
- Recompute the result state.

This rule prevents a premature warning from incomplete speech such as:

> “She takes carbamazepine, but...”

before the speaker finishes:

> “...she stopped it last year.”

### 7.5 Ordering and deduplication

Realtime transcript completion events may not always arrive in the same order in which separate turns were spoken. The event router must therefore preserve:

- provider `item_id`;
- local `event_id`;
- sequence number;
- start timestamp;
- end timestamp;
- receipt timestamp;
- speaker label;
- final transcript text;
- processing status.

The router must:

1. reject duplicate final events;
2. reorder events when sequence information permits;
3. mark late events;
4. recompute the graph if a late event changes context;
5. never silently process the same finalized turn twice.

### 7.6 Speech-turn finalization

The MVP must support at least one reliable turn-finalization method:

- server voice activity detection;
- provider turn detection;
- browser-side silence detection;
- push-to-talk;
- manual `Finalize turn` button.

For a noisy hackathon room, retain a manual fallback even when automatic voice activity detection is enabled.

Do not split audio on fixed short windows if this is likely to separate a medication statement from its negation or temporal qualifier.

### 7.7 Speaker attribution

The graph must know who a medication statement refers to. Speech-to-text alone does not guarantee reliable speaker identity.

For the MVP, implement an explicit speaker selector:

```text
Doctor | Patient | Unknown
```

Every finalized transcript turn must include the selected speaker.

Optional controls:

- keyboard shortcut `D` for doctor;
- keyboard shortcut `P` for patient;
- auto-return to patient after a doctor question;
- two-device or two-channel capture if available.

Do not make automatic realtime diarization a hard dependency for the demo. Current OpenAI documentation describes speaker-aware diarization through `gpt-4o-transcribe-diarize` on the Audio Transcriptions API, not as a native Realtime API feature. Retrospective diarization may be evaluated as an optional enhancement, but the live system must remain usable with explicit speaker metadata.

### 7.8 Real-time processing timing

The system should aim for the following engineering targets, reported honestly as prototype targets rather than guarantees:

| Stage | Target |
|---|---:|
| Partial caption appearance | less than 1 second after speech when network permits |
| Final turn available | approximately 0.5-2.0 seconds after speech end |
| Extraction and graph update | less than 1.5 seconds median |
| Evidence lookup | less than 50 milliseconds after graph eligibility |
| UI result update | less than 2 seconds after receiving final transcript |

Record actual latency values in the benchmark. Do not fabricate latency if it was not measured.

### 7.9 Interaction throughout the visit

The graph and result panel must update after every finalized relevant turn.

Example progression:

```text
Turn 1 - Patient: “I take carbamazepine.”
Graph: current patient medication = carbamazepine
Result: MORE_INFORMATION_REQUIRED
Reason: hormonal product not yet known

Turn 2 - Doctor: “Are you using hormonal contraception?”
Graph: no new medication assertion
Result: unchanged

Turn 3 - Patient: “I use the combined pill.”
Graph: current hormonal product = combined hormonal contraceptive
Result: EVIDENCE_FOUND -> INT-001

Turn 4 - Patient: “Actually, I stopped carbamazepine last year.”
Graph: carbamazepine current assertion superseded by historical assertion
Result: RETRACTED or EXCLUDED_CONTEXT
Previous warning: visibly retracted with reason
```

### 7.10 Session end

When listening stops:

- stop microphone tracks;
- close the realtime connection;
- stop accepting transcript deltas;
- finalize or discard any incomplete turn explicitly;
- preserve the encounter event log only in memory by default;
- allow export of a synthetic audit JSON for the demo;
- allow complete deletion/reset of the encounter;
- do not silently continue recording.

---

## 8. The two-graph architecture

Use two conceptually separate graphs.

### 8.1 Evidence graph

The evidence graph is curated, versioned, and immutable during a consultation.

It contains:

- normalized hormonal product concepts;
- normalized medication concepts;
- verified interaction/evidence records;
- source documents;
- jurisdiction;
- evidence type;
- verification metadata;
- explicit class membership lists;
- synonyms.

Only physician-approved records with complete provenance may become active evidence graph edges.

### 8.2 Encounter graph

The encounter graph is built incrementally from the current consultation.

It contains:

- the encounter;
- the patient subject;
- doctor and other-person subjects;
- finalized transcript turns;
- extracted medication mentions;
- normalized medication concepts;
- temporal status;
- assertion status;
- proposed prescriptions;
- corrections;
- retractions;
- evidence matches;
- warning lifecycle records.

The encounter graph is temporary and must not become a permanent patient record in the MVP.

### 8.3 Link between the graphs

The graphs connect only through normalized concept identifiers and verified evidence record identifiers.

```text
Encounter assertion
    Patient CURRENTLY_TAKES Carbamazepine

Encounter assertion
    Patient CURRENTLY_USES Combined hormonal contraceptive

Evidence index lookup
    combined_hormonal_contraceptive | carbamazepine

Evidence graph match
    INT-001

Derived result
    EVIDENCE_FOUND
```

The extraction model may create or revise encounter assertions. It must never create new medical interaction edges in the evidence graph.

---

## 9. Why the MVP should not use Neo4j

The data is graph-shaped, but a graph database is not required for the MVP.

Use:

- Pydantic models;
- Python dictionaries;
- typed edge lists;
- an append-only event log;
- an in-memory derived snapshot;
- deterministic indices.

This provides the conceptual benefits of a graph while preserving:

- simple deployment;
- reproducibility;
- fast tests;
- transparent state transitions;
- low integration risk.

A graph database may be considered after the hackathon when the project includes longitudinal records, multiple encounters, laboratories, diagnoses, identity resolution, permissions, and durable provenance.

---

## 10. Event-sourced encounter design

Do not mutate the patient graph without preserving how the change happened.

The backend should maintain:

1. an append-only event log;
2. a derived current graph snapshot.

### 10.1 Why event sourcing is required

The consultation can contain corrections:

- “I take carbamazepine.”
- “No, sorry, I stopped it last year.”

If the implementation simply overwrites the old value, it becomes impossible to explain why the warning appeared and disappeared. An event log preserves the trace.

### 10.2 Event types

At minimum:

```text
SESSION_STARTED
SESSION_STOPPED
TRANSCRIPT_PARTIAL_RECEIVED
TRANSCRIPT_FINAL_RECEIVED
MENTIONS_EXTRACTED
ASSERTION_ADDED
ASSERTION_SUPERSEDED
ASSERTION_RETRACTED
PRESCRIPTION_PROPOSED
GRAPH_RECOMPUTED
EVIDENCE_MATCH_CREATED
EVIDENCE_MATCH_REMOVED
WARNING_CREATED
WARNING_UPDATED
WARNING_RETRACTED
EXTRACTION_FAILED
TRANSCRIPTION_FAILED
SESSION_RESET
```

Partial transcript events may be omitted from the durable in-memory audit log if they are too noisy, but final transcript and graph events must be retained for the current session.

### 10.3 Required event metadata

```json
{
  "event_id": "evt-uuid",
  "encounter_id": "enc-uuid",
  "event_type": "TRANSCRIPT_FINAL_RECEIVED",
  "occurred_at": "2026-07-19T10:15:03.120Z",
  "sequence": 17,
  "provider_item_id": "item_003",
  "speaker": "patient",
  "payload": {},
  "schema_version": "1.0"
}
```

---

## 11. Encounter graph schema

### 11.1 Node types

#### Encounter node

```text
Encounter
- encounter_id
- started_at
- stopped_at
- status
- synthetic_demo
- schema_version
```

#### Subject node

```text
Subject
- subject_id
- role: patient | doctor | other_person | unknown
- display_label
```

Do not store real names in the hackathon demo.

#### Transcript turn node

```text
TranscriptTurn
- turn_id
- provider_item_id
- sequence
- speaker
- text
- is_final
- started_at_ms
- ended_at_ms
- received_at
```

#### Mention node

```text
MedicationMention
- mention_id
- surface_text
- category
- normalized_concept_id
- status
- subject
- certainty
- source_turn_id
- span_start
- span_end
- extraction_method
- extraction_model
```

#### Medication concept node

```text
MedicationConcept
- concept_id
- canonical_name
- concept_type: hormonal_product | other_medication
- approved_synonyms
```

#### Prescription proposal node

```text
PrescriptionProposal
- proposal_id
- concept_id
- route_if_explicit
- dose_if_explicit
- status: planned | cancelled | accepted_unknown
- source_turn_id or UI event ID
```

The MVP extracts route or dose only when explicitly stated and must not use them to generate dosing advice.

#### Evidence record node

```text
EvidenceRecord
- record_id
- status
- interaction_direction
- consequence
- evidence_level
- jurisdiction
- physician_verified
- last_verified
```

#### Source node

```text
EvidenceSource
- source_id
- title
- organization
- url
- section
- jurisdiction
- revision_date
- retrieved_at
```

#### Warning node

```text
Warning
- warning_id
- state
- evidence_record_id
- created_at
- updated_at
- retracted_at
- trigger_assertion_ids
- reason
```

### 11.2 Edge types

```text
Encounter CONTAINS_TURN TranscriptTurn
TranscriptTurn MENTIONS MedicationMention
MedicationMention REFERS_TO MedicationConcept
MedicationMention ATTRIBUTED_TO Subject
Subject CURRENTLY_TAKES MedicationConcept
Subject CURRENTLY_USES MedicationConcept
Subject HISTORICALLY_USED MedicationConcept
Subject PLANS_TO_TAKE MedicationConcept
Subject NEGATED_USE_OF MedicationConcept
Assertion SUPERCEDES Assertion
PrescriptionProposal PROPOSES MedicationConcept
EvidenceRecord CONNECTS HormonalProductConcept
EvidenceRecord CONNECTS InteractingMedicationConcept
EvidenceRecord SUPPORTED_BY EvidenceSource
Encounter MATCHED EvidenceRecord
Warning TRIGGERED_BY Assertion
Warning REFERENCES EvidenceRecord
Warning RETRACTED_BY TranscriptTurn
```

Use the correctly spelled implementation name `SUPERSEDES` even if an early draft contains `SUPERCEDES`.

### 11.3 Edge attributes

Every encounter medication assertion edge must include:

```text
assertion_id
status
subject_id
source_turn_id
valid_from
valid_to
certainty
is_active
normalization_method
supersedes_assertion_id
```

### 11.4 Allowed medication status values

```text
current
historical
planned
negated
uncertain
```

### 11.5 Allowed subject values

```text
patient
doctor
other_person
unknown
```

Only assertions attributed to the patient are eligible for the primary evidence warning.

---

## 12. Structured extraction contract

The extraction model must return data conforming to a strict schema.

```json
{
  "turn_id": "turn-017",
  "speaker": "patient",
  "mentions": [
    {
      "surface_text": "Tegretol",
      "normalized_candidate": "Carbamazepine",
      "category": "other_medication",
      "status": "current",
      "subject": "patient",
      "certainty": "explicit",
      "span_start": 7,
      "span_end": 15
    }
  ],
  "corrections": [],
  "missing_information": [],
  "should_recompute_graph": true
}
```

### 12.1 The extraction model may return

- medication mention text;
- candidate normalized name;
- hormonal-product category;
- other-medication category;
- current, historical, planned, negated, or uncertain status;
- patient, doctor, other-person, or unknown subject;
- explicitly stated route;
- explicitly stated dose;
- correction target when explicit;
- missing information;
- transcript spans;
- confidence/certainty class.

### 12.2 The extraction model must not return

- interaction claims;
- clinical consequences;
- mechanisms;
- severity;
- evidence level;
- treatment recommendations;
- dose recommendations;
- source citations;
- “safe” or “unsafe” judgments;
- evidence record IDs guessed from model memory.

### 12.3 Structured outputs

Use Pydantic schemas and provider-supported structured outputs where possible. Validate every model response with Pydantic before it is allowed to update the graph.

On validation failure:

- do not partially apply the invalid response;
- log an `EXTRACTION_FAILED` event;
- show a non-medical processing error;
- retain the transcript text;
- permit manual retry or deterministic fallback.

---

## 13. Deterministic normalization requirements

Normalization must be controlled by the approved dataset, not by open-ended model knowledge.

### 13.1 Synonym index

At application startup, build:

```python
alias_to_concept: dict[str, str]
concept_to_aliases: dict[str, set[str]]
pair_to_evidence_ids: dict[tuple[str, str], list[str]]
```

### 13.2 Normalization behavior

```text
combined pill -> combined_hormonal_contraceptive
COC -> combined_hormonal_contraceptive
Tegretol -> carbamazepine
Lamictal -> lamotrigine
Nexplanon -> etonogestrel_implant
```

### 13.3 Unknown names

An unknown medication must not be assigned to a medical class merely because the extraction model believes it belongs there.

Return:

```text
normalized_concept_id = null
normalization_status = unknown
```

An unknown concept cannot trigger a verified match.

### 13.4 Broad class records must be closed classes

The current evidence examples contain strings such as:

```text
“Hepatic enzyme-inducing medication”
“e.g. carbamazepine, phenytoin, rifampicin...”
```

This is not sufficient for machine matching.

Every class-based record must include an explicit field such as:

```json
{
  "matchType": "closed_class",
  "includedMedicationConcepts": [
    "carbamazepine",
    "phenytoin",
    "phenobarbital",
    "primidone",
    "topiramate",
    "oxcarbazepine",
    "rifampicin",
    "rifabutin"
  ]
}
```

The phrase `e.g.` must never be parsed as a complete or authoritative membership list.

### 13.5 Multi-member records

A record such as “Rifampicin or rifabutin” should expose explicit members:

```json
{
  "interactingMedication": "Rifampicin or rifabutin",
  "matchType": "any_member",
  "includedMedicationConcepts": [
    "rifampicin",
    "rifabutin"
  ]
}
```

---

## 14. Graph update algorithm

For each finalized transcript turn:

1. Validate event envelope.
2. Add the final transcript event to the append-only event log.
3. Run structured extraction.
4. Validate extracted entities.
5. Normalize each mention against the approved synonym index.
6. Create mention nodes linked to the transcript turn.
7. Convert eligible mentions into graph assertions.
8. Detect whether the new assertion supersedes an older assertion.
9. Apply correction or retraction rules.
10. Rebuild or incrementally update the current encounter snapshot.
11. Run graph consistency validation.
12. Identify eligible current/planned medication pairs.
13. Query the deterministic evidence index.
14. Compare the new matches with the previous matches.
15. Create, update, preserve, or retract warnings.
16. Emit one complete state update to the frontend.
17. Record processing latency and outcome.

### 14.1 Pseudocode

```python
async def process_final_turn(event):
    validate_event(event)
    event_log.append(event)

    extraction = await extractor.extract(event)
    validate_extraction(extraction)

    normalized_mentions = normalizer.normalize(extraction.mentions)
    graph_events = graph_builder.to_events(event, normalized_mentions)
    event_log.extend(graph_events)

    encounter_graph = reducer.rebuild(event_log)
    graph_validator.validate(encounter_graph)

    eligible_pairs = pair_builder.get_eligible_pairs(encounter_graph)
    matches = evidence_index.lookup_many(eligible_pairs)

    result = warning_engine.reconcile(
        previous_state=current_result,
        encounter_graph=encounter_graph,
        matches=matches,
    )

    audit_log.record(event, extraction, graph_events, result)
    await websocket.publish(encounter_graph, result)
```

---

## 15. Temporal, negation, subject, and correction rules

### 15.1 Current use

Examples:

- “I take carbamazepine.”
- “She is on Tegretol.”
- “Carbamazepine is one of her regular medications.”

Create an active `CURRENTLY_TAKES` patient assertion when the subject is clear.

### 15.2 Historical use

Examples:

- “I stopped carbamazepine last year.”
- “She previously took Tegretol.”
- “Carbamazepine was discontinued.”

Create a `HISTORICALLY_USED` assertion and deactivate any earlier current assertion for the same patient concept when the statement clearly refers to that earlier use.

Historical context is excluded from ordinary active-pair matching unless an evidence record explicitly contains a post-discontinuation relevance window and that rule has been encoded and physician-approved.

### 15.3 Negation

Examples:

- “I do not take carbamazepine.”
- “She has never used Tegretol.”
- “Carbamazepine is not on her medication list.”

Create a `NEGATED_USE_OF` assertion. Do not trigger an evidence match.

A later affirmative statement may supersede the negation if clearly current.

### 15.4 Planned prescription

Examples:

- “I am considering starting lamotrigine.”
- a doctor enters `Lamotrigine` in the proposed-prescription UI;
- “We will start carbamazepine next week.”

Create a `PLANS_TO_TAKE` assertion or `PrescriptionProposal` node.

Planned medication may be checked against a current hormonal product, but the UI must label the result:

> Potentially relevant evidence for the proposed medication combination.

Do not represent the planned medication as already active.

### 15.5 Other person

Examples:

- “My sister takes carbamazepine.”
- “Her partner uses lamotrigine.”

Attribute the mention to `other_person`. It must not contribute to the patient medication pair.

### 15.6 Doctor discussion without prescription

Example:

- “The doctor explained what carbamazepine is.”

A medication mentioned by the doctor is not automatically a patient medication or planned prescription. Mark as uncertain/discussion unless an explicit prescription proposal is present.

### 15.7 Ambiguous hormonal context

Examples:

- “I use the pill.”
- “She uses contraception.”

If the evidence dataset requires distinguishing combined from progestogen-only contraception, do not guess.

Return `MORE_INFORMATION_REQUIRED` with a specific missing field.

### 15.8 Corrections

Examples:

- “I take carbamazepine.”
- “Sorry, I meant lamotrigine.”

The new turn should:

- add lamotrigine;
- supersede the carbamazepine assertion when the correction target is clear;
- recompute the evidence match;
- retract any warning tied only to carbamazepine;
- preserve the original event and correction provenance.

### 15.9 Contradictory unresolved statements

If the graph contains two active contradictory assertions and the latest turn does not clearly resolve them, mark the concept status `uncertain` and return `MORE_INFORMATION_REQUIRED` rather than selecting one silently.

---

## 16. Validation architecture

“Validation” in this project has several distinct meanings. They must not be conflated.

### 16.1 Evidence validation

Performed before runtime by the researcher and physician.

A record is runtime-eligible only when:

- `physicianVerified` is true;
- no `[VERIFY]` marker remains;
- the source URL is present;
- the source organization is present;
- the source section is specific enough to locate the claim;
- interaction direction is explicit;
- the consequence is supported by the source;
- limitations are documented;
- jurisdiction is present;
- class membership is explicit for class-based matching;
- verification date is present;
- the record passes schema validation.

A record that says “exact wording to be confirmed” is not fully validated. Either resolve the issue or mark the record non-triggering.

### 16.2 Transcript event validation

Validate:

- required event IDs;
- non-empty final transcript;
- valid speaker enum;
- sequence/timestamp format;
- duplicate provider item IDs;
- session state;
- schema version.

### 16.3 Extraction validation

Validate:

- allowed categories;
- allowed status values;
- allowed subject values;
- transcript span bounds;
- normalized candidate type;
- no prohibited medical fields;
- correction target validity.

### 16.4 Graph consistency validation

Required invariants:

1. Every active assertion must have a source transcript turn or explicit UI event.
2. Every mention must link to one normalized concept or be explicitly unknown.
3. Every warning must link to active trigger assertions.
4. Every warning must link to one or more physician-verified evidence records.
5. No unverified evidence record may trigger a warning.
6. Negated and historical assertions are not eligible as current active medications.
7. Other-person assertions do not enter the patient pair set.
8. A superseded assertion cannot remain active.
9. A retracted warning cannot remain displayed as active.
10. Every displayed medical consequence must be copied from the matched evidence record.
11. Every displayed source must belong to the matched evidence record.
12. The model cannot add an evidence edge.

### 16.5 Pair eligibility validation

An evidence lookup pair is eligible when:

- there is an active patient hormonal-product assertion;
- there is an active or explicitly proposed patient medication assertion;
- both concepts are normalized to approved concept IDs;
- neither assertion is negated;
- neither assertion is unresolved/uncertain;
- the graph state is internally consistent.

### 16.6 Evidence-match validation

A valid match requires:

```text
normalized hormonal concept
    +
normalized other medication concept
    +
verified pair index entry
    -> evidence record ID
```

No semantic vector similarity, model opinion, or free-text reasoning may substitute for the indexed match.

### 16.7 Prescription validation versus evidence matching

The system does not validate that the prescription is clinically correct.

It validates only that:

- the proposed medication was represented correctly;
- the graph contains sufficient current context;
- a deterministic evidence record matches;
- the displayed warning is traceable to verified evidence.

The user-facing phrase should be:

> Evidence relevant to this proposed combination was found.

Not:

> This prescription is invalid.

---

## 17. Result state machine

Use explicit states.

```text
LISTENING
PROCESSING
MORE_INFORMATION_REQUIRED
EVIDENCE_FOUND
NO_VALIDATED_MATCH
EXCLUDED_CONTEXT
RETRACTED
PROCESSING_ERROR
```

### 17.1 `MORE_INFORMATION_REQUIRED`

Use when:

- hormonal method is unclear;
- medication identity is unclear;
- patient attribution is unclear;
- contradictory statements remain unresolved;
- a concept cannot be normalized;
- current versus historical status is unclear.

### 17.2 `EVIDENCE_FOUND`

Use only when all eligibility and evidence-match validation passes.

Display:

- matched hormonal product;
- matched medication;
- current or proposed context;
- interaction direction;
- potential consequence;
- evidence level/type;
- source title;
- source organization;
- source section;
- jurisdiction;
- verification date;
- limitations;
- record ID;
- research disclaimer.

All medical content must come from the record.

### 17.3 `NO_VALIDATED_MATCH`

Use when the medication context is clear but there is no matching record in the prototype evidence dataset.

Required copy:

> No matching record was found in the current prototype evidence dataset. This does not establish that no interaction exists.

### 17.4 `EXCLUDED_CONTEXT`

Use when a relevant-sounding mention is excluded because it is:

- negated;
- historical;
- assigned to another person;
- merely discussed;
- cancelled as a proposed prescription.

### 17.5 `RETRACTED`

Use when a previously displayed evidence warning becomes invalid after new context.

Display:

- that the prior warning was retracted;
- the new context causing retraction;
- the timestamp;
- the source transcript turn;
- the current result state.

Do not simply make the warning disappear without explanation.

---

## 18. Warning lifecycle requirements

A warning is a derived graph object, not a raw model output.

### 18.1 Warning creation

Create only when:

- a valid active/planned pair exists;
- a verified evidence record matches;
- graph validation passes;
- the warning is not already active for the same assertion pair and evidence record.

### 18.2 Warning update

Update when:

- a duplicate synonym confirms the same medication;
- new context changes the label from proposed to active;
- a better transcript turn provides clearer provenance;
- an additional evidence record matches.

### 18.3 Warning retraction

Retract when:

- a medication is negated;
- a medication is corrected to a different concept;
- current use becomes historical;
- patient attribution changes to another person;
- a proposal is cancelled;
- the hormonal method becomes ambiguous;
- the underlying evidence record becomes ineligible after a dataset reload.

### 18.4 Premature warning prevention

Do not warn from:

- partial transcript deltas;
- unnormalized concepts;
- ambiguous “the pill” references;
- doctor discussion alone;
- historical or negated mentions;
- another person’s medication;
- model-generated interaction knowledge.

### 18.5 Warning provenance

Every warning must expose an inspectable provenance chain:

```text
Warning WARN-003
  -> Evidence record INT-001
  -> Trigger assertion A-014: patient currently uses combined hormonal contraceptive
  -> Source turn TURN-007: “I use the combined pill.”
  -> Trigger assertion A-009: patient currently takes carbamazepine
  -> Source turn TURN-004: “I take Tegretol.”
```

---

## 19. Python backend requirements

### 19.1 Framework

Use FastAPI with:

- HTTP health endpoint;
- session/token endpoint for realtime audio authentication;
- WebSocket endpoint for encounter updates;
- REST endpoints for text fallback and benchmark runs;
- Pydantic request/response models;
- clear dependency injection for extractor and transcription adapters.

### 19.2 Required services

```text
AudioSessionService
TranscriptEventRouter
MedicationContextExtractor
DeterministicDemoExtractor
ConceptNormalizer
EncounterEventStore
EncounterGraphReducer
GraphValidator
EvidenceIndex
WarningEngine
AuditLogger
BenchmarkRunner
```

### 19.3 Runtime modes

#### Demo mode

- no API key required for extraction;
- deterministic recognized scripts;
- prerecorded audio or cached transcript events;
- guaranteed positive, negation, and correction scenarios;
- evidence matching remains real and deterministic.

#### Live mode

- realtime speech-to-text;
- structured-output extraction;
- environment-based model selection;
- standard API key only on server;
- real latency tracking;
- safe failure behavior.

#### Text fallback mode

- typed consultation text;
- same extraction, graph, matching, and warning pipeline;
- useful when microphone or network fails.

### 19.4 State storage

For the MVP:

```python
encounters: dict[str, EncounterRuntime]
```

Each `EncounterRuntime` contains:

- event log;
- current graph snapshot;
- current result;
- active warnings;
- latency measurements;
- session metadata.

Do not persist real patient data by default.

### 19.5 Concurrency

Use per-encounter locking or serialized processing to prevent two finalized turns from updating the same graph concurrently in the wrong order.

### 19.6 Idempotency

Processing the same final transcript event twice must not duplicate assertions or warnings.

---

## 20. Suggested Pydantic model skeleton

```python
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class Speaker(StrEnum):
    DOCTOR = "doctor"
    PATIENT = "patient"
    OTHER_PERSON = "other_person"
    UNKNOWN = "unknown"


class MentionStatus(StrEnum):
    CURRENT = "current"
    HISTORICAL = "historical"
    PLANNED = "planned"
    NEGATED = "negated"
    UNCERTAIN = "uncertain"


class ResultState(StrEnum):
    LISTENING = "LISTENING"
    PROCESSING = "PROCESSING"
    EVIDENCE_FOUND = "EVIDENCE_FOUND"
    NO_VALIDATED_MATCH = "NO_VALIDATED_MATCH"
    MORE_INFORMATION_REQUIRED = "MORE_INFORMATION_REQUIRED"
    EXCLUDED_CONTEXT = "EXCLUDED_CONTEXT"
    RETRACTED = "RETRACTED"
    PROCESSING_ERROR = "PROCESSING_ERROR"


class TranscriptEvent(BaseModel):
    event_id: str
    encounter_id: str
    provider_item_id: str | None = None
    sequence: int
    speaker: Speaker
    text: str
    is_final: bool
    received_at: datetime
    started_at_ms: int | None = None
    ended_at_ms: int | None = None


class ExtractedMention(BaseModel):
    mention_id: str
    surface_text: str
    normalized_candidate: str | None = None
    category: Literal["hormonal_product", "other_medication"]
    status: MentionStatus
    subject: Speaker
    certainty: Literal["explicit", "inferred", "uncertain"]
    source_turn_id: str
    span_start: int | None = None
    span_end: int | None = None


class GraphAssertion(BaseModel):
    assertion_id: str
    subject: Speaker
    predicate: Literal[
        "CURRENTLY_USES",
        "CURRENTLY_TAKES",
        "HISTORICALLY_USED",
        "PLANS_TO_TAKE",
        "NEGATED_USE_OF",
    ]
    concept_id: str
    source_turn_id: str
    is_active: bool = True
    valid_from: datetime
    valid_to: datetime | None = None
    supersedes_assertion_id: str | None = None


class WarningRecord(BaseModel):
    warning_id: str
    state: Literal["active", "updated", "retracted"]
    evidence_record_id: str
    trigger_assertion_ids: list[str]
    created_at: datetime
    updated_at: datetime
    retracted_at: datetime | None = None
    retraction_reason: str | None = None


class EncounterSnapshot(BaseModel):
    encounter_id: str
    assertions: list[GraphAssertion] = Field(default_factory=list)
    warnings: list[WarningRecord] = Field(default_factory=list)
    result_state: ResultState
    missing_information: list[str] = Field(default_factory=list)
```

This is a starting contract, not a mandate to copy without review.

---

## 21. API contract requirements

### 21.1 Mint realtime client credentials

```http
POST /api/realtime/session
```

Response contains temporary client session credentials only. Never return the server’s standard API key.

### 21.2 Create encounter

```http
POST /api/encounters
```

Response:

```json
{
  "encounter_id": "enc-123",
  "status": "created",
  "synthetic_demo": true
}
```

### 21.3 Encounter WebSocket

```text
/ws/encounters/{encounter_id}
```

Client events:

```text
transcript.partial
transcript.final
speaker.changed
prescription.proposed
prescription.cancelled
encounter.reset
session.stop
```

Server events:

```text
caption.updated
graph.updated
result.updated
warning.created
warning.updated
warning.retracted
processing.error
```

### 21.4 Final transcript client event

```json
{
  "type": "transcript.final",
  "event_id": "evt-017",
  "provider_item_id": "item_003",
  "sequence": 17,
  "speaker": "patient",
  "text": "I currently use the combined pill.",
  "started_at_ms": 61500,
  "ended_at_ms": 63800
}
```

### 21.5 Proposed prescription event

```json
{
  "type": "prescription.proposed",
  "event_id": "evt-018",
  "sequence": 18,
  "speaker": "doctor",
  "medication_surface_text": "Lamotrigine",
  "normalized_candidate": "Lamotrigine"
}
```

### 21.6 Graph update server event

```json
{
  "type": "graph.updated",
  "encounter_id": "enc-123",
  "version": 12,
  "active_assertions": [
    {
      "assertion_id": "a-1",
      "subject": "patient",
      "predicate": "CURRENTLY_USES",
      "concept_id": "estrogen_containing_oral_contraceptive",
      "source_turn_id": "turn-9"
    },
    {
      "assertion_id": "a-2",
      "subject": "patient",
      "predicate": "PLANS_TO_TAKE",
      "concept_id": "lamotrigine",
      "source_turn_id": "ui-proposal-1"
    }
  ]
}
```

### 21.7 Warning event

```json
{
  "type": "warning.created",
  "warning": {
    "warning_id": "warn-5",
    "state": "active",
    "display_label": "Potentially relevant evidence found",
    "context": "proposed_combination",
    "evidence_record_id": "INT-005",
    "trigger_assertion_ids": ["a-1", "a-2"]
  }
}
```

The frontend retrieves all medical wording from the evidence record payload or an evidence endpoint, never from a free-form model string.

---

## 22. Evidence dataset requirements

The existing six records are the starting point, but the researcher-developer must audit and normalize them before using them for runtime warnings.

### 22.1 Required schema additions

Recommended fields:

```json
{
  "id": "INT-001",
  "status": "verified",
  "matchType": "specific_pair",
  "hormonalConceptId": "combined_hormonal_contraceptive",
  "hormonalProduct": "Combined hormonal contraceptive",
  "hormonalSynonyms": [],
  "interactingConceptId": "carbamazepine",
  "interactingMedication": "Carbamazepine",
  "medicationSynonyms": [],
  "includedMedicationConcepts": [],
  "interactionDirectionCode": "MEDICATION_AFFECTS_CONTRACEPTIVE",
  "interactionDirection": "...",
  "potentialConsequence": "...",
  "evidenceLevel": "...",
  "population": "...",
  "jurisdiction": "United States",
  "sources": [],
  "lastVerified": "2026-07-18",
  "physicianVerified": true,
  "runtimeEligible": true,
  "limitations": "..."
}
```

### 22.2 Runtime eligibility

Calculate or validate `runtimeEligible` rather than trusting it blindly.

```python
runtime_eligible = all([
    record.physicianVerified,
    not contains_verify_marker(record),
    has_complete_source(record),
    has_explicit_match_members(record),
    has_valid_direction(record),
])
```

### 22.3 Important issues in the supplied examples

The researcher-developer must specifically examine:

1. Records whose limitations still state that exact wording or category must be confirmed.
2. Broad “hepatic enzyme-inducing medication” records with example lists rather than explicit membership.
3. Multi-medication records such as “rifampicin or rifabutin.”
4. The reversed interaction direction in the lamotrigine record.
5. Temporal relevance after stopping an enzyme inducer where the source describes a continuing period.
6. Whether directive clinical management wording should remain excluded from the visible card.
7. Whether source URLs point to the exact current document rather than a general landing page.

### 22.4 Direction codes

Use machine-readable codes:

```text
MEDICATION_AFFECTS_CONTRACEPTIVE
CONTRACEPTIVE_AFFECTS_MEDICATION
BIDIRECTIONAL_OR_COMPLEX
```

The lamotrigine record must not be treated as if lamotrigine reduces contraceptive efficacy when the verified claim is the reverse direction.

---

## 23. Evidence-index construction

At startup:

1. Load JSON.
2. Validate schema.
3. exclude non-eligible records.
4. Build concept aliases.
5. Build explicit class membership.
6. Build pair keys.
7. Run duplicate and collision checks.
8. fail startup in strict mode when verified records contain ambiguous machine matching.

Example pair index:

```python
pair_index = {
    ("combined_hormonal_contraceptive", "carbamazepine"): ["INT-001"],
    ("combined_hormonal_contraceptive", "rifampicin"): ["INT-002"],
    ("combined_hormonal_contraceptive", "rifabutin"): ["INT-002"],
    ("estrogen_containing_oral_contraceptive", "lamotrigine"): ["INT-005"],
}
```

Class records expand into explicit pair keys only for physician-approved members.

---

## 24. Frontend requirements

Rename `Analyze Case` to `Live Consultation`, while retaining text case analysis as a fallback tab.

### 24.1 Live consultation layout

Recommended four-panel layout:

1. **Session control and microphone status**
2. **Live transcript**
3. **Encounter graph / structured state**
4. **Evidence result and warning history**

### 24.2 Live transcript

- provisional partial transcript in lighter styling;
- finalized transcript as stable turns;
- speaker label on every turn;
- timestamps optional but useful;
- source turn can be highlighted from a graph assertion or warning.

### 24.3 Graph display

The visual graph need not use a full graph visualization library. A structured node-and-edge panel is acceptable.

Example:

```text
PATIENT
  CURRENTLY USES -> Combined hormonal contraceptive
      Source: Turn 7
  CURRENTLY TAKES -> Carbamazepine
      Source: Turn 4

MATCH
  INT-001

WARNING
  Potentially relevant evidence found
```

The UI should also show inactive/retracted assertions in an audit drawer.

### 24.4 Evidence warning card

Must include:

- cautious title;
- current versus proposed context;
- matched pair;
- consequence from JSON;
- interaction direction;
- evidence type;
- source and section;
- jurisdiction;
- verification date;
- limitations;
- physician verification badge;
- record ID;
- disclaimer.

### 24.5 Retraction presentation

When a warning is retracted:

- move it to warning history;
- visibly label it `Retracted`;
- show why;
- show the correcting turn;
- show the new state.

### 24.6 No-match presentation

Never use a green success card. Use neutral styling and the required no-match disclaimer.

---

## 25. Research benchmark design

Create three benchmark layers.

### 25.1 Layer A: text context benchmark

18-30 standalone synthetic snippets covering:

- clear positives;
- synonym positives;
- true negatives;
- explicit negation;
- historical use;
- planned prescription;
- another person;
- ambiguous hormonal method;
- uncertain medication;
- misspellings;
- reversed interaction direction;
- no record in the dataset.

### 25.2 Layer B: streaming state benchmark

Each case is a sequence of finalized turns with an expected state after every turn.

Example:

```json
{
  "id": "STREAM-001",
  "events": [
    {
      "sequence": 1,
      "speaker": "patient",
      "text": "I take carbamazepine.",
      "expectedResultState": "MORE_INFORMATION_REQUIRED"
    },
    {
      "sequence": 2,
      "speaker": "patient",
      "text": "I also use the combined pill.",
      "expectedResultState": "EVIDENCE_FOUND",
      "expectedEvidenceRecordId": "INT-001"
    }
  ]
}
```

Required sequence patterns:

- context completed over multiple turns;
- early ambiguity resolved later;
- positive match later negated;
- positive match later historicized;
- wrong medication corrected;
- another-person attribution clarified;
- proposed prescription added;
- proposed prescription cancelled;
- late/out-of-order transcript event;
- duplicate event replay.

### 25.3 Layer C: audio benchmark

Use synthetic spoken recordings generated or recorded by the team. Do not use real patient audio.

Include:

- quiet room;
- moderate background noise;
- different speaking rates;
- medication brand names;
- generic names;
- spelling clarification;
- interruption;
- correction;
- negation;
- accents represented by consenting team members or synthetic voices.

Gold labels should include:

- reference transcript;
- medication entities;
- hormonal entities;
- speaker;
- context status;
- expected graph assertions;
- expected state after each final turn;
- expected evidence record;
- expected warning lifecycle.

---

## 26. Metrics

### 26.1 Transcription metrics

- medication entity recall;
- hormonal-product entity recall;
- medication substitution error count;
- negation preservation accuracy;
- temporal phrase preservation accuracy;
- clinically important transcript error count;
- optional word error rate.

General word error rate alone is insufficient because a single wrong medication name matters more than several filler-word errors.

### 26.2 Extraction metrics

- entity precision;
- entity recall;
- normalization accuracy;
- status classification accuracy;
- subject attribution accuracy;
- correction-target accuracy;
- structured-output schema success rate.

### 26.3 Graph metrics

- assertion precision;
- assertion recall;
- active-state accuracy after each turn;
- contradiction handling accuracy;
- supersession accuracy;
- graph provenance completeness;
- graph invariant violation count.

### 26.4 Retrieval metrics

- trigger precision;
- trigger recall;
- trigger F1;
- evidence-record retrieval accuracy;
- correct abstention rate;
- no-match accuracy;
- citation coverage;
- unsupported-claim count.

### 26.5 Real-time safety metrics

- premature-warning count;
- missed-warning count;
- warning retraction accuracy;
- warning retraction latency;
- duplicate-warning count;
- stale-warning duration;
- result accuracy after every event;
- final-state accuracy.

### 26.6 Latency metrics

Measure:

```text
speech end -> final transcript
final transcript -> extraction complete
extraction complete -> graph update
Graph update -> evidence match
final transcript -> UI result
correction final transcript -> warning retracted
```

Report median, p90, and maximum when enough runs exist. With very few samples, report individual runs rather than misleading aggregate statistics.

---

## 27. Automated test requirements

### 27.1 Evidence tests

- schema validation;
- all runtime records are physician verified;
- no `[VERIFY]` text in runtime-eligible records;
- source completeness;
- valid URLs syntactically;
- explicit class membership;
- no synonym collisions;
- reversed direction preserved for lamotrigine;
- source-linked card contains no fields absent from JSON.

### 27.2 Normalization tests

- combined pill;
- COC;
- Tegretol;
- Lamictal;
- Nexplanon;
- rifampin versus rifampicin;
- unknown medication remains unknown;
- misspelling behavior is documented and deterministic.

### 27.3 Context tests

- current use;
- historical use;
- negation;
- planned use;
- other-person mention;
- doctor discussion;
- ambiguous pill;
- contradictory statements;
- correction.

### 27.4 Graph tests

- all assertions have provenance;
- superseded assertion becomes inactive;
- correction creates new assertion;
- no warning links to inactive assertion;
- encounter reset removes active state;
- event replay is idempotent;
- out-of-order event recomputation works;
- per-encounter isolation.

### 27.5 Warning tests

- positive match creates warning;
- negated context creates no warning;
- historical context creates no active warning;
- proposed prescription creates proposed-context warning;
- correction retracts warning;
- no record returns neutral no-match state;
- ambiguous context abstains;
- no warning displays unsupported text;
- citation coverage is complete.

### 27.6 Realtime tests

- microphone permission denied;
- transcription connection failure;
- reconnect;
- duplicate final event;
- partial deltas do not trigger graph changes;
- stop listening stops processing;
- manual turn finalization;
- frontend reconnect receives current graph snapshot.

### 27.7 Frontend tests

- all controls work;
- recording indicator is visible;
- speaker selection is visible;
- mobile layout remains usable;
- warning provenance drawer opens;
- retracted warning history renders;
- benchmark metrics match result JSON;
- no green safe state exists.

---

## 28. Privacy, consent, and data handling

For the hackathon demonstration:

- use synthetic conversations only;
- do not speak real patient names;
- do not upload real consultation recordings;
- do not persist raw audio by default;
- do not persist encounter state after reset/server restart unless explicitly exporting a synthetic case;
- mark the microphone state clearly;
- provide an immediate stop control;
- keep API secrets server-side;
- log technical metadata without identifying information;
- avoid analytics services that receive transcript content.

The documentation must state that real-world deployment would require a separate assessment of:

- informed consent;
- medical confidentiality;
- data protection;
- retention policies;
- processor agreements;
- access control;
- audit access;
- medical-device classification;
- clinical governance;
- cybersecurity;
- incident response.

Do not claim these deployment requirements are solved by the MVP.

---

## 29. Audit log requirements

The system should be able to export a synthetic session audit JSON containing:

- session metadata;
- final transcript turns;
- speaker labels;
- extracted mentions;
- normalization results;
- graph assertions;
- supersession/retraction events;
- evidence lookups;
- warning lifecycle;
- processing errors;
- latency measurements;
- schema and model versions.

Do not include raw audio in the default audit export.

The audit log should enable a reviewer to answer:

1. What was heard?
2. Which finalized turn was analyzed?
3. What entities were extracted?
4. What graph state was created?
5. Which assertion was active at warning time?
6. Which evidence record matched?
7. Why was a warning later changed or retracted?
8. What model and schema version were used?

---

## 30. Repository structure

```text
/
|-- frontend/
|   |-- src/
|   |   |-- components/
|   |   |-- pages/
|   |   |-- services/
|   |   `-- data/
|   `-- ... existing Lovable application
|
|-- backend/
|   |-- app/
|   |   |-- main.py
|   |   |-- config.py
|   |   |-- models.py
|   |   |-- realtime_session.py
|   |   |-- transcript_router.py
|   |   |-- extractor.py
|   |   |-- deterministic_extractor.py
|   |   |-- normalizer.py
|   |   |-- event_store.py
|   |   |-- graph_builder.py
|   |   |-- graph_reducer.py
|   |   |-- graph_validator.py
|   |   |-- evidence_index.py
|   |   |-- warning_engine.py
|   |   |-- audit.py
|   |   `-- benchmark.py
|   |-- data/
|   |   |-- evidence_records.json
|   |   |-- synonym_index.json
|   |   |-- demo_cases.json
|   |   |-- benchmark_cases.json
|   |   |-- streaming_benchmark_cases.json
|   |   |-- audio_benchmark_manifest.json
|   |   `-- benchmark_results.json
|   |-- tests/
|   |   |-- test_evidence.py
|   |   |-- test_normalization.py
|   |   |-- test_context.py
|   |   |-- test_graph.py
|   |   |-- test_warning_lifecycle.py
|   |   |-- test_realtime_events.py
|   |   `-- test_api.py
|   `-- requirements.txt
|
|-- docs/
|   |-- DATASET_CARD.md
|   |-- BENCHMARK_CARD.md
|   |-- AUDIO_BENCHMARK_CARD.md
|   |-- LABELING_GUIDE.md
|   |-- GRAPH_SCHEMA.md
|   |-- REALTIME_ARCHITECTURE.md
|   |-- EVALUATION.md
|   |-- SAFETY.md
|   |-- PRIVACY.md
|   |-- LIMITATIONS.md
|   `-- DEMO_GUIDE.md
|
|-- README.md
|-- MORNING_REVIEW.md
|-- .env.example
`-- LICENSE
```

If the existing repository cannot be safely reorganized into `frontend/` and `backend/`, keep the existing frontend at root and place only Python under `/backend`. Do not break a working Lovable deployment merely to match the suggested tree.

---

## 31. Required environment variables

```text
APP_ENV=development
DEMO_MODE=true
OPENAI_API_KEY=
TRANSCRIPTION_MODEL=gpt-realtime-whisper
EXTRACTION_MODEL=
TRANSCRIPTION_LANGUAGE=en
EVIDENCE_PATH=backend/data/evidence_records.json
STORE_RAW_AUDIO=false
STORE_TRANSCRIPTS=false
STRICT_EVIDENCE_VALIDATION=true
LOG_LEVEL=INFO
```

Model names must be configurable because available models and recommendations can change.

---

## 32. Researcher-developer task list

The researcher-developer owns both scientific rigor and the Python implementation boundary.

### Phase 1: Evidence audit

1. Validate the six records against the cited official sources.
2. Replace general landing-page URLs with exact source documents where possible.
3. Resolve all “confirm” language.
4. mark unresolved records `runtimeEligible: false`.
5. Create explicit concept IDs.
6. Create explicit closed class member lists.
7. Validate interaction direction.
8. Validate source jurisdiction.
9. Confirm that visible consequence wording is source-supported.
10. Preserve limitations.
11. Produce `SOURCE_REGISTER.md` or structured source registry.

### Phase 2: Ontology and synonym design

1. Define canonical concept IDs.
2. Create approved synonyms.
3. Separate brands from generic names.
4. prevent synonym collisions.
5. Define explicit class membership.
6. document unknown-name behavior.
7. Create normalization tests.

### Phase 3: Labeling guide

Define annotation rules for:

- status;
- subject;
- certainty;
- correction;
- planned prescription;
- ambiguous hormonal method;
- discussion versus active use;
- source transcript spans;
- expected graph assertions;
- warning lifecycle.

### Phase 4: Python event and graph engine

1. Implement Pydantic models.
2. Implement event store.
3. Implement graph reducer.
4. Implement supersession rules.
5. Implement graph validator.
6. Implement pair eligibility.
7. Implement evidence index.
8. Implement warning reconciliation.
9. Implement audit export.
10. Implement tests before live audio integration.

### Phase 5: Realtime audio integration

1. Implement backend token/session endpoint.
2. Integrate browser microphone and realtime transcription.
3. Render partial captions.
4. route final turns only to Python.
5. preserve provider item IDs.
6. implement speaker selector.
7. implement stop/reset/reconnect.
8. measure latency.
9. retain prerecorded and text fallbacks.

### Phase 6: Structured live extraction

1. Define Pydantic structured output schema.
2. Implement live extractor adapter.
3. prohibit medical fields.
4. validate all responses.
5. add deterministic fallback.
6. log extraction model/version.
7. test medication vocabulary.

### Phase 7: Benchmark and documentation

1. Create text benchmark.
2. create streaming benchmark.
3. create synthetic audio benchmark.
4. freeze gold labels.
5. run end-to-end benchmark.
6. report real results.
7. classify errors.
8. write dataset, graph, audio, evaluation, safety, and limitations cards.

---

## 33. Implementation sequence and hard checkpoints

### Checkpoint 1: Evidence and deterministic text slice

Must work before audio:

```text
Typed text
-> deterministic extraction
-> graph
-> evidence match
-> warning
-> correction
-> retraction
```

Required cases:

- positive;
- negated;
- ambiguous;
- correction after positive.

### Checkpoint 2: Live captions

Must work:

- microphone starts;
- partial text appears;
- final turn appears;
- final turn has speaker and event ID;
- partial text does not affect graph.

### Checkpoint 3: End-to-end real-time graph

Must work:

- final patient turn creates medication assertion;
- second turn completes pair;
- warning appears;
- correction turn retracts warning;
- provenance is visible.

### Checkpoint 4: Proposed prescription

Must work:

- current hormonal product exists;
- doctor adds proposed medication;
- graph adds planned node/assertion;
- verified match appears;
- cancellation retracts the proposed warning.

### Checkpoint 5: Benchmark

Must work:

- benchmark runner is reproducible;
- metrics are written to JSON;
- UI metrics match JSON;
- warning lifecycle metrics are included;
- unsupported-claim count is zero.

---

## 34. MVP acceptance criteria

The project is ready for demonstration only when all of the following pass.

### Evidence

- [ ] All runtime records are physician verified.
- [ ] No runtime record contains unresolved `[VERIFY]` or “to be confirmed” language.
- [ ] Class records have explicit closed members.
- [ ] Every warning record has exact source provenance.

### Real-time audio

- [ ] Listening begins only after explicit action.
- [ ] Live partial captions appear.
- [ ] Finalized turns are distinguishable.
- [ ] Only finalized turns update the graph.
- [ ] Speaker metadata is attached.
- [ ] Stop listening actually stops capture.
- [ ] A text/prerecorded fallback works.

### Graph

- [ ] Every active assertion has transcript/UI provenance.
- [ ] Current, historical, planned, negated, and uncertain are distinct.
- [ ] Patient and other-person mentions are distinct.
- [ ] Corrections supersede earlier assertions.
- [ ] The graph recomputes after every relevant finalized turn.
- [ ] Proposed prescriptions are represented as planned, not current.

### Warnings

- [ ] A warning is generated only by deterministic verified matching.
- [ ] No warning is generated from partial transcript text.
- [ ] Negation does not trigger a warning.
- [ ] Historical use does not trigger an active warning unless explicitly encoded by a verified temporal rule.
- [ ] Another person’s medication does not trigger a patient warning.
- [ ] Ambiguous context abstains.
- [ ] Correction retracts stale warning.
- [ ] Retraction is visible and explainable.
- [ ] No “safe” state is shown.

### Research quality

- [ ] Text, streaming, and audio benchmarks exist.
- [ ] Gold labels are frozen before final evaluation.
- [ ] Real metrics are reported.
- [ ] Citation coverage is 100% for evidence warnings.
- [ ] Unsupported-claim count is zero.
- [ ] Limitations are prominent.

---

## 35. Exact demo scenarios

### Demo 1: incremental positive match

**Doctor:** “Are you currently taking any regular medication?”  
**Patient:** “Yes, I take Tegretol.”  
Expected graph: patient currently takes carbamazepine.  
Expected state: `MORE_INFORMATION_REQUIRED`.

**Doctor:** “Are you using hormonal contraception?”  
**Patient:** “Yes, I use the combined pill.”  
Expected graph: patient currently uses combined hormonal contraceptive.  
Expected state: `EVIDENCE_FOUND`.  
Expected record: `INT-001`.

### Demo 2: correction and retraction

Continue from Demo 1.

**Patient:** “Sorry, I stopped Tegretol last year.”  
Expected graph: carbamazepine becomes historical; current assertion inactive.  
Expected state: `RETRACTED` or `EXCLUDED_CONTEXT`.  
Expected UI: earlier warning shown as retracted with the correction turn.

### Demo 3: proposed prescription

**Patient:** “I take lamotrigine and use an estrogen-containing pill.”  
Alternative flow: hormonal product is already current and doctor proposes lamotrigine through UI.  
Expected graph: current hormonal product plus current/planned lamotrigine.  
Expected state: `EVIDENCE_FOUND`.  
Expected record: `INT-005`.  
Expected direction: hormonal contraceptive may reduce lamotrigine exposure, not the reverse.

### Demo 4: ambiguous hormonal method

**Patient:** “I take carbamazepine and use the pill.”  
Expected state: `MORE_INFORMATION_REQUIRED`.  
Expected missing field: exact hormonal method.

### Demo 5: another person

**Patient:** “My sister takes carbamazepine. I use the combined pill.”  
Expected state: no patient evidence warning; carbamazepine assertion belongs to another person.

---

## 36. Failure behavior

### Transcription unavailable

- show connection error;
- retain text input;
- offer prerecorded demo;
- do not fabricate transcript.

### Extraction unavailable

- retain final transcript;
- show processing error;
- allow deterministic fallback for known demo vocabulary;
- do not infer interaction directly.

### Evidence file invalid

In strict mode:

- fail backend startup;
- list schema errors;
- do not expose partially validated medical records.

In development mode:

- load only eligible records;
- clearly report excluded records;
- never allow excluded records to warn.

### Frontend WebSocket disconnected

- reconnect with backoff;
- request current encounter snapshot;
- avoid resending duplicate transcript events;
- preserve local final-turn queue until acknowledged.

### Conflicting graph state

- mark uncertain;
- abstain;
- show what information conflicts;
- do not select a medication state silently.

---

## 37. Documentation deliverables

### `README.md`

- problem;
- solution;
- architecture;
- startup;
- live demo;
- benchmark command;
- safety posture;
- limitations;
- license.

### `docs/REALTIME_ARCHITECTURE.md`

- audio path;
- credentials;
- partial/final events;
- event ordering;
- speaker metadata;
- latency;
- fallback behavior.

### `docs/GRAPH_SCHEMA.md`

- node types;
- edge types;
- invariants;
- event-sourcing model;
- correction rules;
- examples.

### `docs/LABELING_GUIDE.md`

- statuses;
- subjects;
- corrections;
- ambiguous context;
- planned prescriptions;
- gold label examples.

### `docs/EVALUATION.md`

- datasets;
- benchmark splits;
- metrics;
- commands;
- results;
- error analysis.

### `docs/SAFETY.md`

- prohibited behavior;
- evidence-only medical content;
- warning gates;
- no safe state;
- retractions;
- human oversight.

### `docs/PRIVACY.md`

- synthetic demo only;
- no raw audio retention;
- no patient identifiers;
- future deployment questions.

### `docs/LIMITATIONS.md`

- six-record coverage;
- synthetic benchmark;
- transcription errors;
- speaker-label dependency;
- no clinical validation;
- no full medication reconciliation;
- no autonomous recommendation;
- no persistent patient graph.

---

## 38. Non-goals for the MVP

Do not implement:

- a comprehensive interaction database;
- model-generated medical evidence;
- dose checking;
- autonomous prescribing;
- diagnosis;
- treatment ranking;
- full EHR integration;
- real patient recording;
- permanent patient graph;
- automatic speaker identification as a required dependency;
- clinician authentication and multi-tenant deployment;
- Neo4j unless all core requirements are already complete;
- vector search as the medical decision path;
- fine-tuning;
- broad menopause, HRT, pregnancy, or menstrual-cycle modeling.

---

## 39. Future extension path

After the MVP, the architecture can be extended to:

- persistent, consented longitudinal medication graphs;
- FHIR medication and medication-request resources;
- EHR reconciliation;
- HRT and menopause-related evidence;
- pregnancy/postpartum context;
- laboratory and symptom nodes;
- automatic speaker diarization;
- multilingual transcription;
- additional evidence jurisdictions;
- evidence versioning and automated source-change monitoring;
- clinician acknowledgment and override audit;
- formal prospective validation.

These are future research directions, not hackathon claims.

---

## 40. Instructions for the coding agent

Use the following operational rules while implementing this specification:

1. Audit the repository before changing architecture.
2. Preserve the existing visual design where possible.
3. Implement the smallest working vertical slice first.
4. Do not write medical content outside the evidence file.
5. Do not hard-code model credentials.
6. Do not process partial transcript deltas medically.
7. Use an append-only event log and derived graph snapshot.
8. Make all graph assertions provenance-linked.
9. Use deterministic pair lookup.
10. Implement warning retraction before polishing the UI.
11. Treat proposed prescriptions as planned assertions.
12. Validate every extraction response.
13. Fail safely on ambiguous or inconsistent context.
14. Keep demo, live, and text fallback modes.
15. Do not claim a test passed unless it was run.
16. Do not modify gold labels to improve benchmark results.
17. Do not mark evidence runtime-eligible while verification language remains unresolved.
18. Produce `MORNING_REVIEW.md` with exact commands, metrics, failures, and demo sequence.

---

## 41. Definition of done

The task is complete when a reviewer can perform the following sequence:

1. Open the Live Consultation page.
2. Start listening with visible consent and microphone status.
3. Speak a synthetic doctor-patient conversation.
4. See partial captions without a premature warning.
5. See finalized turns appear with speaker labels.
6. See the encounter graph update after each final turn.
7. See an evidence warning appear only after the full verified pair exists.
8. Open the warning and trace it to transcript turns and a verified source-linked record.
9. Speak a correction.
10. See the graph supersede the earlier assertion.
11. See the warning retracted with an explanation.
12. Add a proposed prescription and see the graph recompute.
13. Run the streaming/audio benchmark.
14. Confirm that UI metrics match the generated result file.
15. Confirm that no unsupported medical statement was generated.

---

## 42. Authoritative implementation references

These links are implementation references, not medical evidence sources.

- OpenAI Realtime transcription: https://developers.openai.com/api/docs/guides/realtime-transcription
- OpenAI Realtime API with WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI Speech-to-text and diarization: https://developers.openai.com/api/docs/guides/speech-to-text
- FastAPI WebSockets: https://fastapi.tiangolo.com/advanced/websockets/
- Pydantic models: https://docs.pydantic.dev/

Medical evidence must continue to come only from the physician-reviewed CDC, FSRH, FDA, and MHRA source set represented in `evidence_records.json` and its source registry.

---

## 43. Final implementation statement

> Build a Python-based, real-time, event-sourced encounter engine. It must listen through a dedicated speech-to-text layer, analyze finalized conversation turns, construct and revise a temporary patient medication graph, validate graph state and evidence eligibility, and surface or retract source-linked hormone-medication evidence warnings through the existing frontend. The system must be deterministic at the medical matching layer, fully provenance-linked, able to abstain, and explicit that it does not approve prescriptions or establish clinical safety.
