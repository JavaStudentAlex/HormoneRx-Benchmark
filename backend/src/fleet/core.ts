/**
 * Agent-fleet worker contract (v0.4.0).
 *
 * A fleet worker is an always-registered agent that observes the encounter —
 * the append-only event log and the derived snapshot — and reacts on its own
 * cadence. Workers have two output channels and NOTHING else:
 *
 *  1. Findings: observations published to the fleet log and broadcast over the
 *     encounter WebSocket. Any medical wording inside a finding must be quoted
 *     verbatim from an evidence record; everything else is workflow language
 *     (questions to ask, integrity notes, health reports).
 *  2. Proposals: supplementary structured extractions for a turn. A proposal
 *     never mutates the graph directly — the supervisor merges it into the
 *     turn's MENTIONS_EXTRACTED event and the ordinary reducer/warning
 *     pipeline decides what the knowledge graph looks like. The reducer stays
 *     the single arbiter; workers only contribute inputs.
 *
 * Workers therefore cannot create warnings, cannot suppress each other, cannot
 * edit evidence records, and cannot flip physician sign-off. A worker that
 * throws is isolated: its health degrades, the core engine keeps running.
 */
import { Settings } from '../config.ts';
import { DeterministicExtractor } from '../deterministicExtractor.ts';
import { EncounterRuntime, EncounterService } from '../encounterService.ts';
import { EvidenceIndex } from '../evidenceIndex.ts';
import {
  Correction,
  EncounterEvent,
  EncounterSnapshot,
  IsoDateTime,
  NormalizedMention,
  TranscriptTurn,
} from '../models.ts';
import { ConceptNormalizer } from '../normalizer.ts';

export type WorkerCadence = 'turn' | 'commit' | 'interval';
export type WorkerStatus = 'healthy' | 'degraded' | 'failed' | 'disabled' | 'idle';
export type FindingSeverity = 'info' | 'attention' | 'alert';

export interface FleetFinding {
  finding_id: string;
  worker_id: string;
  worker_name: string;
  encounter_id: string | null;
  severity: FindingSeverity;
  /** Machine-readable slug, e.g. 'seizure-risk-active', 'washout-window'. */
  kind: string;
  message: string;
  refs: Record<string, unknown>;
  created_at: IsoDateTime;
}

/** Worker-authored part of a finding; the supervisor stamps the rest. */
export interface FindingDraft {
  severity: FindingSeverity;
  kind: string;
  message: string;
  refs?: Record<string, unknown>;
  /** Findings with the same worker + dedupe_key + message are emitted once. */
  dedupe_key?: string;
}

/**
 * A supplementary extraction for an already-processed turn. The supervisor
 * merges it into that turn's MENTIONS_EXTRACTED event (union with what the
 * primary extractor produced) and recomputes; the reducer applies its normal
 * supersession/contradiction rules to the merged input.
 */
export interface WorkerProposal {
  turn_id: string;
  normalized_mentions: NormalizedMention[];
  corrections: Correction[];
  missing_information: string[];
  note: string;
}

export interface WorkerRunResult {
  findings: FindingDraft[];
  proposals?: WorkerProposal[];
  /** Items for the physician review queue (dataset gaps, behavior proposals). */
  reviewItems?: ReviewItemDraft[];
}

export interface ReviewItemDraft {
  kind: string;
  summary: string;
  detail: string;
  refs?: Record<string, unknown>;
  dedupe_key: string;
}

export interface ReviewItem extends ReviewItemDraft {
  item_id: string;
  worker_id: string;
  created_at: IsoDateTime;
}

/** Per-encounter context handed to turn/commit workers. Read-only by contract. */
export interface WorkerContext {
  runtime: EncounterRuntime;
  snapshot: EncounterSnapshot;
  events: EncounterEvent[];
  latestTurn: TranscriptTurn | null;
  index: EvidenceIndex;
  settings: Settings;
  normalizer: ConceptNormalizer;
  fallbackExtractor: DeterministicExtractor;
}

/** Context for interval (global) workers that watch the whole system. */
export interface GlobalContext {
  service: EncounterService;
  index: EvidenceIndex;
  settings: Settings;
  /** Health snapshot of every worker, for the watchdog. */
  health: WorkerHealthView[];
}

export interface WorkerHealthView {
  worker_id: string;
  status: WorkerStatus;
  cadence: WorkerCadence;
  enabled: boolean;
  runs: number;
  errors: number;
  consecutive_errors: number;
  last_run_at: IsoDateTime | null;
  last_error: string | null;
}

export interface FleetWorker {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  cadence: WorkerCadence;
  /** For cadence 'interval': how often runGlobal fires. */
  intervalMs?: number;
  /**
   * True when this worker currently runs as (or delegates to) a live model
   * agent; false means the deterministic implementation is active. The
   * interface is identical either way — agentic variants plug in behind it.
   */
  agentic: boolean;
  enabled: boolean;
  disabledReason?: string;
  /** Detailed behavior description; the same text is published in docs/FLEET.md. */
  description: string;
  runEncounter?(ctx: WorkerContext): Promise<WorkerRunResult>;
  runGlobal?(ctx: GlobalContext): Promise<WorkerRunResult>;
}

export const EMPTY_RESULT: WorkerRunResult = { findings: [] };
