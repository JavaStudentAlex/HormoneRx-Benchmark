/**
 * Reproducible benchmark runner.
 * Processes benchmark_cases.json through the DETERMINISTIC demo pipeline
 * (extractDeterministic -> runLookup) and writes REAL numbers to
 * src/data/benchmark_results.json. Gold labels are never modified here.
 *
 * If OPENAI_API_KEY is absent, the run is evaluated in demo mode and clearly
 * labelled as such. It never pretends a live-model run occurred.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { extractDeterministic } from '../src/lib/extract';
import { runLookup, NO_MATCH_PRIMARY, NO_MATCH_SECONDARY } from '../src/lib/lookup';
import { evidenceVersion, evidenceRecords } from '../src/lib/evidence';
import { PIPELINE_VERSION } from '../src/lib/pipeline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '../src/data');

interface BenchmarkCase {
  id: string;
  category: string;
  input: string;
  expectedHormonalProduct: string | null;
  expectedMedication: string | null;
  expectedMedicationStatus: string;
  expectedResultState: string;
  expectedEvidenceRecordId: string | null;
  expectedAbstention: boolean;
  rationale: string;
}

const casesFile = JSON.parse(readFileSync(resolve(dataDir, 'benchmark_cases.json'), 'utf-8')) as {
  benchmarkVersion: string;
  cases: BenchmarkCase[];
};
const cases = casesFile.cases;

const ALLOWED_NON_MEDICAL_MESSAGES = new Set<string>([NO_MATCH_PRIMARY, NO_MATCH_SECONDARY, 'An error occurred while processing the input. Please try again.']);

// Positive class for the entity/context-recognition metric: cases that contain an
// identified hormonal product AND a current INTERACTING medication (i.e. a record lookup
// should be attempted and is expected to yield a record). True negatives contain a
// current NON-interacting medication, so correctly withholding the record lookup for them
// is not a miss; they are excluded from this positive class. Gold labels are untouched.
const SHOULD_SEARCH_CATEGORIES = new Set(['clear_positive', 'implicit_positive']);

let tp = 0;
let fp = 0;
let fn = 0;
let tn = 0;

let retrievalCorrect = 0;
let abstentionExpected = 0;
let abstentionCorrect = 0;
let negationTotal = 0;
let negationCorrect = 0;
let historicalTotal = 0;
let historicalCorrect = 0;
let expectedPositive = 0;
let citedCorrect = 0;
let actualPositive = 0;
let unsupportedClaimCount = 0;
let passCount = 0;

// Entity trigger-decision confusion (did we correctly decide to attempt retrieval).
let entTp = 0;
let entFp = 0;
let entFn = 0;

const caseResults = cases.map((c) => {
  const extraction = extractDeterministic(c.input);
  const result = runLookup(extraction);

  const actualState = result.state;
  const actualRecordId = result.matchedRecord?.id ?? null;
  const recordCorrect = actualRecordId === c.expectedEvidenceRecordId;
  const stateCorrect = actualState === c.expectedResultState;
  const pass = stateCorrect && recordCorrect;
  if (pass) passCount++;

  const isExpPos = c.expectedResultState === 'EVIDENCE_FOUND';
  const isActPos = actualState === 'EVIDENCE_FOUND';
  if (isExpPos) expectedPositive++;
  if (isActPos) actualPositive++;

  if (isActPos && isExpPos && recordCorrect) tp++;
  else if (isActPos && (!isExpPos || !recordCorrect)) fp++;
  if (isExpPos && (!isActPos || !recordCorrect)) fn++;
  if (!isActPos && !isExpPos) tn++;

  if (recordCorrect) retrievalCorrect++;

  if (c.expectedAbstention) {
    abstentionExpected++;
    if (actualState !== 'EVIDENCE_FOUND') abstentionCorrect++;
  }
  if (c.category === 'explicit_negation') {
    negationTotal++;
    if (stateCorrect) negationCorrect++;
  }
  if (c.category === 'historical_use') {
    historicalTotal++;
    if (stateCorrect) historicalCorrect++;
  }

  // Citation coverage: an EVIDENCE_FOUND result is "citation covered" only when the
  // correct record was retrieved AND that record carries a non-empty, real citation
  // (sourceUrl + sourceSection) — which is displayed verbatim, never invented.
  if (isActPos) {
    const rec = result.matchedRecord!;
    const citationOk = recordCorrect && rec.sourceUrl.trim().length > 0 && rec.sourceSection.trim().length > 0;
    if (citationOk) citedCorrect++;
  }

  // Unsupported-claim check: any displayed message that is not a fixed non-medical string
  // and is not sourced verbatim from the matched record counts as unsupported.
  for (const msg of result.messages) {
    if (!ALLOWED_NON_MEDICAL_MESSAGES.has(msg)) unsupportedClaimCount++;
  }

  // Entity trigger-decision metric.
  const goldShouldSearch = SHOULD_SEARCH_CATEGORIES.has(c.category);
  const predShouldSearch = extraction.shouldSearchEvidence;
  if (goldShouldSearch && predShouldSearch) entTp++;
  else if (!goldShouldSearch && predShouldSearch) entFp++;
  else if (goldShouldSearch && !predShouldSearch) entFn++;

  return {
    id: c.id,
    category: c.category,
    input: c.input,
    expectedResultState: c.expectedResultState,
    actualResultState: actualState,
    expectedEvidenceRecordId: c.expectedEvidenceRecordId,
    actualEvidenceRecordId: actualRecordId,
    expectedMedicationStatus: c.expectedMedicationStatus,
    actualMedicationStatus: extraction.otherMedication.status,
    expectedHormonalProduct: c.expectedHormonalProduct,
    actualHormonalProductNormalized: extraction.hormonalProduct.normalized,
    shouldSearchEvidence: predShouldSearch,
    lookupReason: result.lookupReason,
    pass,
  };
});

const round = (n: number) => Math.round(n * 10000) / 10000;
const safeDiv = (a: number, b: number) => (b === 0 ? 0 : a / b);

const precision = safeDiv(tp, tp + fp);
const recall = safeDiv(tp, tp + fn);
const f1 = safeDiv(2 * precision * recall, precision + recall);

const entPrecision = safeDiv(entTp, entTp + entFp);
const entRecall = safeDiv(entTp, entTp + entFn);

const hasApiKey = Boolean(process.env.OPENAI_API_KEY);

const output = {
  metadata: {
    benchmarkVersion: casesFile.benchmarkVersion,
    evidenceVersion,
    pipelineVersion: PIPELINE_VERSION,
    mode: 'demo',
    modelRun: hasApiKey ? 'deterministic-demo (API key present but runner evaluates demo pipeline)' : 'deterministic-demo (no API key)',
    model: 'deterministic-demo-extractor',
    promptVersion: 'n/a — rule-based deterministic extractor v0.1.0',
    evalTimestamp: new Date().toISOString(),
    randomSeed: 42,
    deterministic: true,
    caseCount: cases.length,
    evidenceRecordCount: evidenceRecords.length,
  },
  metrics: {
    triggerPrecision: round(precision),
    triggerRecall: round(recall),
    triggerF1: round(f1),
    retrievalAccuracy: round(safeDiv(retrievalCorrect, cases.length)),
    correctAbstentionRate: round(safeDiv(abstentionCorrect, abstentionExpected)),
    negationAccuracy: round(safeDiv(negationCorrect, negationTotal)),
    historicalContextAccuracy: round(safeDiv(historicalCorrect, historicalTotal)),
    citationCoverage: round(safeDiv(citedCorrect, expectedPositive)),
    entityPrecision: round(entPrecision),
    entityRecall: round(entRecall),
    falsePositiveCount: fp,
    unsupportedClaimCount,
    passRate: round(safeDiv(passCount, cases.length)),
  },
  confusion: { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn },
  counts: {
    passCount,
    total: cases.length,
    expectedPositive,
    actualPositive,
    abstentionExpected,
    abstentionCorrect,
  },
  cases: caseResults,
};

writeFileSync(resolve(dataDir, 'benchmark_results.json'), JSON.stringify(output, null, 2) + '\n', 'utf-8');

console.log('Benchmark complete.');
console.log(`  Cases: ${cases.length}  Pass: ${passCount}  PassRate: ${output.metrics.passRate}`);
console.log(`  Trigger P/R/F1: ${output.metrics.triggerPrecision} / ${output.metrics.triggerRecall} / ${output.metrics.triggerF1}`);
console.log(`  Retrieval accuracy: ${output.metrics.retrievalAccuracy}`);
console.log(`  Correct abstention rate: ${output.metrics.correctAbstentionRate}`);
console.log(`  Negation accuracy: ${output.metrics.negationAccuracy}  Historical: ${output.metrics.historicalContextAccuracy}`);
console.log(`  Citation coverage: ${output.metrics.citationCoverage}  False positives: ${output.metrics.falsePositiveCount}  Unsupported claims: ${output.metrics.unsupportedClaimCount}`);
