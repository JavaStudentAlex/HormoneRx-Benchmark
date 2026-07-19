# The Agent Fleet (v0.4.0)

The encounter is processed by a **fleet of always-running workers/agents** on top of the
core realtime engine. Each worker observes the same append-only event log and derived
graph snapshot, on its own cadence, with its own narrow responsibility: some contribute
extractions to the knowledge graph, some watch for one specific dangerous condition,
and some continuously check that everything — graph and evidence database — is okay.

**17 worker instances are registered (14 roles; the per-hormone watcher role runs 4
instances). 15 run with default settings**; the washout sentinel is gated on physician
sign-off and the source-link monitor's network egress is opt-in.

## Constitution (non-negotiable)

1. **Workers only quote, never author, medical text.** Any medical wording in a finding
   is a verbatim quote from an evidence record; everything else is workflow language
   (questions to ask, escalations, integrity reports).
2. **The reducer stays the single arbiter of the graph.** A worker that wants to update
   the knowledge graph submits a *proposal*: a supplementary structured extraction that
   is merged into the turn's `MENTIONS_EXTRACTED` event. The ordinary reducer and
   warning engine then decide what the graph and warnings look like. Workers cannot
   create, edit, or suppress warnings directly.
3. **Disagreement surfaces as a contradiction**, never gets averaged away. No worker can
   silence another worker's finding, and there is still no green "safe" state.
4. **Maintenance workers propose; the physician disposes.** Dataset gaps, source drift,
   and behavior changes go to the review queue (`GET /api/fleet/review-queue`). Nothing
   the fleet does can change an evidence record, a synonym, or a `physicianVerified` flag.
5. **Failure degrades to the baseline engine, never below it.** A worker that throws is
   isolated (health drops to degraded, then failed after 3 consecutive errors); the core
   pipeline keeps running. The watchdog reports every failure — no silent gaps.
6. **Parity with the benchmark.** With the fleet attached, every gold-labeled behavior of
   the baseline engine is unchanged (asserted by the fleet-parity tests). Benchmarks run
   against the baseline engine; the fleet only adds findings and, rarely, extractions
   that the gold sequences never trigger.

## How it runs

- **Cadences.** `turn` workers run after every finalized turn; `commit` workers run after
  every graph recompute (turns, proposals, cancellations); `interval` workers run on
  timers (and immediately via `POST /api/fleet/run`).
- **Ordering.** Encounter-scoped workers run inside the same per-encounter mutex as turn
  processing, so the fleet always sees a consistent snapshot and worker proposals can
  never interleave with a concurrent turn.
- **Heartbeats & health.** Every run updates the worker's status, last-run time,
  duration, error counts, findings, and applied proposals — visible at
  `GET /api/fleet/status` and in the Live Consultation "Agent fleet" panel.
- **Publication.** New findings broadcast as `fleet.finding` WebSocket events; a
  `fleet.status` summary follows every turn. Findings deduplicate by
  (worker, key, message) so a stable condition is reported once, not every commit.
- **Agentic mode.** Workers marked *agentic* delegate to the live structured-output
  model when `OPENAI_API_KEY` is configured and demo mode is off (same strict JSON
  contract and validation as the primary extractor); otherwise the deterministic
  implementation runs. The interface is identical either way.

## Tier 1 — transcript workers (the realtime extraction path)

### w01 · Detail extractor (`turn`, agentic in live mode)
The primary per-turn extraction agent — the component that actually runs inside turn
processing (live structured-output model when a key is configured, deterministic rule
extractor otherwise); its fleet entry is the heartbeat and audit of that run. After
every finalized turn it verifies a `MENTIONS_EXTRACTED` event exists for the turn,
reports which extraction method produced it, and raises an attention finding whenever
the live model failed and the deterministic fallback was used — so silent quality
degradation is impossible.

