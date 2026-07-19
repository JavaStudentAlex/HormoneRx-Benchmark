import { useState } from 'react';
import { Card, CardBody, CardHeader, CardTitle, Button, Badge, cn } from '../components/ui/primitives';
import { analyze, getDemoCases } from '../lib/pipeline';
import { useMode } from '../lib/useMode';
import type { PipelineResult, ExtractedEntity } from '../lib/types';
import EvidenceRecordView from '../components/EvidenceRecordView';

const demoCases = getDemoCases();

export default function AnalyzeCase() {
  const { mode } = useMode();
  const [text, setText] = useState('');
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  async function runAnalyze(input: string) {
    const value = input.trim();
    if (!value) return;
    setBusy(true);
    setLiveError(null);
    try {
      const r = await analyze(value, mode);
      setResult(r);
      if (r.state === 'ERROR' && mode === 'live') {
        setLiveError('Live mode requires a configured server-side extraction endpoint (/api/extract). Falling back is disabled; use Demo mode for the offline demonstration.');
      }
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setText('');
    setResult(null);
    setLiveError(null);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-navy">Text Analysis</h1>
        <p className="mt-2 max-w-3xl text-sm text-navy-soft">
          Paste a synthetic consultation snippet, or load one of the five scripted sample cases. The model extracts
          only structured context; the result is produced by deterministic lookup in the evidence dataset. This page
          works fully offline — no backend or API key needed.
        </p>
        <div className="mt-2">
          <Badge tone={mode === 'demo' ? 'teal' : 'amber'}>{mode === 'demo' ? 'Demo mode (no API key required)' : 'Live mode (server-side model)'}</Badge>
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Sample cases (synthetic)</div>
        <div className="flex flex-wrap gap-2">
          {demoCases.map((c) => (
            <Button
              key={c.id}
              variant="secondary"
              onClick={() => {
                setText(c.text);
                runAnalyze(c.text);
              }}
            >
              {c.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Panel 1: Input */}
        <Card>
          <CardHeader><CardTitle>1 · Consultation input</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <label htmlFor="consult" className="sr-only">Consultation text</label>
            <textarea
              id="consult"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder="e.g. The patient currently takes a combined oral contraceptive and carbamazepine."
              className="w-full resize-y rounded-lg border border-line bg-canvas p-3 text-sm text-navy placeholder:text-ink-faint focus:border-teal"
            />
            <div className="flex gap-2">
              <Button onClick={() => runAnalyze(text)} disabled={busy || !text.trim()}>
                {busy ? 'Analyzing…' : 'Analyze'}
              </Button>
              <Button variant="ghost" onClick={reset} disabled={busy}>Reset</Button>
            </div>
            <p className="text-[11px] text-ink-faint">Synthetic input only. Do not enter real patient data.</p>
          </CardBody>
        </Card>

        {/* Panel 2: Structured extraction */}
        <Card>
          <CardHeader><CardTitle>2 · Structured extraction</CardTitle></CardHeader>
          <CardBody>
            {result ? <ExtractionView result={result} /> : <Empty>Run an analysis to see the extracted structure.</Empty>}
          </CardBody>
        </Card>

        {/* Panel 3: Deterministic result */}
        <Card>
          <CardHeader><CardTitle>3 · Deterministic result</CardTitle></CardHeader>
          <CardBody>
            {liveError && <p className="mb-3 rounded-lg border border-amber/30 bg-amber/10 p-3 text-xs text-amber">{liveError}</p>}
            {result ? <ResultView result={result} /> : <Empty>The retrieval decision and any matched record appear here.</Empty>}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ink-faint">{children}</p>;
}

function EntityRow({ label, entity }: { label: string; entity: ExtractedEntity }) {
  const statusTone =
    entity.status === 'current' ? 'teal' :
    entity.status === 'negated' || entity.status === 'other_person' ? 'muted' :
    entity.status === 'historical' ? 'muted' :
    entity.status ? 'amber' : 'muted';
  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-1 text-sm font-medium text-navy">{entity.normalized ?? entity.raw ?? '— not identified —'}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {entity.status && <Badge tone={statusTone as any}>{entity.status}</Badge>}
        {entity.raw && entity.normalized && entity.raw.toLowerCase() !== entity.normalized.toLowerCase() && (
          <span className="text-[11px] text-ink-faint">from “{entity.raw}”</span>
        )}
      </div>
      {entity.sourceSpan && (
        <div className="mt-2 text-[11px] text-ink-muted">
          Source span: <span className="rounded bg-teal/10 px-1 py-0.5 font-mono text-teal">{entity.sourceSpan}</span>
        </div>
      )}
    </div>
  );
}

function ExtractionView({ result }: { result: PipelineResult }) {
  const e = result.extraction;
  return (
    <div className="space-y-3">
      <EntityRow label="Hormonal product" entity={e.hormonalProduct} />
      <EntityRow label="Other medication" entity={e.otherMedication} />
      <div className="rounded-lg border border-line p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Lookup decision</div>
        <div className="mt-1 text-sm text-navy">
          {e.shouldSearchEvidence ? 'Run deterministic lookup' : 'Withhold lookup'}
        </div>
        <p className="mt-1 text-[11px] text-ink-muted">{e.reason}</p>
      </div>
      {e.missingInformation.length > 0 && (
        <div className="rounded-lg border border-amber/30 bg-amber/10 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber">Missing information</div>
          <ul className="mt-1 list-disc pl-4 text-xs text-navy-soft">
            {e.missingInformation.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

const stateMeta: Record<string, { label: string; tone: 'teal' | 'amber' | 'muted' | 'danger'; border: string }> = {
  EVIDENCE_FOUND: { label: 'Evidence found', tone: 'teal', border: 'border-teal/40 bg-teal/5' },
  NO_VALIDATED_MATCH: { label: 'No validated match', tone: 'muted', border: 'border-line bg-canvas' },
  MORE_INFORMATION_REQUIRED: { label: 'More information required', tone: 'amber', border: 'border-amber/40 bg-amber/5' },
  EXCLUDED_CONTEXT: { label: 'Excluded context', tone: 'muted', border: 'border-line bg-canvas' },
  ERROR: { label: 'Error', tone: 'danger', border: 'border-danger/40 bg-danger/5' },
};

function ResultView({ result }: { result: PipelineResult }) {
  const meta = stateMeta[result.state];
  return (
    <div className="space-y-3">
      <div className={cn('rounded-lg border p-3', meta.border)}>
        <div className="flex items-center justify-between">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <span className="font-mono text-[11px] text-ink-faint">{result.state}</span>
        </div>
        <p className="mt-2 text-xs text-navy-soft">{result.lookupReason}</p>
      </div>

      {result.messages.map((msg) => (
        <p key={msg} className="text-sm text-navy-soft">{msg}</p>
      ))}

      {result.missingInformation.length > 0 && result.state === 'MORE_INFORMATION_REQUIRED' && (
        <div className="rounded-lg border border-amber/30 bg-amber/10 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber">What is needed</div>
          <ul className="mt-1 list-disc pl-4 text-xs text-navy-soft">
            {result.missingInformation.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}

      {result.state === 'EVIDENCE_FOUND' && result.matchedRecord && (
        <EvidenceRecordView record={result.matchedRecord} />
      )}
    </div>
  );
}
