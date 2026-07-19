import { useEffect, useRef } from 'react';
import { cn } from '../ui/primitives';
import type { BackendTurn } from '../../lib/backendClient';

export const speakerTone: Record<string, 'teal' | 'navy' | 'muted' | 'amber'> = {
  patient: 'teal',
  doctor: 'navy',
  other_person: 'amber',
  unknown: 'muted',
};

// Chat-bubble treatment per (inferred) role: doctor left, patient right,
// companions left in amber, unattributable turns centered and muted.
const bubbleStyle: Record<string, { align: string; bubble: string; dot: string }> = {
  doctor: { align: 'items-start', bubble: 'border-navy/20 bg-navy/5', dot: 'bg-navy' },
  patient: { align: 'items-end', bubble: 'border-teal/20 bg-teal/5', dot: 'bg-teal' },
  other_person: { align: 'items-start', bubble: 'border-amber/30 bg-amber/5', dot: 'bg-amber' },
  unknown: { align: 'items-center', bubble: 'border-line bg-canvas', dot: 'bg-ink-faint' },
};

function bubbleFor(speaker: string) {
  return bubbleStyle[speaker] ?? bubbleStyle.unknown;
}

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
    <div ref={scrollRef} className="max-h-[26rem] space-y-2.5 overflow-y-auto pr-1">
      {turns.length === 0 && !caption && (
        <p className="text-sm text-ink-faint">
          The conversation appears here as a chat: the backend attributes each finalized turn to the doctor (left) or
          patient (right) automatically. Provisional captions are shown in lighter styling and are never analyzed.
        </p>
      )}
      {turns.map((turn) => {
        const style = bubbleFor(turn.speaker);
        return (
          <div key={turn.turn_id} className={cn('flex flex-col', style.align)}>
            <div
              className={cn(
                'max-w-[80%] rounded-lg border p-2.5',
                highlightTurnIds.has(turn.turn_id) ? 'border-amber/50 bg-amber/5' : style.bubble,
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full', style.dot)} />
                <span className="text-[11px] font-semibold capitalize text-navy">
                  {turn.speaker.replaceAll('_', ' ')}
                </span>
                <span className="font-mono text-[10px] text-ink-faint">{turn.turn_id}</span>
                {turn.arrived_late && (
                  <span className="rounded-full border border-amber/40 bg-amber/10 px-1.5 text-[10px] text-amber">
                    late event
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-navy">{turn.text}</p>
            </div>
          </div>
        );
      })}
      {caption && caption.text && (
        <div className={cn('flex flex-col', bubbleFor(caption.speaker).align)}>
          <div className="max-w-[80%] rounded-lg border border-dashed border-line bg-surface p-2.5 opacity-70">
            <div className="flex items-center gap-1.5">
              <span className={cn('h-2 w-2 rounded-full', bubbleFor(caption.speaker).dot)} />
              <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                provisional caption — not analyzed
              </span>
            </div>
            <p className="mt-1 text-sm italic text-ink-muted">{caption.text}…</p>
          </div>
        </div>
      )}
    </div>
  );
}
