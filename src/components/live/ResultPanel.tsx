import { useState } from 'react';
import { Badge, cn } from '../ui/primitives';
import EvidenceRecordView from '../EvidenceRecordView';
import type { EvidenceRecord } from '../../lib/types';
import type { BackendAssertion, BackendResult, BackendTurn, BackendWarning } from '../../lib/backendClient';

export const stateMeta: Record<string, { label: string; tone: 'teal' | 'amber' | 'muted' | 'danger' | 'navy'; border: string }> = {
  LISTENING: { label: 'Listening', tone: 'muted', border: 'border-line bg-canvas' },
  PROCESSING: { label: 'Processing', tone: 'muted', border: 'border-line bg-canvas' },
  EVIDENCE_FOUND: { label: 'Potentially relevant evidence found', tone: 'amber', border: 'border-amber/40 bg-amber/5' },
  NO_VALIDATED_MATCH: { label: 'No record in the current prototype dataset', tone: 'muted', border: 'border-line bg-canvas' },
  MORE_INFORMATION_REQUIRED: { label: 'More information required', tone: 'amber', border: 'border-amber/40 bg-amber/5' },
  EXCLUDED_CONTEXT: { label: 'Excluded context', tone: 'muted', border: 'border-line bg-canvas' },
  RETRACTED: { label: 'Warning retracted after correction', tone: 'navy', border: 'border-navy/30 bg-canvas' },
  PROCESSING_ERROR: { label: 'Processing error', tone: 'danger', border: 'border-danger/40 bg-danger/5' },
};

