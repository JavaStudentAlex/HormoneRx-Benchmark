import { useMemo, useState } from 'react';
import { Card, CardBody, Button, Badge, cn } from '../components/ui/primitives';
import EvidenceRecordView from '../components/EvidenceRecordView';
import { evidenceRecords } from '../lib/evidence';
import { recordsToCsv, recordsToJson, downloadText } from '../lib/exportUtils';
import type { EvidenceRecord } from '../lib/types';

export default function EvidenceLibrary() {
  const [query, setQuery] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [selected, setSelected] = useState<EvidenceRecord | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return evidenceRecords.filter((r) => {
      if (verifiedOnly && !r.physicianVerified) return false;
      if (!q) return true;
      const hay = [
        r.id, r.hormonalProduct, r.interactingMedication, r.interactionDirection,
        r.potentialConsequence, r.evidenceLevel, r.sourceOrganization, r.sourceTitle,
        ...r.hormonalSynonyms, ...r.medicationSynonyms,
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [query, verifiedOnly]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-navy">Evidence Library</h1>
        <p className="mt-2 max-w-3xl text-sm text-navy-soft">
          The curated, source-linked evidence dataset. Records are read-only in the app; the file
          <span className="font-mono text-xs"> backend/data/evidence_records.json </span>
          is the single source of truth.
        </p>
        <p className="mt-2 max-w-3xl rounded-lg border border-amber/30 bg-amber/10 p-3 text-sm text-navy-soft">
          The prototype dataset is intentionally narrow. Absence of a record must not be interpreted as absence of an
          interaction.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search product, medication, source…"
          aria-label="Search evidence records"
          className="w-full max-w-sm rounded-lg border border-line bg-surface px-3 py-2 text-sm text-navy placeholder:text-ink-faint focus:border-teal"
        />
        <label className="flex items-center gap-2 text-sm text-navy-soft">
          <input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} className="accent-teal" />
          Physician-verified only
        </label>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => downloadText('evidence_records.csv', recordsToCsv(filtered), 'text/csv')}>
            Export CSV
          </Button>
          <Button variant="secondary" onClick={() => downloadText('evidence_records.json', recordsToJson(filtered), 'application/json')}>
            Export JSON
          </Button>
        </div>
      </div>

      <Card>
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas text-left text-xs uppercase tracking-wide text-ink-muted">
                <Th>ID</Th>
                <Th>Hormonal product</Th>
                <Th>Interacting medication</Th>
                <Th>Direction</Th>
                <Th>Evidence level</Th>
                <Th>Source</Th>
                <Th>Last verified</Th>
                <Th>Verified</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-line align-top hover:bg-canvas/60">
                  <Td className="font-mono text-xs">{r.id}</Td>
                  <Td>{r.hormonalProduct}</Td>
                  <Td>{r.interactingMedication}</Td>
                  <Td className="text-xs text-ink-muted">{r.interactionDirection}</Td>
                  <Td className="text-xs">{r.evidenceLevel}</Td>
                  <Td className="text-xs">{r.sourceOrganization}</Td>
                  <Td className="text-xs tabular-nums">{r.lastVerified}</Td>
                  <Td>
                    <Badge tone={r.physicianVerified ? 'teal' : 'amber'}>{r.physicianVerified ? 'Yes' : 'Pending'}</Badge>
                  </Td>
                  <Td>
                    <Button variant="ghost" onClick={() => setSelected(r)}>Details</Button>
                  </Td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><Td className="text-ink-faint" colSpan={9}>No records match the current filter.</Td></tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {selected && <DetailDrawer record={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-4 py-2.5 font-semibold">{children}</th>;
}
function Td({ children, className, colSpan }: { children: React.ReactNode; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={cn('px-4 py-3', className)}>{children}</td>;
}

function DetailDrawer({ record, onClose }: { record: EvidenceRecord; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Evidence record ${record.id}`}>
      <div className="absolute inset-0 bg-navy/30" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 h-full w-full max-w-lg overflow-y-auto border-l border-line bg-canvas p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-navy">Record {record.id}</h2>
          <Button variant="secondary" onClick={onClose} aria-label="Close details">Close</Button>
        </div>
        <EvidenceRecordView record={record} />
        <div className="mt-4 rounded-lg border border-line bg-surface p-3 text-xs text-ink-muted">
          <div className="font-semibold text-navy">Synonyms (for normalization)</div>
          <p className="mt-1"><span className="font-medium">Hormonal:</span> {record.hormonalSynonyms.join(', ')}</p>
          <p className="mt-1"><span className="font-medium">Medication:</span> {record.medicationSynonyms.join(', ')}</p>
        </div>
      </div>
    </div>
  );
}
