/**
 * Fleet roster (v0.4.0): builds the full 17-instance fleet — 14 worker roles,
 * with the per-hormone watcher role instantiated four times. At least 10 are
 * always running with default settings; the washout sentinel ships disabled
 * pending physician sign-off, and the source-link monitor's network egress is
 * opt-in.
 */
import { Settings } from '../config.ts';
import { EvidenceIndex } from '../evidenceIndex.ts';
import { buildExtractor } from '../extractor.ts';
import {
  coverageGapMinerWorker,
  fleetWatchdogWorker,
  invariantAuditorWorker,
  sourceLinkMonitorWorker,
} from './integrity.ts';
import {
  hiddenInducerHunter,
  hormoneWatchers,
  potentInducerSpecialist,
  seizureRiskSpecialist,
  washoutWindowSentinel,
} from './specialists.ts';
import { FleetSupervisor } from './supervisor.ts';
import {
  ambiguitySentinelWorker,
  bigPictureWorker,
  contradictionHunterWorker,
  detailExtractorWorker,
  subjectAuditorWorker,
} from './transcriptWorkers.ts';

export function buildFleet(settings: Settings, index: EvidenceIndex): FleetSupervisor {
  const supervisor = new FleetSupervisor(settings, index);
  const workers = [
    // Tier 1 — transcript workers
    detailExtractorWorker(settings),
    bigPictureWorker(settings, buildExtractor(settings, index)),
    contradictionHunterWorker(),
    subjectAuditorWorker(),
    ambiguitySentinelWorker(),
    // Tier 2 — danger-condition specialists
    seizureRiskSpecialist(),
    potentInducerSpecialist(),
    washoutWindowSentinel(settings, index),
    hiddenInducerHunter(),
    ...hormoneWatchers(),
    // Tier 3 — database integrity & maintenance
    invariantAuditorWorker(index),
    sourceLinkMonitorWorker(settings, index),
    coverageGapMinerWorker(),
    fleetWatchdogWorker(settings, index),
  ];
  for (const worker of workers) {
    supervisor.register(worker);
  }
  return supervisor;
}
