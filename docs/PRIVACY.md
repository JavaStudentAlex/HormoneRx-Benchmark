# Privacy and Data Handling

## What the prototype does (hackathon scope)

- **Synthetic conversations only.** The UI states this before capture starts; do not
  speak real patient names or real consultations.
- **Explicit start/stop.** Audio capture begins only after pressing *Start listening*;
  a visible recording indicator and an immediate *Stop* control are always present;
  stopping ends microphone tracks and the provider connection.
- **No raw-audio retention.** Audio frames are relayed for transcription and discarded
  (`STORE_RAW_AUDIO=false` default; the audit export never contains audio).
- **No transcript persistence by default.** Encounter state (turns, graph, warnings)
  lives in server memory only and disappears on reset or restart
  (`STORE_TRANSCRIPTS=false` default). The only export is the user-triggered synthetic
  audit JSON.
- **No patient identifiers.** Subjects are role labels (patient / doctor /
  other person); no names, no accounts, no persistent patient graph.
- **Secrets stay server-side.** The browser never receives the standard API key; live
  transcription uses ephemeral credentials or a server-side relay.
- **No analytics** receive transcript content. Logs carry technical metadata only.

## What a real deployment would additionally require (not solved here)

Informed consent flows · medical confidentiality obligations · data-protection basis
and DPIA · retention policy · processor agreements with the transcription/model
provider · access control and audit access · medical-device classification
assessment · clinical governance and human-oversight procedures · cybersecurity
hardening · incident response.

The prototype's avoidance of names and persistence does **not** make it compliant with
any of the above; it only keeps the hackathon demonstration safe.
