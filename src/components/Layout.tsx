import { NavLink, Outlet } from 'react-router-dom';
import { Badge, cn } from './ui/primitives';
import { evidenceVersion } from '../lib/evidence';
import { DISCLAIMER } from '../lib/pipeline';
import benchmarkCases from '../data/benchmark_cases.json';
import { useMode } from '../lib/useMode';

const nav = [
  { to: '/', label: 'Overview', end: true },
  { to: '/live', label: 'Live Consultation' },
  { to: '/evidence', label: 'Evidence Library' },
  { to: '/benchmark', label: 'Benchmark' },
  { to: '/about', label: 'About' },
];

export default function Layout() {
  const { mode, setMode } = useMode();
  const benchmarkVersion = (benchmarkCases as { benchmarkVersion: string }).benchmarkVersion;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-surface">
        <div className="container-page py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold tracking-tight text-navy">HormoneRx Benchmark</span>
              </div>
              <p className="mt-0.5 text-xs text-ink-muted">
                Source-linked evidence dataset · synthetic benchmark · reproducible evaluation
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="amber">Research prototype</Badge>
              <Badge tone="muted">Synthetic benchmark</Badge>
              <Badge tone="neutral">Evidence v{evidenceVersion}</Badge>
              <Badge tone="neutral">Benchmark v{benchmarkVersion}</Badge>
              <ModeToggle mode={mode} setMode={setMode} />
            </div>
          </div>
          <nav className="mt-4 flex flex-wrap gap-1" aria-label="Primary">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive ? 'bg-navy text-white' : 'text-navy hover:bg-canvas',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="container-page flex-1 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="container-page py-4">
          <p className="text-xs leading-relaxed text-ink-muted">
            <span className="font-semibold text-navy">Disclaimer.</span> {DISCLAIMER}
          </p>
        </div>
      </footer>
    </div>
  );
}

function ModeToggle({ mode, setMode }: { mode: 'demo' | 'live'; setMode: (m: 'demo' | 'live') => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-full border border-line" role="group" aria-label="Pipeline mode">
      <button
        onClick={() => setMode('demo')}
        className={cn('px-2.5 py-0.5 text-xs font-medium', mode === 'demo' ? 'bg-teal text-white' : 'bg-surface text-navy')}
        aria-pressed={mode === 'demo'}
      >
        Demo mode
      </button>
      <button
        onClick={() => setMode('live')}
        className={cn('px-2.5 py-0.5 text-xs font-medium', mode === 'live' ? 'bg-teal text-white' : 'bg-surface text-navy')}
        aria-pressed={mode === 'live'}
      >
        Live mode
      </button>
    </div>
  );
}
