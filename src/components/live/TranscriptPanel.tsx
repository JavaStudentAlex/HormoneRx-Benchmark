import { useEffect, useRef } from 'react';
import { Badge, cn } from '../ui/primitives';
import type { BackendTurn } from '../../lib/backendClient';

const speakerTone: Record<string, 'teal' | 'navy' | 'muted' | 'amber'> = {
  patient: 'teal',
  doctor: 'navy',
  other_person: 'amber',
  unknown: 'muted',
};

export default function TranscriptPanel({
  turns,
  caption,
  highlightTurnIds,
}: {
  turns: BackendTurn[];
  caption: { speaker: string; text: string } | null;
  highlightTurnIds: Set<string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, caption?.text]);

  return (
    <div ref={scrollRef} className="max-h-80 space-y-2 overflow-y-auto pr-1">
      {turns.length === 0 && !caption && (
        <p className="text-sm text-ink-faint">
          Finalized turns appear here with speaker labels. Provisional captions are shown in lighter styling and are
          never analyzed.
        </p>
      )}
      {turns.map((turn) => (
        <div
          key={turn.turn_id}
          className={cn(
            'rounded-lg border p-2.5',
            highlightTurnIds.has(turn.turn_id) ? 'border-amber/50 bg-amber/5' : 'border-line bg-canvas',
          )}
        >
          <div className="flex items-center gap-2">
            <Badge tone={speakerTone[turn.speaker] ?? 'muted'}>{turn.speaker}</Badge>
            <span className="font-mono text-[10px] text-ink-faint">{turn.turn_id}</span>
            {turn.arrived_late && <Badge tone="amber">late event</Badge>}
          </div>
          <p className="mt-1.5 text-sm text-navy">{turn.text}</p>
        </div>
      ))}
      {caption && caption.text && (
        <div className="rounded-lg border border-dashed border-line bg-surface p-2.5 opacity-70">
          <div className="flex items-center gap-2">
            <Badge tone={speakerTone[caption.speaker] ?? 'muted'}>{caption.speaker}</Badge>
            <span className="text-[10px] uppercase tracking-wide text-ink-faint">provisional caption — not analyzed</span>
          </div>
          <p className="mt-1.5 text-sm italic text-ink-muted">{caption.text}…</p>
        </div>
      )}
    </div>
  );
}
