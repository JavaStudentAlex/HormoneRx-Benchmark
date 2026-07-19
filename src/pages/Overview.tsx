import { Link } from 'react-router-dom';
import { Card, CardBody, CardHeader, CardTitle, Stat, Badge, Button } from '../components/ui/primitives';
import ArchitectureDiagram from '../components/ArchitectureDiagram';
import { evidenceRecords } from '../lib/evidence';
import benchmarkCases from '../data/benchmark_cases.json';
import benchmarkResults from '../data/benchmark_results.json';

const PROJECT_STATEMENT =
  'An open evidence dataset and benchmark for testing whether AI systems can recognize hormonal medication context and retrieve verified interaction evidence without generating unsupported clinical advice.';

export default function Overview() {
  const recordCount = evidenceRecords.length;
  const verifiedCount = evidenceRecords.filter((r) => r.physicianVerified).length;
  const caseCount = (benchmarkCases as { cases: unknown[] }).cases.length;
  const m = (benchmarkResults as any).metrics;
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight text-navy">Overview</h1>
        <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-navy-soft">{PROJECT_STATEMENT}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link to="/analyze"><Button>Analyze a case</Button></Link>
          <Link to="/evidence"><Button variant="secondary">Browse evidence library</Button></Link>
          <Link to="/benchmark"><Button variant="secondary">See benchmark results</Button></Link>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Evidence records" value={recordCount} hint={`${verifiedCount} physician-verified`} />
        <Stat label="Benchmark cases" value={caseCount} tone="teal" hint="synthetic, gold-labelled" />
        <Stat label="Benchmark pass rate" value={pct(m.passRate)} tone="teal" hint="deterministic demo pipeline" />
        <Stat label="Citation coverage" value={pct(m.citationCoverage)} tone="teal" hint="of expected matches" />
      </section>

      <section>
        <Card>
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Pipeline architecture</CardTitle>
            <Badge tone="muted">deterministic retrieval</Badge>
          </CardHeader>
          <CardBody>
            <ArchitectureDiagram />
          </CardBody>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>What this is</CardTitle></CardHeader>
          <CardBody className="space-y-3 text-sm leading-relaxed text-navy-soft">
            <p>
              The reusable contribution is the dataset, benchmark, and evaluation pipeline — not the interface.
              Six source-linked evidence records cover interactions between hormonal contraceptives and hepatic
              enzyme inducers, plus the reversed-direction lamotrigine interaction.
            </p>
            <p>
              A synthetic benchmark of {caseCount} labelled consultation snippets tests whether a system recognizes
              hormonal context, handles negation and temporality, retrieves the correct record, and abstains when it
              should.
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>What it does not do</CardTitle></CardHeader>
          <CardBody className="space-y-3 text-sm leading-relaxed text-navy-soft">
            <p>
              No diagnosis, no dosing, no treatment recommendations, and no autonomous prescribing. The model may
              only extract structured context. Every visible medical statement is loaded verbatim from a cited
              evidence record.
            </p>
            <p className="text-ink-muted">
              The prototype dataset is intentionally narrow. Absence of a record must not be interpreted as absence
              of an interaction.
            </p>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
