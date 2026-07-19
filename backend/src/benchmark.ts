/**
 * Reproducible benchmark runner (spec §25, §26).
 *
 * Layers:
 *   text      — Layer A: standalone snippets, one finalized turn each.
 *   streaming — Layer B: event sequences with an expected state after every event.
 *   audio     — Layer C: requires recorded synthetic audio + live transcription;
 *               reported as skipped (never fabricated) when prerequisites are absent.
 *
 * Gold labels are read-only inputs. Results are written to
 * backend/data/benchmark_results.json and a UI copy of the streaming summary to
 * src/data/streaming_benchmark_results.json. Real numbers only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BACKEND_DIR, getSettings } from './config.ts';
import { DeterministicExtractor, EXTRACTOR_VERSION } from './deterministicExtractor.ts';
import { DuplicateEventError, EncounterService } from './encounterService.ts';
import { EvidenceIndex } from './evidenceIndex.ts';
import { Speaker, activeWarnings, newId } from './models.ts';
import { NO_MATCH_PRIMARY, NO_MATCH_SECONDARY } from './warningEngine.ts';

const REPO_DIR = path.resolve(BACKEND_DIR, '..');

const ALLOWED_MESSAGES = new Set([NO_MATCH_PRIMARY, NO_MATCH_SECONDARY]);

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0.0 : a / b;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function buildService(): EncounterService {
  const settings = getSettings();
  const index = new EvidenceIndex(settings.evidence_path, settings.synonym_path, {
    strict: true,
    allowPendingVerification: settings.evidence_allow_pending_verification,
  });
  return new EncounterService(settings, index, new DeterministicExtractor(index));
}

// ---------------------------------------------------------------------------
// Layer A — text
// ---------------------------------------------------------------------------

interface TextCase {
  id: string;
  category: string;
  input: string;
  expectedResultState: string;
  expectedEvidenceRecordId: string | null;
  expectedAbstention: boolean;
  expectedMedication?: string | null;
  expectedMedicationStatus?: string | null;
  [key: string]: unknown;
}

export async function runTextLayer(service: EncounterService): Promise<Record<string, unknown>> {
  const cases = (
    JSON.parse(readFileSync(path.join(BACKEND_DIR, 'data', 'benchmark_cases.json'), 'utf8')) as {
      cases: TextCase[];
    }
  ).cases;
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let retrievalCorrect = 0;
  let abstExpected = 0, abstCorrect = 0;
  let negTotal = 0, negCorrect = 0, histTotal = 0, histCorrect = 0;
  let expectedPositive = 0, citedCorrect = 0;
  let unsupported = 0;
  let statusTotal = 0, statusCorrect = 0;
  let passCount = 0;
  const results: Array<Record<string, unknown>> = [];

  for (const testCase of cases) {
    const runtime = service.createEncounter();
    const snapshot = await service.processFinalTurn(runtime, {
      event_id: newId('evt'),
      text: testCase.input,
      speaker: Speaker.DOCTOR,
    });
    const actualState = snapshot.result_state;
    const active = activeWarnings(snapshot);
    const actualRecord =
      active.length === 1
        ? active[0].evidence_record_id
        : active.length === 0
          ? null
          : [...active.map((w) => w.evidence_record_id)].sort().join(',');
    const stateOk = actualState === testCase.expectedResultState;
    const recordOk = actualRecord === testCase.expectedEvidenceRecordId;
    const passed = stateOk && recordOk;
    if (passed) passCount++;

    const expPos = testCase.expectedResultState === 'EVIDENCE_FOUND';
    const actPos = actualState === 'EVIDENCE_FOUND';
    if (expPos) expectedPositive++;
    if (actPos && expPos && recordOk) tp++;
    else if (actPos && (!expPos || !recordOk)) fp++;
    if (expPos && (!actPos || !recordOk)) fn++;
    if (!actPos && !expPos) tn++;
    if (recordOk) retrievalCorrect++;
    if (testCase.expectedAbstention) {
      abstExpected++;
      if (!actPos) abstCorrect++;
    }
    if (testCase.category === 'explicit_negation') {
      negTotal++;
      if (stateOk) negCorrect++;
    }
    if (testCase.category === 'historical_use') {
      histTotal++;
      if (stateOk) histCorrect++;
    }
    if (actPos) {
      const record = service.index.getRecord(active[0].evidence_record_id);
      if (recordOk && String(record.sourceUrl).trim() && String(record.sourceSection).trim()) {
        citedCorrect++;
      }
    }
    for (const message of snapshot.messages) {
      if (!ALLOWED_MESSAGES.has(message)) unsupported++;
    }
    // Medication status accuracy for the interacting medication, when labeled.
    const expectedStatus = testCase.expectedMedicationStatus;
    if (expectedStatus && testCase.expectedMedication) {
      statusTotal++;
      const interacting = snapshot.assertions.filter(
        (a) =>
          a.category === 'other_medication' && a.concept_id in service.index.ontology.medication_concepts,
      );
      if (interacting.some((a) => a.status === expectedStatus)) statusCorrect++;
    }

    results.push({
      id: testCase.id,
      category: testCase.category,
      input: testCase.input,
      expectedResultState: testCase.expectedResultState,
      actualResultState: actualState,
      expectedEvidenceRecordId: testCase.expectedEvidenceRecordId,
      actualEvidenceRecordId: actualRecord,
      pass: passed,
      lookupReason: snapshot.lookup_reason,
    });
  }

  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  return {
    layer: 'A-text',
    caseCount: cases.length,
    metrics: {
      passRate: round4(safeDiv(passCount, cases.length)),
      triggerPrecision: round4(precision),
      triggerRecall: round4(recall),
      triggerF1: round4(safeDiv(2 * precision * recall, precision + recall)),
      retrievalAccuracy: round4(safeDiv(retrievalCorrect, cases.length)),
      correctAbstentionRate: round4(safeDiv(abstCorrect, abstExpected)),
      negationAccuracy: round4(safeDiv(negCorrect, negTotal)),
      historicalContextAccuracy: round4(safeDiv(histCorrect, histTotal)),
      citationCoverage: round4(safeDiv(citedCorrect, expectedPositive)),
      medicationStatusAccuracy: round4(safeDiv(statusCorrect, statusTotal)),
      falsePositiveCount: fp,
      unsupportedClaimCount: unsupported,
    },
    confusion: { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn },
    counts: { passCount, total: cases.length },
    cases: results,
  };
}

// ---------------------------------------------------------------------------
// Layer B — streaming
// ---------------------------------------------------------------------------

interface StreamingEvent {
  type: string;
  sequence?: number;
  text?: string;
  speaker?: string;
  event_id?: string;
  medication_surface_text?: string;
  cancelsEventOfSequence?: number;
  isDuplicateReplay?: boolean;
  expectedResultStates: string[];
  expectedEvidenceRecordIds: string[];
  expectedActiveWarningCount: number;
  expectRetractionWithReason?: boolean;
  expectedWarningContext?: string;
}

interface StreamingCase {
  id: string;
  category: string;
  events: StreamingEvent[];
}

export async function runStreamingLayer(service: EncounterService): Promise<Record<string, unknown>> {
  const data = JSON.parse(
    readFileSync(path.join(BACKEND_DIR, 'data', 'streaming_benchmark_cases.json'), 'utf8'),
  ) as { cases: StreamingCase[] };
  const cases = data.cases;
  let eventTotal = 0, eventCorrect = 0;
  let finalCorrect = 0;
  let retrievalEvents = 0, retrievalCorrect = 0;
  let retractionExpected = 0, retractionCorrect = 0;
  let prematureWarnings = 0;
  let duplicateWarnings = 0;
  let citationEvents = 0, citationCorrect = 0;
  let unsupported = 0;
  const retractionLatencyTurns: number[] = [];
  const caseResults: Array<Record<string, unknown>> = [];

  for (const testCase of cases) {
    const runtime = service.createEncounter();
    const proposalBySequence = new Map<number, string>();
    const eventResults: Array<Record<string, unknown>> = [];
    const warningCreatedAtEvent = new Map<string, number>();
    for (let eventIndex = 0; eventIndex < testCase.events.length; eventIndex++) {
      const event = testCase.events[eventIndex];
      try {
        if (event.type === 'transcript.final') {
          await service.processFinalTurn(runtime, {
            event_id: event.event_id || newId('evt'),
            text: event.text ?? '',
            speaker: event.speaker as Speaker,
            sequence: event.sequence,
          });
        } else if (event.type === 'prescription.proposed') {
          const snapshot = await service.proposePrescription(runtime, {
            event_id: newId('evt'),
            surface_text: event.medication_surface_text ?? '',
          });
          proposalBySequence.set(
            event.sequence as number,
            snapshot.proposals[snapshot.proposals.length - 1].proposal_id,
          );
        } else if (event.type === 'prescription.cancelled') {
          const ref = event.cancelsEventOfSequence as number;
          await service.cancelPrescription(runtime, {
            event_id: newId('evt'),
            proposal_id: proposalBySequence.get(ref) as string,
          });
        }
      } catch (err) {
        if (!(err instanceof DuplicateEventError) || !event.isDuplicateReplay) throw err;
      }

      const snapshot = runtime.snapshot;
      const active = activeWarnings(snapshot);
      const activeRecords = [...new Set(active.map((w) => w.evidence_record_id))].sort();
      const stateOk = event.expectedResultStates.includes(snapshot.result_state);
      const expectedSorted = [...event.expectedEvidenceRecordIds].sort();
      const recordsOk =
        activeRecords.length === expectedSorted.length &&
        activeRecords.every((r, i) => r === expectedSorted[i]);
      const countOk = active.length === event.expectedActiveWarningCount;
      let retractionOk = true;
      if (event.expectRetractionWithReason) {
        retractionExpected++;
        const retracted = snapshot.warnings.filter((w) => w.state === 'retracted');
        retractionOk = retracted.length > 0 && retracted.every((w) => Boolean(w.retraction_reason));
        if (retractionOk) retractionCorrect++;
        for (const w of retracted) {
          const createdAt = warningCreatedAtEvent.get(w.warning_id);
          if (createdAt !== undefined) {
            retractionLatencyTurns.push(eventIndex - createdAt);
            warningCreatedAtEvent.delete(w.warning_id);
          }
        }
      }
      let contextOk = true;
      if (event.expectedWarningContext) {
        contextOk = active.length > 0 && active.every((w) => w.context === event.expectedWarningContext);
      }
      for (const w of active) {
        if (!warningCreatedAtEvent.has(w.warning_id)) {
          warningCreatedAtEvent.set(w.warning_id, eventIndex);
        }
      }
      if (event.expectedEvidenceRecordIds.length) {
        retrievalEvents++;
        if (recordsOk) retrievalCorrect++;
        citationEvents += active.length;
        for (const w of active) {
          const record = service.index.getRecord(w.evidence_record_id);
          if (String(record.sourceUrl).trim() && String(record.sourceSection).trim()) {
            citationCorrect++;
          }
        }
      }
      if (event.expectedActiveWarningCount === 0 && active.length) {
        prematureWarnings += active.length;
      }
      if (active.length > event.expectedActiveWarningCount) {
        duplicateWarnings += active.length - event.expectedActiveWarningCount;
      }
      for (const message of snapshot.messages) {
        if (!ALLOWED_MESSAGES.has(message)) unsupported++;
      }

      const ok = stateOk && recordsOk && countOk && retractionOk && contextOk;
      eventTotal++;
      if (ok) eventCorrect++;
      eventResults.push({
        sequence: event.sequence ?? null,
        type: event.type,
        expectedResultStates: event.expectedResultStates,
        actualResultState: snapshot.result_state,
        expectedEvidenceRecordIds: event.expectedEvidenceRecordIds,
        actualEvidenceRecordIds: activeRecords,
        pass: ok,
      });
    }
    const finalOk = eventResults[eventResults.length - 1].pass as boolean;
    if (finalOk) finalCorrect++;
    caseResults.push({
      id: testCase.id,
      category: testCase.category,
      pass: eventResults.every((e) => e.pass),
      events: eventResults,
    });
  }

  const latencies: number[] = [];
  for (const runtime of service.encounters.values()) {
    for (const latency of runtime.latencies) {
      latencies.push(latency.total_ms);
    }
  }
  let latencySummary: Record<string, unknown> | null = null;
  if (latencies.length) {
    const sorted = [...latencies].sort((a, b) => a - b);
    latencySummary = {
      samples: sorted.length,
      medianMs: round4(median(sorted)),
      p90Ms: round4(sorted[Math.floor(0.9 * (sorted.length - 1))]),
      maxMs: round4(sorted[sorted.length - 1]),
      note: 'Backend pipeline only (final transcript received -> result computed), deterministic extractor, no network. Live-mode model latency is not included and must be measured separately.',
    };
  }

  return {
    layer: 'B-streaming',
    caseCount: cases.length,
    metrics: {
      casePassRate: round4(safeDiv(caseResults.filter((c) => c.pass).length, cases.length)),
      perEventStateAccuracy: round4(safeDiv(eventCorrect, eventTotal)),
      finalStateAccuracy: round4(safeDiv(finalCorrect, cases.length)),
      retrievalAccuracy: round4(safeDiv(retrievalCorrect, retrievalEvents)),
      warningRetractionAccuracy: round4(safeDiv(retractionCorrect, retractionExpected)),
      meanRetractionLatencyEvents: retractionLatencyTurns.length
        ? round4(safeDiv(retractionLatencyTurns.reduce((a, b) => a + b, 0), retractionLatencyTurns.length))
        : 0.0,
      prematureWarningCount: prematureWarnings,
      duplicateWarningCount: duplicateWarnings,
      citationCoverage: round4(safeDiv(citationCorrect, citationEvents)),
      unsupportedClaimCount: unsupported,
    },
    counts: { events: eventTotal, eventsCorrect: eventCorrect },
    processingLatency: latencySummary,
    cases: caseResults,
  };
}

// ---------------------------------------------------------------------------
// Layer C — audio (prerequisite-gated; never fabricated)
// ---------------------------------------------------------------------------

export function runAudioLayer(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(path.join(BACKEND_DIR, 'data', 'audio_benchmark_manifest.json'), 'utf8'),
  ) as { cases: Array<{ file: string }> };
  const settings = getSettings();
  const missingFiles = manifest.cases
    .map((c) => c.file)
    .filter((file) => !existsSync(path.join(BACKEND_DIR, 'data', file)));
  const reasons: string[] = [];
  if (missingFiles.length) {
    reasons.push(`${missingFiles.length} audio files not recorded yet`);
  }
  if (!settings.openai_api_key) {
    reasons.push('no OPENAI_API_KEY for live transcription');
  }
  if (reasons.length) {
    return {
      layer: 'C-audio',
      status: 'SKIPPED',
      reason: reasons.join('; '),
      caseCount: manifest.cases.length,
      note: 'Results are only reported for runs that actually happened. Record the manifest audio and set OPENAI_API_KEY to execute this layer.',
    };
  }
  return {
    layer: 'C-audio',
    status: 'NOT_IMPLEMENTED_IN_THIS_RUNNER_VERSION',
    note: 'Transcribe each file through the realtime pipeline and evaluate against the manifest gold labels.',
  };
}

// ---------------------------------------------------------------------------

export async function main(layers: string[]): Promise<void> {
  const service = buildService();
  const output: Record<string, any> = {
    metadata: {
      benchmarkVersion: '0.3.0',
      evidenceVersion: service.index.dataset_version,
      engine: 'hormonerx-backend-ts/0.3.0',
      extractionModel: EXTRACTOR_VERSION,
      mode: 'demo-deterministic',
      evalTimestamp: new Date().toISOString(),
      deterministic: true,
      runtimeEligibleRecords: service.index.runtimeEligibleIds(),
      pendingPhysicianSignOff: Object.entries(service.index.reports)
        .filter(([, rep]) => rep.eligible_via_pending_override)
        .map(([rid]) => rid),
    },
    layers: {},
  };
  if (layers.includes('text')) {
    output.layers.text = await runTextLayer(service);
  }
  if (layers.includes('streaming')) {
    output.layers.streaming = await runStreamingLayer(service);
  }
  if (layers.includes('audio')) {
    output.layers.audio = runAudioLayer();
  }

  const resultsPath = path.join(BACKEND_DIR, 'data', 'benchmark_results.json');
  writeFileSync(resultsPath, JSON.stringify(output, null, 2) + '\n');

  const uiCopy = path.join(REPO_DIR, 'src', 'data', 'streaming_benchmark_results.json');
  writeFileSync(uiCopy, JSON.stringify(output, null, 2) + '\n');

  for (const [name, layer] of Object.entries(output.layers) as Array<[string, any]>) {
    if (layer.status === 'SKIPPED') {
      console.log(`[${name}] SKIPPED: ${layer.reason}`);
      continue;
    }
    console.log(`[${name}] cases=${layer.caseCount} metrics=${JSON.stringify(layer.metrics)}`);
    const failing = (layer.cases ?? []).filter((c: any) => !(c.pass ?? true)).map((c: any) => c.id);
    if (failing.length) {
      console.log(`[${name}] FAILING: ${JSON.stringify(failing)}`);
    }
  }
  console.log(`Results written to ${resultsPath} and ${uiCopy}`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const layerArgs: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--layer' && process.argv[i + 1]) {
      layerArgs.push(process.argv[++i]);
    }
  }
  let selected = layerArgs.length ? layerArgs : ['all'];
  if (selected.includes('all')) {
    selected = ['text', 'streaming', 'audio'];
  }
  main(selected).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
