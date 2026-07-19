# Verification Table — 60-second morning check

One row per evidence record. Confirm each direction is medically correct and no dosing/directive wording slipped in, then set `physicianVerified: true` for approved rows in `src/data/evidence_records.json`. All six currently have `physicianVerified: false`. **None contain `[VERIFY]` flags.**

**The one to scrutinise: INT-005 (lamotrigine) is the REVERSED direction.** The others are "enzyme inducer reduces contraceptive efficacy"; INT-005 is "contraceptive reduces lamotrigine level → seizure-control risk." Confirm INT-006 (levonorgestrel EC) carries **no** dose/switch advice.

| # | Hormonal product | Interacting medication | Direction | Potential consequence (paraphrase) | Source · section | physicianVerified | [VERIFY] flags |
|---|---|---|---|---|---|---|---|
| INT-001 | Combined hormonal contraceptive | Carbamazepine | Medication → reduces contraceptive exposure | Enzyme inducer may reduce contraceptive effectiveness; not advised during use + 28 days after. | FSRH (May 2022) · §4 CHC row; §3.1.1 | **false** | none |
| INT-002 | Combined hormonal contraceptive | Rifampicin / rifabutin | Medication → reduces contraceptive exposure | Potent enzyme inducers may reduce effectiveness; use alternative method. US-MEC category 3. | FSRH §4 (rifampicin exception) + CDC US-MEC 2024 (Rifampin/rifabutin, CHC=3) | **false** | none |
| INT-003 | Progestogen-only pill | Hepatic enzyme-inducing medication | Medication → reduces contraceptive exposure | Enzyme inducers may reduce POP effectiveness; not advised during use + 28 days after. | FSRH (May 2022) · §4 POP row; §3.1.1 | **false** | none |
| INT-004 | Etonogestrel implant | Hepatic enzyme-inducing medication | Medication → reduces contraceptive exposure | Enzyme inducers may reduce implant effectiveness; recommend alternative method. | FSRH (May 2022) · §4 ENG-IMP row; §3.1.1 | **false** | none |
| INT-005 | Estrogen-containing oral contraceptive | Lamotrigine | **REVERSED:** contraceptive → reduces lamotrigine exposure | Estrogen-containing OC decreases lamotrigine by ~50% (seizure-control risk); levels rise in pill-free week. **No dose advice included.** | FDA LAMICTAL label (rev 10/2025) §7/12.3 & §5.9; FSRH §3.1.3 / §9 | **false** | none |
| INT-006 | Levonorgestrel emergency contraception | Hepatic enzyme-inducing medication | Medication → reduces contraceptive exposure | CYP3A4 inducers increase LNG metabolism, may reduce EC efficacy; enzyme effect persists up to 4 weeks. **Dose/IUD advice deliberately excluded.** | MHRA DSU (Sept 2016) · "Effect of hepatic enzyme inducers…" | **false** | none |

## Sign-off

- [ ] INT-001 direction correct → set `true`
- [ ] INT-002 direction + US-MEC category correct → set `true`
- [ ] INT-003 direction correct → set `true`
- [ ] INT-004 direction correct → set `true`
- [ ] INT-005 **reversed direction** correct and no dose advice → set `true`
- [ ] INT-006 non-directive (no dose/IUD advice) → set `true`

If out of time, leave any record `false` and label the dataset "physician-reviewed, source-verification pending." After editing, re-run `npm run test` (schema test asserts any `physicianVerified: true` record still cites a real section).
