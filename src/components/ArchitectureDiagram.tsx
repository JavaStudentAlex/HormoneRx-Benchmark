const steps = [
  { title: 'Consultation text', detail: 'Free-text clinical note' },
  { title: 'Structured extraction', detail: 'Product · medication · status only' },
  { title: 'Synonym normalization', detail: 'Documented synonyms → identifiers' },
  { title: 'Negation & temporality', detail: 'Exclude negated / historical' },
  { title: 'Deterministic lookup', detail: 'Rule-based match in evidence set' },
  { title: 'Result state', detail: 'Evidence · no match · abstain' },
];

export default function ArchitectureDiagram() {
  return (
    <div className="overflow-x-auto">
      <ol className="flex min-w-max items-stretch gap-2" aria-label="Pipeline architecture">
        {steps.map((s, i) => (
          <li key={s.title} className="flex items-center gap-2">
            <div className="flex h-full w-40 flex-col rounded-lg border border-line bg-canvas px-3 py-2.5">
              <span className="text-xs font-semibold text-navy">{s.title}</span>
              <span className="mt-1 text-[11px] leading-snug text-ink-muted">{s.detail}</span>
            </div>
            {i < steps.length - 1 && (
              <span className="text-teal" aria-hidden="true">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-ink-muted">
        The language model contributes only the extraction step. It never generates interactions, consequences,
        citations, or advice; all displayed medical content is loaded from the evidence dataset and retrieval is
        deterministic.
      </p>
    </div>
  );
}
