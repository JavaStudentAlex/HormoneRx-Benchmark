import React from 'react';

type Div = React.HTMLAttributes<HTMLDivElement>;

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Card({ className, ...props }: Div) {
  return <div className={cn('rounded-xl border border-line bg-surface shadow-sm', className)} {...props} />;
}

export function CardHeader({ className, ...props }: Div) {
  return <div className={cn('border-b border-line px-5 py-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-base font-semibold text-navy', className)} {...props} />;
}

export function CardBody({ className, ...props }: Div) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

type BadgeTone = 'neutral' | 'teal' | 'amber' | 'navy' | 'danger' | 'muted';
const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-canvas text-navy border-line',
  teal: 'bg-teal/10 text-teal border-teal/30',
  amber: 'bg-amber/10 text-amber border-amber/30',
  navy: 'bg-navy text-white border-navy',
  danger: 'bg-danger/10 text-danger border-danger/30',
  muted: 'bg-canvas text-ink-muted border-line',
};

export function Badge({ tone = 'neutral', className, ...props }: Div & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        badgeTones[tone],
        className,
      )}
      {...(props as React.HTMLAttributes<HTMLSpanElement>)}
    />
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
};
export function Button({ variant = 'primary', className, ...props }: ButtonProps) {
  const variants = {
    primary: 'bg-teal text-white hover:bg-teal-soft border-teal',
    secondary: 'bg-surface text-navy hover:bg-canvas border-line',
    ghost: 'bg-transparent text-navy hover:bg-canvas border-transparent',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Stat({ label, value, hint, tone = 'navy' }: { label: string; value: React.ReactNode; hint?: string; tone?: 'navy' | 'teal' | 'amber' }) {
  const toneClass = tone === 'teal' ? 'text-teal' : tone === 'amber' ? 'text-amber' : 'text-navy';
  return (
    <Card>
      <CardBody>
        <div className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</div>
        <div className={cn('mt-1 text-3xl font-semibold tabular-nums', toneClass)}>{value}</div>
        {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
      </CardBody>
    </Card>
  );
}
