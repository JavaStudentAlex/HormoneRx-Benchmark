import { useState } from 'react';
import { Badge, cn } from '../ui/primitives';
import type { FleetFinding, FleetWorkerStatus } from '../../lib/backendClient';

export interface FleetSummary {
  total_workers: number;
  running_workers: number;
  healthy_workers: number;
  findings_total: number;
  review_queue_size: number;
}

const severityTone: Record<FleetFinding['severity'], 'danger' | 'amber' | 'muted'> = {
  alert: 'danger',
  attention: 'amber',
  info: 'muted',
};

/**
 * Live view of the always-running agent fleet: health summary, the latest
 * findings (clarification requests, escalations, integrity checks), and the
 * worker roster. Findings can carry medical wording only as verbatim quotes
 * from evidence records; everything else is workflow language.
 */
export default function FleetPanel({
  summary,
  findings,
  workers,
}: {
  summary: FleetSummary | null;
  findings: FleetFinding[];
  workers: FleetWorkerStatus[];
}) {
  const [showRoster, setShowRoster] = useState(false);

  if (!summary) {
    return (
      <p className="text-sm text-ink-muted">
        Fleet status not available yet — it appears once the backend connection is up.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={summary.healthy_workers === summary.running_workers ? 'teal' : 'amber'}>
          {summary.healthy_workers}/{summary.running_workers} workers healthy
        </Badge>
        <Badge tone="muted">{summary.total_workers} registered</Badge>
        {summary.review_queue_size > 0 && (
          <Badge tone="amber">{summary.review_queue_size} item(s) queued for physician review</Badge>
        )}
        <button
          onClick={() => setShowRoster((v) => !v)}
          className="ml-auto text-[11px] font-medium text-teal hover:underline"
        >
          {showRoster ? 'Hide roster' : 'Show roster'}
        </button>
      </div>

      {showRoster && (
        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line bg-canvas p-2">
          {workers.map((w) => (
            <li key={w.id} className="flex items-baseline gap-2 text-[11px]" title={w.description}>
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full',
                  w.status === 'disabled'
                    ? 'bg-ink-faint'
                    : w.status === 'failed'
                      ? 'bg-danger'
                      : w.status === 'degraded'
                        ? 'bg-amber'
                        : 'bg-teal',
                )}
              />
              <span className="font-medium text-navy">{w.name}</span>
              <span className="text-ink-faint">
                tier {w.tier} · {w.cadence}
                {w.agentic ? ' · live agent' : ''} · {w.status}
                {w.status === 'disabled' && w.disabled_reason ? ` — ${w.disabled_reason.split('.')[0]}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {findings.length === 0 ? (
        <p className="text-xs text-ink-muted">No fleet findings yet for this encounter.</p>
      ) : (
        <ul className="space-y-1.5" aria-label="Fleet findings">
          {findings.map((f) => (
            <li key={f.finding_id} className="rounded-lg border border-line bg-surface p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={severityTone[f.severity]} className="text-[10px]">
                  {f.severity}
                </Badge>
                <span className="text-[11px] font-medium text-navy">{f.worker_name}</span>
                <span className="text-[10px] text-ink-faint">{f.kind}</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-navy-soft">{f.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
