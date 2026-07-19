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

---

# Addendum v0.2.0 — machine-matching metadata to review

`backend/data/evidence_records.json` (now the single canonical evidence file) added
machine-matching fields. **Medical prose is byte-identical to v0.1.0** (verified by
script and by `backend/tests/test_evidence.py::test_medical_prose_identical_to_v1`).
Please review the derivations below together with the direction sign-off above.

| Record | matchType | Applies to hormonal concepts | Explicit interacting members | Review question |
|---|---|---|---|---|
| INT-001 | specific_pair | combined_hormonal_contraceptive, **estrogen_containing_oral_contraceptive** | carbamazepine | Derived: record synonyms include "ethinylestradiol-containing contraceptive" — OK to match estrogen-containing OCs? |
| INT-002 | any_member | same as INT-001 | rifampicin, rifabutin | Same derived hormonal mapping. |
| INT-003 | closed_class | progestogen_only_pill | carbamazepine, phenytoin, phenobarbital, primidone, rifampicin, rifabutin | Members = exactly the agents already enumerated in the record's synonym list; nothing added. |
| INT-004 | closed_class | etonogestrel_implant | same six as INT-003 | Same rule. |
| INT-005 | specific_pair | estrogen_containing_oral_contraceptive, **combined_hormonal_contraceptive** | lamotrigine | Derived: record synonyms include "combined oral contraceptive". Direction stays REVERSED. |
| INT-006 | closed_class | levonorgestrel_emergency_contraception | carbamazepine, phenytoin, primidone, rifampicin, rifabutin, efavirenz, st_johns_wort, griseofulvin | "barbiturates" (class word) NOT expanded — phenobarbital deliberately absent because this record's list does not name it. Enumerate if desired. |

Also changed: the bare alias **"the pill"** was removed from synonym lists and is now an
ambiguous reference that abstains (task spec §15.7) — confirm you agree it must never
auto-resolve to the combined pill.

- [ ] Derived hormonal-concept mappings approved (INT-001/002/005)
- [ ] Closed-class member lists approved (INT-003/004/006)
- [ ] "the pill" ambiguity behavior approved

---

# Addendum v0.4.0 — proposed fleet behavior: washout-window sentinel

While building the agent fleet (docs/FLEET.md) we found a blind spot in the current
engine that your own records describe:

- INT-001, INT-003, INT-004 state the contraceptive is not recommended during use of the
  enzyme inducer **"and for 28 days after stopping it"**.
- INT-006 states elevated enzyme levels **"can persist for up to 4 weeks after"** the
  enzyme-inducing medicine is stopped.
- But when a patient says "I stopped carbamazepine last month", the engine classifies
  the medication as historical context and **retracts** the warning.

**Proposed behavior (worker w08, currently DISABLED):** when a patient assertion of an
enzyme-inducer concept is historical/negated while a hormonal product is active or
planned, emit an advisory finding that quotes the record's verbatim persistence
sentence and asks exactly when the medication was stopped. It creates **no warning**,
changes **no assertion**, and never alters the result state — it only asks the timing
question the records make relevant.

The worker stays off until you approve it (`FLEET_WASHOUT_SENTINEL=true`, development
only; forced off in production). A stronger behavior (keeping the warning active inside
a stated 28-day window) would need your explicit sign-off on wording and logic first.

- [ ] Advisory washout-window finding approved (enable the worker)
- [ ] OR: stronger behavior desired (specify) 
- [ ] OR: rejected (worker stays disabled)
