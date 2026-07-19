import { Card, CardBody, CardHeader, CardTitle, Badge } from '../components/ui/primitives';
import { DISCLAIMER } from '../lib/pipeline';

export default function About() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-navy">About</h1>
        <p className="mt-2 max-w-3xl text-sm text-navy-soft">
          HormoneRx Benchmark is a prototype infrastructure layer: a source-linked evidence dataset, a synthetic
          consultation benchmark with gold labels, and a reproducible evaluation pipeline. The web app only
          demonstrates the dataset and benchmark.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Safety boundary</CardTitle></CardHeader>
        <CardBody className="space-y-3 text-sm leading-relaxed text-navy-soft">
          <p>
            The language model may only extract structured context: hormonal product, other medication, normalized
            names, status (current, historical, planned, negated, uncertain), explicitly stated dose or route, missing
            information, and whether a lookup should run.
          </p>
          <p>
            The model never generates interactions, consequences, mechanisms, evidence levels, citations, severity, or
            any treatment or dosing advice. Every visible medical statement is loaded verbatim from a cited evidence
            record. The app never displays a green “safe” state and never claims that no interaction exists.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Sources</CardTitle></CardHeader>
        <CardBody className="space-y-2 text-sm text-navy-soft">
          <ul className="list-disc space-y-1 pl-5">
            <li>FSRH CEU Guidance: Drug Interactions with Hormonal Contraception (May 2022).</li>
            <li>U.S. Medical Eligibility Criteria for Contraceptive Use, 2024 (CDC).</li>
            <li>LAMICTAL (lamotrigine) FDA Prescribing Information (Revised 10/2025).</li>
            <li>MHRA Drug Safety Update: levonorgestrel emergency contraception and hepatic enzyme inducers (Sept 2016).</li>
          </ul>
          <p className="text-xs text-ink-muted">Exact section references are stored per record in the evidence dataset.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Modes</CardTitle></CardHeader>
        <CardBody className="space-y-2 text-sm text-navy-soft">
          <p><Badge tone="teal">Demo mode</Badge> uses a deterministic, cached extractor and works with no API key.</p>
          <p><Badge tone="amber">Live mode</Badge> calls a server-side extraction endpoint; model and key are read only from
          environment variables and never exposed to the browser.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Limitations</CardTitle></CardHeader>
        <CardBody>
          <ul className="list-disc space-y-1 pl-5 text-sm text-navy-soft">
            <li>Small prototype evidence dataset (six records); not comprehensive.</li>
            <li>Synthetic benchmark with manually curated gold labels; no clinical validation.</li>
            <li>Benchmark performance does not establish clinical safety.</li>
            <li>Absence of a record is not evidence of absence of an interaction.</li>
            <li>No treatment, dosing, or prescribing recommendations.</li>
          </ul>
        </CardBody>
      </Card>

      <p className="rounded-lg border border-amber/30 bg-amber/10 p-3 text-xs leading-relaxed text-navy-soft">
        <span className="font-semibold text-navy">Disclaimer.</span> {DISCLAIMER}
      </p>
    </div>
  );
}
