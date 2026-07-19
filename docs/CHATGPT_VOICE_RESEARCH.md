# Research memo: a "ChatGPT plugin" with voice mode for HormoneRx

*Researched 2026-07-19. The ChatGPT platform is moving fast — re-verify the voice-support
status before committing engineering time.*

## Question

Can we build a ChatGPT integration so a clinician can **talk** to ChatGPT during/about a
consultation and have it use the HormoneRx evidence pipeline (context extraction +
deterministic, source-linked evidence retrieval)?

## 1. "Plugins" no longer exist — the integration surfaces in 2026

| Era | Surface | Status |
|---|---|---|
| 2023 | ChatGPT **Plugins** | Fully retired April 2024 |
| Nov 2023 → | **Custom GPTs** with Actions (your OpenAPI endpoints) | Alive; no new platform investment |
| Oct 2025 → | **Apps SDK / MCP apps in ChatGPT** (Model Context Protocol servers + optional widget UI, app directory + submission review) | The current primary path |
| For our own product | **OpenAI Realtime / Responses APIs** | What HormoneRx v0.2.0 already uses |

## 2. The critical finding: voice mode does not run app/Action tools (as of July 2026)

- **Apps SDK apps are not reachable from ChatGPT voice mode.** Native voice conversations
  do not trigger app tools; developers have asked for a roadmap and none has been given
  (community threads Dec 2025 – Jul 2026).
- **Custom GPT Actions do not execute in voice mode either.** OpenAI's help center lists
  custom actions as unavailable in voice; community reports (incl. an "InvalidRecipient"
  bug and an Advanced-Voice regression) confirm Actions silently fail in voice even
  though the same GPT works in text. Feature requests are still open as of April 2026.
- ChatGPT voice itself is getting heavy investment (voice merged into chat Nov 2025,
  major voice upgrade + CarPlay Jul 2026) — so native app-in-voice support is plausible
  later, but **today a voice-first ChatGPT integration cannot call our backend**.

## 3. Policy constraints that shape any ChatGPT integration

- OpenAI's App Developer Terms **prohibit apps from processing PHI** (HIPAA-protected
  health information). A synthetic-data research demo is fine; anything touching real
  patient data inside ChatGPT is contractually off the table.
- Submission guidelines require data minimization, narrow tool scopes, a privacy policy,
  and general-audience appropriateness; a medical-adjacent app should expect extra review
  friction.
- **Safety-boundary tension (ours, not OpenAI's):** in any ChatGPT integration, the
  *ChatGPT model* does the talking. It may paraphrase, embellish, or add advice around
  our verbatim record content — exactly what the HormoneRx safety boundary forbids. We
  can instruct against it and return pre-formatted verbatim cards, but we cannot
  guarantee it the way our own UI does. Any ChatGPT surface must therefore be framed as
  "evidence lookup assistant over a research dataset", never as the safety-validated
  product.

## 4. Options, ranked

1. **RECOMMENDED — MCP server + Apps SDK app (text now, voice when it lands).**
   Wrap the existing engine as a small MCP server exposing 2–3 narrow tools:
   `analyze_consultation_text(text) → {state, missing_information, matches[]}` and
   `get_evidence_record(id) → verbatim record`. This reuses `EncounterService` directly,
   is the platform's forward path, gives us an app-directory presence, and inherits voice
   support automatically the day OpenAI enables tools in voice mode. Effort: small —
   the deterministic pipeline is already an importable TypeScript module; MCP is the same protocol
   family the spec's ecosystem uses.
2. **Widget-embedded voice inside the app (the community workaround).** Apps SDK widgets
   are iframes; our widget could embed its own mic button and stream to *our* backend
   (the exact audio path v0.2.0 already implements), giving "voice in ChatGPT" without
   ChatGPT's voice mode. Works, but duplicates our own UI inside ChatGPT and needs
   review-guideline care.
3. **Custom GPT with Actions.** Quickest to ship (one OpenAPI spec over
   `/api/encounters/*`), good for a hackathon demo link — but text-only in practice
   (Actions dead in voice), and GPTs are the legacy path.
4. **Skip ChatGPT; keep voice in our own app.** Already built: HormoneRx's Live
   Consultation is a voice-mode clinical listener with guarantees ChatGPT cannot offer
   (deterministic matching, no generated medical text, visible retraction). ChatGPT
   integration then remains a discovery/demo channel, not the product.

## 5. Recommendation

Do **1 + 4**: keep the safety-critical voice experience in our own app (it exists and is
verified), and build the thin MCP/Apps-SDK wrapper for reach — explicitly labeled
research-prototype, synthetic data only, returning verbatim record cards with the
physician-verification status. Re-check quarterly whether ChatGPT voice mode has gained
app-tool support; when it does, option 1 becomes voice-capable with zero extra work.

## Sources

- [Voice Mode Support for ChatGPT Apps — roadmap thread](https://community.openai.com/t/voice-mode-support-for-chatgpt-apps-widgets-roadmap-and-best-practice-guidance/1385649)
- [Why don't Apps SDK support ChatGPT's voice conversation mode?](https://community.openai.com/t/why-dont-apps-sdk-support-chatgpts-voice-conversation-mode/1368967)
- [Introducing apps in ChatGPT and the new Apps SDK (OpenAI)](https://openai.com/index/introducing-apps-in-chatgpt/)
- [Build with the Apps SDK (OpenAI Help)](https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk)
- [App submission guidelines (OpenAI Developers)](https://developers.openai.com/apps-sdk/app-submission-guidelines)
- [App Developer Terms — PHI prohibition (OpenAI)](https://openai.com/policies/developer-apps-terms/)
- [ChatGPT Voice FAQ — custom actions unavailable in voice](https://help.openai.com/en/articles/8400625-voice-mode-faq)
- [Advanced Voice Mode in Custom GPTs (community)](https://community.openai.com/t/advanced-voice-mode-support-in-custom-gpts/998747)
- [Custom GPT Actions never execute in Voice Mode (bug report)](https://community.openai.com/t/custom-gpt-actions-work-in-text-but-never-execute-in-voice-mode-invalidrecipient-unrecognized-recipient/1385102)
- [Function calling not working in Advanced Voice Mode](https://community.openai.com/t/function-calling-not-working-in-advanced-voice-mode/1345809)
- [ChatGPT Plugins vs Custom GPTs vs MCP Apps (timeline overview)](https://www.getdrio.com/blog/chatgpt-plugins-vs-custom-gpts)
- [ChatGPT voice upgrade July 2026 (9to5Mac)](https://9to5mac.com/2026/07/08/openai-upgrading-chatgpt-with-all-new-voice-mode-experience-watch-here/)