function ProvenanceChain({
  warning,
  assertions,
  turns,
  onFocusTurn,
}: {
  warning: BackendWarning;
  assertions: BackendAssertion[];
  turns: BackendTurn[];
  onFocusTurn: (turnId: string) => void;
}) {
  const byId = new Map(assertions.map((a) => [a.assertion_id, a]));
  const turnById = new Map(turns.map((t) => [t.turn_id, t]));
  return (
    <div className="mt-2 rounded-lg border border-line bg-canvas p-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Provenance</div>
      <ul className="mt-1 space-y-1 text-xs text-navy-soft">
        <li>
          → Evidence record <span className="font-mono">{warning.evidence_record_id}</span>
        </li>
        {warning.trigger_assertion_ids.map((assertionId) => {
          const assertion = byId.get(assertionId);
          const turn = assertion ? turnById.get(assertion.source_turn_id) : undefined;
          return (
            <li key={assertionId}>
              → Trigger <span className="font-mono">{assertionId}</span>
              {assertion && (
                <>
                  : {assertion.subject} {assertion.predicate.toLowerCase().replaceAll('_', ' ')} {assertion.canonical_name}
                  {turn ? (
                    <>
                      {' '}
                      · from{' '}
                      <button className="font-mono underline decoration-dotted hover:text-teal" onClick={() => onFocusTurn(turn.turn_id)}>
                        {turn.turn_id}
                      </button>{' '}
                      “{turn.text}”
                    </>
                  ) : (
                    <> · from {assertion.source_turn_id}</>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WarningCard({
  warning,
  assertions,
  turns,
  onFocusTurn,
}: {
  warning: BackendWarning;
  assertions: BackendAssertion[];
  turns: BackendTurn[];
  onFocusTurn: (turnId: string) => void;
}) {
  const record = warning.evidence_record as unknown as EvidenceRecord;
  return (
    <div className="rounded-lg border border-amber/40 bg-amber/5 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="amber">{warning.display_label}</Badge>
        <Badge tone="muted">{warning.context === 'proposed_combination' ? 'proposed combination' : 'current combination'}</Badge>
        {warning.verification_status === 'physician_sign_off_pending' && (
          <Badge tone="danger">physician sign-off pending</Badge>
        )}
      </div>
      <div className="mt-3">
        <EvidenceRecordView record={record} />
      </div>
      <ProvenanceChain warning={warning} assertions={assertions} turns={turns} onFocusTurn={onFocusTurn} />
    </div>
  );
}

export default function ResultPanel({
  result,
  assertions,
  turns,
  onFocusTurn,
  processing = false,
}: {
  result: BackendResult | null;
  assertions: BackendAssertion[];
  turns: BackendTurn[];
  onFocusTurn: (turnId: string) => void;
  processing?: boolean;
}) {
  const [showHistory, setShowHistory] = useState(true);
  if (!result) {
    return <p className="text-sm text-ink-faint">Start a session to see the evidence relevance check.</p>;
  }
  const meta = stateMeta[result.state] ?? stateMeta.PROCESSING;
  const history = result.warning_history ?? [];

  return (
    <div className="space-y-3">
      {processing && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-line bg-canvas px-3 py-1.5 text-xs text-ink-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-teal" />
          Analyzing finalized turn…
        </div>
      )}
      <div className={cn('rounded-lg border p-3', meta.border)}>
        <div className="flex items-center justify-between gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <span className="font-mono text-[11px] text-ink-faint">{result.state}</span>
        </div>
        <p className="mt-2 text-xs text-navy-soft">{result.lookup_reason}</p>
        {result.latency_ms && (
          <p className="mt-1 text-[11px] text-ink-faint">Backend processing: {result.latency_ms.total_ms} ms</p>
        )}
      </div>

      {result.messages.map((message) => (
        <p key={message} className="text-sm text-navy-soft">
          {message}
        </p>
      ))}

      {result.missing_information.length > 0 && (
        <div className="rounded-lg border border-amber/30 bg-amber/10 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber">More information required</div>
          <ul className="mt-1 list-disc pl-4 text-xs text-navy-soft">
            {result.missing_information.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {result.excluded_notes.length > 0 && (
        <div className="rounded-lg border border-line bg-canvas p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Excluded context</div>
          <ul className="mt-1 list-disc pl-4 text-xs text-navy-soft">
            {result.excluded_notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {(result.conflict_notes ?? []).length > 0 && (
        <div className="rounded-lg border border-navy/30 bg-canvas p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-navy">
            Contradictions resolved by later statements
          </div>
          <ul className="mt-1 list-disc pl-4 text-xs text-navy-soft">
            {result.conflict_notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {result.active_warnings.map((warning) => (
        <WarningCard key={warning.warning_id} warning={warning} assertions={assertions} turns={turns} onFocusTurn={onFocusTurn} />
      ))}

      {history.length > 0 && (
        <div>
          <button className="text-xs font-medium text-teal underline decoration-dotted" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide' : 'Show'} warning history ({history.length})
          </button>
          {showHistory && (
            <div className="mt-2 space-y-2">
              {history.map((warning) => {
                const turn = turns.find((t) => t.turn_id === warning.retracted_by_turn_id);
                return (
                  <div key={warning.warning_id} className="rounded-lg border border-line bg-canvas p-3 opacity-80">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="navy">Retracted</Badge>
                      <span className="font-mono text-xs text-ink-muted">{warning.evidence_record_id}</span>
                      <Badge tone="muted">{warning.context === 'proposed_combination' ? 'proposed' : 'current'}</Badge>
                    </div>
                    <p className="mt-1.5 text-xs text-navy-soft">
                      <span className="font-semibold">Why:</span> {warning.retraction_reason}
                    </p>
                    {turn && (
                      <p className="mt-1 text-xs text-ink-muted">
                        Correcting turn{' '}
                        <button className="font-mono underline decoration-dotted hover:text-teal" onClick={() => onFocusTurn(turn.turn_id)}>
                          {turn.turn_id}
                        </button>
                        : “{turn.text}”
                      </p>
                    )}
                    {warning.retracted_at && <p className="mt-1 text-[11px] text-ink-faint">at {warning.retracted_at}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-ink-faint">
        Research prototype. Not medical advice. This panel never shows a green “safe” state: absence of a record does
        not establish that no interaction exists.
      </p>
    </div>
  );
}
