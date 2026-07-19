import { useState } from 'react';
import { Badge, Button, cn } from '../ui/primitives';
import type { BackendAssertion, BackendProposal } from '../../lib/backendClient';

const predicateLabel: Record<string, string> = {
  CURRENTLY_USES: 'currently uses',
  CURRENTLY_TAKES: 'currently takes',
  HISTORICALLY_USED: 'historically used',
  PLANS_TO_TAKE: 'plans to take',
  NEGATED_USE_OF: 'negated use of',
};

const statusTone = (assertion: BackendAssertion): 'teal' | 'amber' | 'muted' =>
  assertion.status === 'current' ? 'teal' : assertion.status === 'planned' ? 'amber' : 'muted';

function AssertionRow({
  assertion,
  onFocusTurn,
  dimmed,
}: {
  assertion: BackendAssertion;
  onFocusTurn: (turnId: string) => void;
  dimmed?: boolean;
}) {
  return (
    <div className={cn('rounded-lg border border-line bg-canvas p-2.5', dimmed && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <Badge tone="navy">{assertion.subject}</Badge>
        <span className="text-xs text-ink-muted">{predicateLabel[assertion.predicate] ?? assertion.predicate}</span>
        <span className="font-medium text-navy">{assertion.canonical_name}</span>
        <Badge tone={statusTone(assertion)}>{assertion.status}</Badge>
        {assertion.origin === 'ui_proposal' && <Badge tone="amber">UI proposal</Badge>}
        {!assertion.is_active && <Badge tone="muted">superseded</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
        <button className="font-mono underline decoration-dotted hover:text-teal" onClick={() => onFocusTurn(assertion.source_turn_id)}>
          source: {assertion.source_turn_id}
        </button>
        {assertion.supersedes_assertion_id && <span>supersedes {assertion.supersedes_assertion_id}</span>}
        {assertion.superseded_by_assertion_id && <span>superseded by {assertion.superseded_by_assertion_id}</span>}
      </div>
    </div>
  );
}

export default function GraphPanel({
  active,
  inactive,
  proposals,
  onFocusTurn,
  onCancelProposal,
}: {
  active: BackendAssertion[];
  inactive: BackendAssertion[];
  proposals: BackendProposal[];
  onFocusTurn: (turnId: string) => void;
  onCancelProposal: (proposalId: string) => void;
}) {
  const [showAudit, setShowAudit] = useState(false);
  const patient = active.filter((a) => a.subject === 'patient');
  const others = active.filter((a) => a.subject !== 'patient');

  return (
    <div className="space-y-3">
      {active.length === 0 && (
        <p className="text-sm text-ink-faint">
          The encounter medication graph is empty. Assertions appear here after each relevant finalized turn, each
          linked to its source turn.
        </p>
      )}
      {patient.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Patient</div>
          <div className="space-y-2">
            {patient.map((a) => (
              <AssertionRow key={a.assertion_id} assertion={a} onFocusTurn={onFocusTurn} />
            ))}
          </div>
        </div>
      )}
      {others.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Other subjects (never used for patient matching)
          </div>
          <div className="space-y-2">
            {others.map((a) => (
              <AssertionRow key={a.assertion_id} assertion={a} onFocusTurn={onFocusTurn} />
            ))}
          </div>
        </div>
      )}
      {proposals.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Proposed prescriptions</div>
          <div className="space-y-2">
            {proposals.map((p) => (
              <div key={p.proposal_id} className="flex items-center justify-between rounded-lg border border-line bg-canvas p-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-navy">{p.canonical_name ?? p.surface_text}</span>
                  <Badge tone={p.status === 'cancelled' ? 'muted' : 'amber'}>{p.status}</Badge>
                </div>
                {p.status !== 'cancelled' && (
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => onCancelProposal(p.proposal_id)}>
                    Cancel
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div>
        <button className="text-xs font-medium text-teal underline decoration-dotted" onClick={() => setShowAudit((v) => !v)}>
          {showAudit ? 'Hide' : 'Show'} superseded / inactive assertions ({inactive.length})
        </button>
        {showAudit && (
          <div className="mt-2 space-y-2">
            {inactive.length === 0 && <p className="text-xs text-ink-faint">Nothing superseded yet.</p>}
            {inactive.map((a) => (
              <AssertionRow key={a.assertion_id} assertion={a} onFocusTurn={onFocusTurn} dimmed />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
