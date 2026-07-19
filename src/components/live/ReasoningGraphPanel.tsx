import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../ui/primitives';
import { stateMeta } from './ResultPanel';
import type { BackendAssertion, BackendResult, BackendTurn, BackendWarning } from '../../lib/backendClient';

// ---------------------------------------------------------------------------
// Graph model (pure — derived entirely from state the page already holds)
// ---------------------------------------------------------------------------

type NodeKind = 'turn' | 'fact' | 'warning' | 'state';
type EdgeKind = 'derives' | 'triggers' | 'supersedes' | 'retracts';

interface RGNode {
  id: string;
  kind: NodeKind;
  label: string;
  sublabel?: string;
  title?: string;
  dimmed?: boolean;
  retracted?: boolean;
  stateKey?: string;
  focusTurnId?: string;
}

interface RGEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export function buildReasoningGraph(
  turns: BackendTurn[],
  assertions: BackendAssertion[],
  result: BackendResult | null,
): { columns: [RGNode[], RGNode[], RGNode[]]; edges: RGEdge[] } {
  const assertionById = new Map(assertions.map((a) => [a.assertion_id, a]));

  // Warnings: active wins over its own history entry.
  const warnings = new Map<string, BackendWarning>();
  for (const w of result?.warning_history ?? []) warnings.set(w.warning_id, w);
  for (const w of result?.active_warnings ?? []) warnings.set(w.warning_id, w);

  // Column 1: only turns that ground a fact or retract a warning.
  const referencedTurnIds = new Set<string>();
  for (const a of assertions) referencedTurnIds.add(a.source_turn_id);
  for (const w of warnings.values()) {
    if (w.retracted_by_turn_id) referencedTurnIds.add(w.retracted_by_turn_id);
  }
  const turnNodes: RGNode[] = turns
    .filter((t) => referencedTurnIds.has(t.turn_id))
    .sort((a, b) => a.sequence - b.sequence)
    .map((t) => ({
      id: `t:${t.turn_id}`,
      kind: 'turn',
      label: t.text.length > 70 ? `${t.text.slice(0, 70)}…` : t.text,
      sublabel: `${t.speaker.replaceAll('_', ' ')} · ${t.turn_id}`,
      title: t.text,
      focusTurnId: t.turn_id,
    }));
  const turnIndex = new Map(turnNodes.map((n, i) => [n.id, i]));

  // Column 2: every assertion; superseded ones stay visible but dimmed.
  const factNodes: RGNode[] = [...assertions]
    .sort((a, b) => {
      const ia = turnIndex.get(`t:${a.source_turn_id}`) ?? Number.MAX_SAFE_INTEGER;
      const ib = turnIndex.get(`t:${b.source_turn_id}`) ?? Number.MAX_SAFE_INTEGER;
      return ia - ib || a.assertion_id.localeCompare(b.assertion_id);
    })
    .map((a) => ({
      id: `a:${a.assertion_id}`,
      kind: 'fact',
      label: a.canonical_name,
      sublabel: `${a.subject} · ${a.predicate.toLowerCase().replaceAll('_', ' ')} · ${a.status}`,
      title: `${a.assertion_id} (${a.certainty})`,
      dimmed: !a.is_active,
      focusTurnId: a.source_turn_id,
    }));

  // Column 3: overall result state first, then warnings (retracted ones last).
  const evidenceNodes: RGNode[] = [];
  if (result) {
    evidenceNodes.push({
      id: 'state',
      kind: 'state',
      label: (stateMeta[result.state] ?? stateMeta.PROCESSING).label,
      sublabel: result.state,
      stateKey: result.state,
    });
  }
  const sortedWarnings = [...warnings.values()].sort(
    (a, b) =>
      Number(a.state === 'retracted') - Number(b.state === 'retracted') ||
      a.created_at.localeCompare(b.created_at),
  );
  for (const w of sortedWarnings) {
    const firstTrigger = w.trigger_assertion_ids.map((id) => assertionById.get(id)).find(Boolean);
    evidenceNodes.push({
      id: `w:${w.warning_id}`,
      kind: 'warning',
      label: w.display_label,
      sublabel: w.evidence_record_id,
      title: w.state === 'retracted' ? (w.retraction_reason ?? undefined) : undefined,
      retracted: w.state === 'retracted',
      focusTurnId:
        w.state === 'retracted' && w.retracted_by_turn_id
          ? w.retracted_by_turn_id
          : firstTrigger?.source_turn_id,
    });
  }

  const edges: RGEdge[] = [];
  for (const a of assertions) {
    if (turnIndex.has(`t:${a.source_turn_id}`)) {
      edges.push({ from: `t:${a.source_turn_id}`, to: `a:${a.assertion_id}`, kind: 'derives' });
    }
    if (a.superseded_by_assertion_id && assertionById.has(a.superseded_by_assertion_id)) {
      edges.push({ from: `a:${a.assertion_id}`, to: `a:${a.superseded_by_assertion_id}`, kind: 'supersedes' });
    }
  }
  for (const w of warnings.values()) {
    for (const assertionId of w.trigger_assertion_ids) {
      if (assertionById.has(assertionId)) {
        edges.push({ from: `a:${assertionId}`, to: `w:${w.warning_id}`, kind: 'triggers' });
      }
    }
    if (w.retracted_by_turn_id && referencedTurnIds.has(w.retracted_by_turn_id)) {
      edges.push({ from: `t:${w.retracted_by_turn_id}`, to: `w:${w.warning_id}`, kind: 'retracts' });
    }
  }

  return { columns: [turnNodes, factNodes, evidenceNodes], edges };
}