### w02 · Big-picture worker (`turn`, agentic in live mode)
Cross-turn context agent. Where the detail extractor sees one turn at a time, this
worker re-reads a sliding window of recent turns as one context:

1. It joins each pair of adjacent same-speaker turns and re-runs extraction on the
   joined text, catching mentions split across a turn boundary ("I'm on the combined" /
   "pill, yes"). Any concept found in the join that has no existing mention or assertion
   is **proposed** as a supplementary extraction — merged into the turn's extraction
   event and decided by the ordinary reducer, never written to the graph directly.
2. It flags underspecified references ("that one", "the other pill") that produced no
   mention, asking for the name to be restated.

### w03 · Contradiction hunter (`commit`)
Watches the whole assertion history after every graph commit: (1) every resolved
contradiction (polarity flip or explicit correction) is surfaced as a finding so it is
visibly acknowledged, not just applied; (2) unresolved same-turn contradictions (which
make the engine abstain) are raised at alert severity; (3) a concept whose patient
status flipped two or more times during the encounter is flagged as a repeated
flip-flop with a request to confirm the current status verbally; (4) integrity: every
retracted warning must carry a retraction reason — a missing reason is an alert.

### w04 · Subject auditor (`turn`)
Verifies who each mention belongs to before it can matter: unattributed current-status
mentions are raised with a request to confirm whether they refer to the patient
(mirroring the engine's own abstention); mentions attributed to another person or the
doctor are logged as informational findings confirming their exclusion from patient
matching. The auditor never reassigns a subject — it only asks.

### w05 · Ambiguity sentinel (`commit`)
Polices the abstain-instead-of-guess rule: every AMBIGUOUS mention ("the pill", class
words like "enzyme inducer") is surfaced with the ontology's approved clarification
question; simultaneous mutually-exclusive products escalate the clarification request;
and an ambiguous mention that carries no clarification question at all is an alert,
because ambiguity must never be silently ignored.

## Tier 2 — danger-condition specialists

### w06 · Seizure-risk specialist (`commit`) — the "deadly condition" watch
Owns record INT-005, the only record whose consequence is loss of disease control
(reduced lamotrigine exposure → seizure-control risk) rather than reduced contraceptive
efficacy. Per commit: (1) an active INT-005 warning is escalated to an alert finding so
it always sits at the top of review; (2) **near-miss watch**: if lamotrigine and an
estrogen-containing product both appear anywhere in the graph but statuses do not
currently trigger INT-005, it asks for both statuses to be confirmed verbally rather
than letting the pair pass silently; (3) it scans the transcript for
pill-free/hormone-free-interval phrases while lamotrigine is in the graph and quotes
the record's own verbatim sentence about hormone-free intervals.

### w07 · Potent-inducer specialist (`commit`)
Owns record INT-002 — rifampicin/rifabutin, the potent enzyme inducers the guidance
singles out (US-MEC category 3). Per commit: (1) potent inducer + combined/estrogen
product active → verifies the INT-002 warning actually fired (a missing expected
warning is an integrity alert); (2) potent inducer with no hormonal context → echoes
the engine's request to establish the contraception context; (3) duplicate-warning
integrity: no (record, hormone, medication) pair may carry two simultaneous active
warnings.

### w08 · Washout-window sentinel (`commit`) — **disabled pending physician sign-off**
Records INT-001/003/004 state the contraceptive is not recommended "for **28 days
after stopping**" an enzyme inducer, and INT-006 states induction persists "**up to 4
weeks after**" stopping — but the engine treats a stated stop as historical context and
retracts. When enabled (`FLEET_WASHOUT_SENTINEL=true`, development only, forced off in
production), this worker finds patient assertions of an enzyme-inducer concept with
historical/negated status while a hormonal product is active or planned, quotes the
matching record's verbatim persistence sentence, and asks exactly when the medication
was stopped. It is **advisory-only even when enabled**: no warning creation, no
assertion changes, no result-state changes — see the VERIFICATION_TABLE.md addendum.

### w09 · Hidden-inducer hunter (`turn`)
Owns the agents patients do not think of as medications, grounded in record INT-006:
supplement/herbal/OTC talk without a named product prompts a request for specific names
(noting the dataset's herbal entries, e.g. St John's wort); levonorgestrel emergency
contraception entering the graph raises a time-critical finding quoting INT-006's
population definition verbatim — enzyme-inducer use within the last 4 weeks matters
now, not later.

### w10 a–d · Per-hormone watchers (`commit`, 4 instances)
CHC (INT-001/002/005), POP (INT-003), implant (INT-004), and emergency-contraception
(INT-006) overlays. Each logs a status summary whenever its product is asserted
(status, applicable records, active/retracted warning counts) so coverage for each
product is one worker's clear responsibility, and flags exactly which of its records
still run under the pending-verification override. They own no matching logic —
matching stays in the deterministic pair index.

## Tier 3 — database integrity & maintenance

### w11 · Graph invariant auditor (`commit`)
Independent replay auditor on top of the engine's inline validation: rebuilds the graph
from the raw event log with its own reducer and runs all 12 invariants; rebuilds twice
and compares canonical JSON (determinism check); cross-checks the published snapshot
against the replay. Any deviation is an alert.

### w12 · Evidence source-link monitor (`interval`, default 6 h; network egress opt-in)
Fetches every unique `sourceUrl` in the dataset, hashes the content, reports
unreachable sources, records a baseline on first fetch, and raises an alert plus a
physician review-queue item when content drifts from the baseline ("the cited source
may have changed since lastVerified"). It never edits a record or re-dates
`lastVerified`. Enable with `FLEET_LINK_CHECK=true`.

### w13 · Coverage-gap miner (`commit`)
Turns live encounters into dataset-coverage proposals: unknown terms (in neither the
ontology nor the non-interacting lexicon) and uncovered (hormonal × medication) pairs
behind a `NO_VALIDATED_MATCH` result are filed into the physician review queue, always
restating the engine's caveat that absence of a record does not establish absence of an
interaction. The miner cannot add records, synonyms, or aliases itself.

### w14 · Fleet watchdog & self-check (`interval`, default 60 s)
The worker that watches the workers — and continuously re-proves the engine:
(1) health sweep over every worker's error counters; (2) p90 turn-latency watch against
the mode's threshold (250 ms deterministic / 5 s live); (3) transcription/relay
failures recorded in any encounter are surfaced; (4) **deterministic canary** — runs a
known conversation (combined pill + carbamazepine, then a correction) through a fresh
throwaway engine and asserts the exact expected result sequence
(MORE_INFORMATION_REQUIRED → EVIDENCE_FOUND with INT-001 → RETRACTED). Any deviation is
an alert: the engine no longer matches its benchmarked behavior. Full Layer A+B
benchmarks remain `npm run benchmark:backend`; the canary is the always-on tripwire
between runs.

## Long-session robustness (related, outside the fleet)

The audio relay is now supervised (`RelaySupervisor`): when the provider closes the
socket mid-session (session cap, network blip) it reconnects with exponential backoff,
notifies the client (`relay.state` events), logs `TRANSCRIPTION_FAILED` events the
watchdog picks up, and counts — never hides — audio frames dropped while disconnected.
The event log itself has no length limit; note it is in-memory (a restart loses the
running encounter) and each turn replays the full log (linear growth per turn).

## API surface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/fleet/status` | Roster with per-worker description, health, counters |
| `GET /api/fleet/findings?encounter_id=&limit=` | Recent findings (fleet log) |
| `GET /api/fleet/review-queue` | Physician proposals (gaps, drift, disabled behaviors) |
| `POST /api/fleet/run` | Run all interval workers immediately |
| WS `fleet.finding`, `fleet.status`, `relay.state` | Live fleet events on the encounter socket |
