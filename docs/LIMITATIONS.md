# Limitations

Read this before drawing any conclusion from the app or benchmark.

- **Small prototype evidence dataset.** Six records covering a few interaction families. Not comprehensive.
- **Synthetic benchmark.** 20 constructed consultation snippets; no real consultations, no real patient data.
- **Manually curated gold labels.** Labels reflect the authors' clinical reasoning and could contain errors. They are immutable within a version but not externally validated.
- **No clinical validation.** Nothing here has been tested in or approved for clinical use.
- **Not comprehensive.** Many real interactions, methods, and medications are absent.
- **No treatment, dosing, or prescribing recommendations.** The system only retrieves cited evidence.
- **Benchmark performance does not establish clinical safety.** A 100% pass rate on the deterministic demo pipeline reflects internal consistency of the harness (the synthetic cases use the dataset's own vocabulary), not real-world accuracy.
- **Absence of a record is not evidence of absence of an interaction.** NO_VALIDATED_MATCH means only that nothing was found in this narrow prototype dataset.
- **Verification status.** All six records are currently `physicianVerified: false` pending final physician confirmation. Until confirmed, describe the dataset as "physician-reviewed, source-verification pending."
- **Jurisdictional variation.** Guidance differs by country (e.g. FSRH/MHRA are UK; CDC US-MEC and the FDA label are US). Records note their jurisdiction; do not assume cross-jurisdiction applicability.
- **Sources change over time.** `lastVerified` dates are recorded per record; guidance and labels are updated periodically and should be re-checked.