// ---------------------------------------------------------------------------
// Rendering: 3-column grid of node buttons + an SVG edge overlay that scrolls
// with the nodes. Anchors come from offsetLeft/offsetTop (the relative wrapper
// is every node's offset parent), so no viewport math is needed.
// ---------------------------------------------------------------------------

const edgeStroke: Record<EdgeKind, { className: string; dash?: string }> = {
  derives: { className: 'text-ink-faint' },
  triggers: { className: 'text-amber' },
  supersedes: { className: 'text-ink-faint', dash: '3 3' },
  retracts: { className: 'text-danger', dash: '4 4' },
};

const nodeStyle: Record<NodeKind, string> = {
  turn: 'border-line bg-canvas',
  fact: 'border-teal/40 bg-teal/5',
  warning: 'border-amber/40 bg-amber/5',
  state: 'border-line bg-canvas',
};

interface EdgePath {
  d: string;
  kind: EdgeKind;
  endX: number;
  endY: number;
}

export default function ReasoningGraphPanel({
  turns,
  assertions,
  result,
  onFocusTurn,
}: {
  turns: BackendTurn[];
  assertions: BackendAssertion[];
  result: BackendResult | null;
  onFocusTurn: (turnId: string) => void;
}) {
  const graph = useMemo(() => buildReasoningGraph(turns, assertions, result), [turns, assertions, result]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<EdgePath[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const measure = () => {
      const next: EdgePath[] = [];
      for (const edge of graph.edges) {
        const from = nodeRefs.current.get(edge.from);
        const to = nodeRefs.current.get(edge.to);
        if (!from || !to) continue;
        const y1 = from.offsetTop + from.offsetHeight / 2;
        const y2 = to.offsetTop + to.offsetHeight / 2;
        let d: string;
        let endX: number;
        if (edge.kind === 'supersedes') {
          // Intra-column: leave and re-enter on the right edge, bulging into
          // the column gutter.
          const x1 = from.offsetLeft + from.offsetWidth;
          endX = to.offsetLeft + to.offsetWidth;
          d = `M ${x1} ${y1} C ${x1 + 26} ${y1}, ${endX + 26} ${y2}, ${endX} ${y2}`;
        } else {
          const x1 = from.offsetLeft + from.offsetWidth;
          endX = to.offsetLeft;
          const dx = Math.min(40, Math.max(16, (endX - x1) / 2));
          d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${endX - dx} ${y2}, ${endX} ${y2}`;
        }
        next.push({ d, kind: edge.kind, endX, endY: y2 });
      }
      setPaths((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setSize((prev) => {
        const width = wrapper.scrollWidth;
        const height = wrapper.scrollHeight;
        return prev.width === width && prev.height === height ? prev : { width, height };
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [graph]);

  const [turnNodes, factNodes, evidenceNodes] = graph.columns;
  if (turnNodes.length === 0 && factNodes.length === 0) {
    return (
      <p className="text-sm text-ink-faint">
        The reasoning graph appears once a finalized turn produces a patient fact: spoken turn → extracted fact →
        evidence/warning. Play a demo script or add turns to see it grow.
      </p>
    );
  }

  return (
    <div>
      <div className="max-h-[30rem] overflow-auto">
        <div ref={wrapperRef} className="relative min-w-[720px]">
          <div className="grid grid-cols-3 gap-x-12">
            {(
              [
                ['Spoken turns', turnNodes],
                ['Patient facts', factNodes],
                ['Evidence & warnings', evidenceNodes],
              ] as [string, RGNode[]][]
            ).map(([heading, nodes]) => (
              <div key={heading} className="space-y-2.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{heading}</div>
                {nodes.length === 0 && <p className="text-xs text-ink-faint">Nothing yet.</p>}
                {nodes.map((node) => (
                  <button
                    key={node.id}
                    ref={(el) => {
                      if (el) nodeRefs.current.set(node.id, el);
                      else nodeRefs.current.delete(node.id);
                    }}
                    title={node.title}
                    onClick={() => node.focusTurnId && onFocusTurn(node.focusTurnId)}
                    className={cn(
                      'block w-full rounded-lg border p-2 text-left text-xs',
                      node.kind === 'state'
                        ? (stateMeta[node.stateKey ?? '']?.border ?? nodeStyle.state)
                        : nodeStyle[node.kind],
                      node.dimmed && 'border-dashed opacity-60',
                      node.retracted && 'border-dashed border-navy/30 bg-canvas opacity-70',
                      node.focusTurnId ? 'cursor-pointer hover:border-teal' : 'cursor-default',
                    )}
                  >
                    <span className="block font-medium text-navy">{node.label}</span>
                    {node.sublabel && <span className="mt-0.5 block text-[11px] text-ink-muted">{node.sublabel}</span>}
                    {node.retracted && <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-navy">retracted</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <svg
            className="pointer-events-none absolute inset-0"
            width={size.width}
            height={size.height}
            aria-hidden="true"
          >
            {paths.map((path, i) => (
              <g key={i} className={edgeStroke[path.kind].className}>
                <path
                  d={path.d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeDasharray={edgeStroke[path.kind].dash}
                  opacity={0.7}
                />
                <circle cx={path.endX} cy={path.endY} r={2.5} fill="currentColor" opacity={0.8} />
              </g>
            ))}
          </svg>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
        {(
          [
            ['derives', 'turn → fact'],
            ['triggers', 'fact → warning'],
            ['supersedes', 'superseded by'],
            ['retracts', 'retracted by turn'],
          ] as [EdgeKind, string][]
        ).map(([kind, label]) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden="true" className={edgeStroke[kind].className}>
              <line
                x1="0"
                y1="3"
                x2="22"
                y2="3"
                stroke="currentColor"
                strokeWidth={2}
                strokeDasharray={edgeStroke[kind].dash}
              />
            </svg>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
