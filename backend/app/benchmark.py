"""Reproducible benchmark runner (spec §25, §26).

Layers:
  text      — Layer A: standalone snippets, one finalized turn each.
  streaming — Layer B: event sequences with an expected state after every event.
  audio     — Layer C: requires recorded synthetic audio + live transcription;
              reported as skipped (never fabricated) when prerequisites are absent.

Gold labels are read-only inputs. Results are written to
backend/data/benchmark_results.json and a UI copy of the streaming summary to
src/data/streaming_benchmark_results.json. Real numbers only.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

from .config import get_settings
from .deterministic_extractor import EXTRACTOR_VERSION, DeterministicExtractor
from .encounter_service import DuplicateEventError, EncounterService
from .evidence_index import EvidenceIndex
from .models import Speaker, new_id
from .warning_engine import NO_MATCH_PRIMARY, NO_MATCH_SECONDARY

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent

ALLOWED_MESSAGES = {NO_MATCH_PRIMARY, NO_MATCH_SECONDARY}


def _round(x: float) -> float:
    return round(x, 4)


def _safe_div(a: float, b: float) -> float:
    return 0.0 if b == 0 else a / b


def build_service() -> EncounterService:
    settings = get_settings()
    index = EvidenceIndex(
        settings.evidence_path,
        settings.synonym_path,
        strict=True,
        allow_pending_verification=settings.evidence_allow_pending_verification,
    )
    return EncounterService(settings, index, DeterministicExtractor(index))


# ---------------------------------------------------------------------------
# Layer A — text
# ---------------------------------------------------------------------------

async def run_text_layer(service: EncounterService) -> dict:
    cases = json.loads((BACKEND_DIR / "data" / "benchmark_cases.json").read_text())["cases"]
    tp = fp = fn = tn = 0
    retrieval_correct = 0
    abst_expected = abst_correct = 0
    neg_total = neg_correct = hist_total = hist_correct = 0
    expected_positive = cited_correct = 0
    unsupported = 0
    status_total = status_correct = 0
    pass_count = 0
    results = []

    for case in cases:
        runtime = service.create_encounter()
        snapshot = await service.process_final_turn(
            runtime, event_id=new_id("evt"), text=case["input"], speaker=Speaker.DOCTOR
        )
        actual_state = snapshot.result_state.value
        active = snapshot.active_warnings()
        actual_record = active[0].evidence_record_id if len(active) == 1 else (None if not active else ",".join(sorted(w.evidence_record_id for w in active)))
        state_ok = actual_state == case["expectedResultState"]
        record_ok = actual_record == case["expectedEvidenceRecordId"]
        passed = state_ok and record_ok
        pass_count += passed

        exp_pos = case["expectedResultState"] == "EVIDENCE_FOUND"
        act_pos = actual_state == "EVIDENCE_FOUND"
        if exp_pos:
            expected_positive += 1
        if act_pos and exp_pos and record_ok:
            tp += 1
        elif act_pos and (not exp_pos or not record_ok):
            fp += 1
        if exp_pos and (not act_pos or not record_ok):
            fn += 1
        if not act_pos and not exp_pos:
            tn += 1
        if record_ok:
            retrieval_correct += 1
        if case["expectedAbstention"]:
            abst_expected += 1
            if not act_pos:
                abst_correct += 1
        if case["category"] == "explicit_negation":
            neg_total += 1
            neg_correct += state_ok
        if case["category"] == "historical_use":
            hist_total += 1
            hist_correct += state_ok
        if act_pos:
            record = service.index.get_record(active[0].evidence_record_id)
            if record_ok and record["sourceUrl"].strip() and record["sourceSection"].strip():
                cited_correct += 1
        for message in snapshot.messages:
            if message not in ALLOWED_MESSAGES:
                unsupported += 1
        # Medication status accuracy for the interacting medication, when labeled.
        expected_status = case.get("expectedMedicationStatus")
        if expected_status and case.get("expectedMedication"):
            status_total += 1
            interacting = [
                a for a in snapshot.assertions
                if a.category.value == "other_medication" and a.concept_id in service.index.ontology.medication_concepts
            ]
            if any(a.status.value == expected_status for a in interacting):
                status_correct += 1

        results.append(
            {
                "id": case["id"],
                "category": case["category"],
                "input": case["input"],
                "expectedResultState": case["expectedResultState"],
                "actualResultState": actual_state,
                "expectedEvidenceRecordId": case["expectedEvidenceRecordId"],
                "actualEvidenceRecordId": actual_record,
                "pass": passed,
                "lookupReason": snapshot.lookup_reason,
            }
        )

    precision = _safe_div(tp, tp + fp)
    recall = _safe_div(tp, tp + fn)
    return {
        "layer": "A-text",
        "caseCount": len(cases),
        "metrics": {
            "passRate": _round(_safe_div(pass_count, len(cases))),
            "triggerPrecision": _round(precision),
            "triggerRecall": _round(recall),
            "triggerF1": _round(_safe_div(2 * precision * recall, precision + recall)),
            "retrievalAccuracy": _round(_safe_div(retrieval_correct, len(cases))),
            "correctAbstentionRate": _round(_safe_div(abst_correct, abst_expected)),
            "negationAccuracy": _round(_safe_div(neg_correct, neg_total)),
            "historicalContextAccuracy": _round(_safe_div(hist_correct, hist_total)),
            "citationCoverage": _round(_safe_div(cited_correct, expected_positive)),
            "medicationStatusAccuracy": _round(_safe_div(status_correct, status_total)),
            "falsePositiveCount": fp,
            "unsupportedClaimCount": unsupported,
        },
        "confusion": {"truePositive": tp, "falsePositive": fp, "falseNegative": fn, "trueNegative": tn},
        "counts": {"passCount": pass_count, "total": len(cases)},
        "cases": results,
    }


# ---------------------------------------------------------------------------
# Layer B — streaming
# ---------------------------------------------------------------------------

async def run_streaming_layer(service: EncounterService) -> dict:
    data = json.loads((BACKEND_DIR / "data" / "streaming_benchmark_cases.json").read_text())
    cases = data["cases"]
    event_total = event_correct = 0
    final_correct = 0
    retrieval_events = retrieval_correct = 0
    retraction_expected = retraction_correct = 0
    premature_warnings = 0
    duplicate_warnings = 0
    citation_events = citation_correct = 0
    unsupported = 0
    retraction_latency_turns: list[int] = []
    case_results = []

    for case in cases:
        runtime = service.create_encounter()
        proposal_by_sequence: dict[int, str] = {}
        event_results = []
        warning_created_at_event: dict[str, int] = {}
        for event_index, event in enumerate(case["events"]):
            etype = event["type"]
            try:
                if etype == "transcript.final":
                    await service.process_final_turn(
                        runtime,
                        event_id=event.get("event_id") or new_id("evt"),
                        text=event["text"],
                        speaker=Speaker(event["speaker"]),
                        sequence=event["sequence"],
                    )
                elif etype == "prescription.proposed":
                    snapshot = await service.propose_prescription(
                        runtime, event_id=new_id("evt"), surface_text=event["medication_surface_text"]
                    )
                    proposal_by_sequence[event["sequence"]] = snapshot.proposals[-1].proposal_id
                elif etype == "prescription.cancelled":
                    ref = event["cancelsEventOfSequence"]
                    await service.cancel_prescription(
                        runtime, event_id=new_id("evt"), proposal_id=proposal_by_sequence[ref]
                    )
            except DuplicateEventError:
                if not event.get("isDuplicateReplay"):
                    raise

            snapshot = runtime.snapshot
            active = snapshot.active_warnings()
            active_records = sorted({w.evidence_record_id for w in active})
            state_ok = snapshot.result_state.value in event["expectedResultStates"]
            records_ok = active_records == sorted(event["expectedEvidenceRecordIds"])
            count_ok = len(active) == event["expectedActiveWarningCount"]
            retraction_ok = True
            if event.get("expectRetractionWithReason"):
                retraction_expected += 1
                retracted = [w for w in snapshot.warnings if w.state == "retracted"]
                retraction_ok = bool(retracted and all(w.retraction_reason for w in retracted))
                retraction_correct += retraction_ok
                for w in retracted:
                    if w.warning_id in warning_created_at_event:
                        retraction_latency_turns.append(event_index - warning_created_at_event.pop(w.warning_id))
            context_ok = True
            if event.get("expectedWarningContext"):
                context_ok = bool(active) and all(w.context.value == event["expectedWarningContext"] for w in active)
            for w in active:
                warning_created_at_event.setdefault(w.warning_id, event_index)
            if event["expectedEvidenceRecordIds"]:
                retrieval_events += 1
                retrieval_correct += records_ok
                citation_events += len(active)
                for w in active:
                    record = service.index.get_record(w.evidence_record_id)
                    citation_correct += bool(record["sourceUrl"].strip() and record["sourceSection"].strip())
            if event["expectedActiveWarningCount"] == 0 and active:
                premature_warnings += len(active)
            if len(active) > event["expectedActiveWarningCount"]:
                duplicate_warnings += len(active) - event["expectedActiveWarningCount"]
            for message in snapshot.messages:
                if message not in ALLOWED_MESSAGES:
                    unsupported += 1

            ok = state_ok and records_ok and count_ok and retraction_ok and context_ok
            event_total += 1
            event_correct += ok
            event_results.append(
                {
                    "sequence": event.get("sequence"),
                    "type": etype,
                    "expectedResultStates": event["expectedResultStates"],
                    "actualResultState": snapshot.result_state.value,
                    "expectedEvidenceRecordIds": event["expectedEvidenceRecordIds"],
                    "actualEvidenceRecordIds": active_records,
                    "pass": ok,
                }
            )
        final_ok = event_results[-1]["pass"]
        final_correct += final_ok
        case_results.append(
            {
                "id": case["id"],
                "category": case["category"],
                "pass": all(e["pass"] for e in event_results),
                "events": event_results,
            }
        )

    latencies = [
        latency.total_ms
        for case_runtime in service.encounters.values()
        for latency in case_runtime.latencies
    ]
    latency_summary = None
    if latencies:
        latencies_sorted = sorted(latencies)
        latency_summary = {
            "samples": len(latencies_sorted),
            "medianMs": _round(statistics.median(latencies_sorted)),
            "p90Ms": _round(latencies_sorted[int(0.9 * (len(latencies_sorted) - 1))]),
            "maxMs": _round(latencies_sorted[-1]),
            "note": "Backend pipeline only (final transcript received -> result computed), deterministic extractor, no network. Live-mode model latency is not included and must be measured separately.",
        }

    return {
        "layer": "B-streaming",
        "caseCount": len(cases),
        "metrics": {
            "casePassRate": _round(_safe_div(sum(c["pass"] for c in case_results), len(cases))),
            "perEventStateAccuracy": _round(_safe_div(event_correct, event_total)),
            "finalStateAccuracy": _round(_safe_div(final_correct, len(cases))),
            "retrievalAccuracy": _round(_safe_div(retrieval_correct, retrieval_events)),
            "warningRetractionAccuracy": _round(_safe_div(retraction_correct, retraction_expected)),
            "meanRetractionLatencyEvents": _round(_safe_div(sum(retraction_latency_turns), len(retraction_latency_turns))) if retraction_latency_turns else 0.0,
            "prematureWarningCount": premature_warnings,
            "duplicateWarningCount": duplicate_warnings,
            "citationCoverage": _round(_safe_div(citation_correct, citation_events)),
            "unsupportedClaimCount": unsupported,
        },
        "counts": {"events": event_total, "eventsCorrect": event_correct},
        "processingLatency": latency_summary,
        "cases": case_results,
    }


# ---------------------------------------------------------------------------
# Layer C — audio (prerequisite-gated; never fabricated)
# ---------------------------------------------------------------------------

def run_audio_layer(service: EncounterService) -> dict:
    manifest = json.loads((BACKEND_DIR / "data" / "audio_benchmark_manifest.json").read_text())
    settings = get_settings()
    missing_files = [
        c["file"] for c in manifest["cases"] if not (BACKEND_DIR / "data" / c["file"]).exists()
    ]
    reasons = []
    if missing_files:
        reasons.append(f"{len(missing_files)} audio files not recorded yet")
    if not settings.openai_api_key:
        reasons.append("no OPENAI_API_KEY for live transcription")
    if reasons:
        return {
            "layer": "C-audio",
            "status": "SKIPPED",
            "reason": "; ".join(reasons),
            "caseCount": len(manifest["cases"]),
            "note": "Results are only reported for runs that actually happened. Record the manifest audio and set OPENAI_API_KEY to execute this layer.",
        }
    return {
        "layer": "C-audio",
        "status": "NOT_IMPLEMENTED_IN_THIS_RUNNER_VERSION",
        "note": "Transcribe each file through the realtime pipeline and evaluate against the manifest gold labels.",
    }


# ---------------------------------------------------------------------------

async def main(layers: list[str]) -> None:
    service = build_service()
    output: dict = {
        "metadata": {
            "benchmarkVersion": "0.2.0",
            "evidenceVersion": service.index.dataset_version,
            "engine": "hormonerx-backend/0.2.0",
            "extractionModel": EXTRACTOR_VERSION,
            "mode": "demo-deterministic",
            "evalTimestamp": datetime.now(timezone.utc).isoformat(),
            "deterministic": True,
            "runtimeEligibleRecords": service.index.runtime_eligible_ids(),
            "pendingPhysicianSignOff": [
                rid for rid, rep in service.index.reports.items() if rep.eligible_via_pending_override
            ],
        },
        "layers": {},
    }
    if "text" in layers:
        output["layers"]["text"] = await run_text_layer(service)
    if "streaming" in layers:
        output["layers"]["streaming"] = await run_streaming_layer(service)
    if "audio" in layers:
        output["layers"]["audio"] = run_audio_layer(service)

    results_path = BACKEND_DIR / "data" / "benchmark_results.json"
    results_path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")

    ui_copy = REPO_DIR / "src" / "data" / "streaming_benchmark_results.json"
    ui_copy.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")

    for name, layer in output["layers"].items():
        if layer.get("status") == "SKIPPED":
            print(f"[{name}] SKIPPED: {layer['reason']}")
            continue
        print(f"[{name}] cases={layer['caseCount']} metrics={json.dumps(layer['metrics'])}")
        failing = [c["id"] for c in layer.get("cases", []) if not c.get("pass", True)]
        if failing:
            print(f"[{name}] FAILING: {failing}")
    print(f"Results written to {results_path} and {ui_copy}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--layer", action="append", choices=["text", "streaming", "audio", "all"], default=None)
    args = parser.parse_args()
    selected = args.layer or ["all"]
    if "all" in selected:
        selected = ["text", "streaming", "audio"]
    asyncio.run(main(selected))
