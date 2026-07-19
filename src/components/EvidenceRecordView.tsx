import type { EvidenceRecord } from '../lib/types';
import { Badge } from './ui/primitives';

// Renders ONLY fields loaded from an evidence record. No generated content.
export default function EvidenceRecordView({ record }: { record: EvidenceRecord }) {
  return (
    <div className="rounded-lg border border-teal/30 bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="navy">{record.id}</Badge>
        <Badge tone={record.physicianVerified ? 'teal' : 'amber'}>
          {record.physicianVerified ? 'Physician-verified' : 'Verification pending'}
        </Badge>
        <Badge tone="muted">{record.evidenceLevel}</Badge>
      </div>

      <dl className="mt-3 space-y-2.5 text-sm">
        <Field label="Hormonal product">{record.hormonalProduct}</Field>
        <Field label="Interacting medication">{record.interactingMedication}</Field>
        <Field label="Interaction direction">{record.interactionDirection}</Field>
        <Field label="Potential consequence (from source)">{record.potentialConsequence}</Field>
        <Field label="Clinician consideration">{record.clinicianConsideration}</Field>
        <Field label="Population">{record.population}</Field>
        <Field label="Limitations">{record.limitations}</Field>
      </dl>

      <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Source</div>
        <div className="mt-1 text-sm font-medium text-navy">{record.sourceTitle}</div>
        <div className="text-xs text-ink-muted">{record.sourceOrganization} · {record.jurisdiction}</div>
        <div className="mt-1 text-xs text-navy-soft">Section: {record.sourceSection}</div>
        <a
          href={record.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block break-all text-xs font-medium text-teal underline"
        >
          {record.sourceUrl}
        </a>
        <div className="mt-1 text-[11px] text-ink-faint">Last verified: {record.lastVerified}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 leading-relaxed text-navy-soft">{children}</dd>
    </div>
  );
}
