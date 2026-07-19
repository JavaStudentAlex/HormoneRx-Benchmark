# Realtime Architecture

How audio becomes a cautious, source-linked evidence result.

```text
Browser microphone
  └─ AudioWorklet → PCM16 mono 24 kHz frames
       └─ WS /ws/encounters/{id}/audio  (browser → Python; no provider key in the browser)
            └─ Python relay → provider realtime transcription WS  (server-side OPENAI_API_KEY)
                 ├─ transcription deltas  → caption.updated (display only, never analyzed)
                 └─ completed turns       → transcript event router
                                              └─ extraction → normalization → event log
                                                   → graph reducer → validator → pair eligibility
                                                   → deterministic evidence lookup → warning engine
                                                   → WS events to the React UI
```

## Credential handling

- `POST /api/realtime/session` mints an **ephemeral client secret** for the preferred
  browser-WebRTC architecture. The server's standard API key is never returned.
- The implemented default transport is the spec §7.2 **fallback architecture**: the browser
  streams PCM16 to our own WebSocket and the Python server holds the provider connection.
  Secrets stay server-side in both designs.
- With no `OPENAI_API_KEY` (demo mode) the microphone path is disabled and clearly labeled;
  scripted demo replay, manual turns, and the text tab drive the identical pipeline.

## Partial vs finalized transcript (spec §7.4)

| Class | Displayed | Stored | Analyzed | Can warn |
|---|---|---|---|---|
| Partial delta | as provisional caption | no (unless `STORE_TRANSCRIPTS=true`) | never | never |
| Finalized turn | as a stable turn with speaker + turn id | yes (event log) | yes | only via deterministic match |

This split is what prevents a premature warning from "She takes carbamazepine, but…"
before "…she stopped it last year" arrives.

## Ordering, dedup, idempotency (spec §7.5, §19.6)

Every final turn carries `event_id`, optional `provider_item_id`, and a client `sequence`.
The router rejects duplicate `event_id`/`provider_item_id` before any state changes
(WS replies `event.duplicate`; REST replies 409). The reducer rebuilds the graph from the
event log ordered by turn sequence, so a late-arriving earlier turn is replayed in its
correct position and any stale warning is retracted (covered by STREAM-009/010).

## Speaker attribution (spec §7.7)

Automatic diarization is not a dependency. The UI has an explicit Doctor / Patient /
Unknown selector (shortcuts D / P); every finalized turn carries the selected label, and
the extractor applies deterministic subject rules on top (other-person cues, doctor
first-person, discussion-only mentions).

## Turn finalization (spec §7.6)

Live mode uses provider server-VAD turn detection. The manual **Finalize turn** input is
always available as the noisy-room fallback and doubles as the text-input fallback.

## Failure behavior (spec §36)

- Transcription unavailable → error banner; scripted demo + text fallback still work.
- Extraction failure → `EXTRACTION_FAILED` event, transcript retained, deterministic
  fallback extractor (config `EXTRACTION_FALLBACK_DETERMINISTIC`), non-medical error only.
- Evidence file invalid → strict mode fails startup listing errors; development mode loads
  only eligible records and reports exclusions (`/api/health`).
- Frontend WS drop → reconnect with backoff; the server always replays the current
  encounter snapshot on (re)connect; client event ids prevent duplicate finals.

## Latency

Each turn records received→extraction→graph→result timings (visible in the result panel,
audit export, and benchmark output). Measured backend processing (deterministic extractor,
no network): sub-millisecond to low-millisecond per turn. Live speech-end→final-transcript
and model-extraction latency depend on the provider and MUST be measured before being
quoted; targets in spec §7.8 are engineering targets, not results.
