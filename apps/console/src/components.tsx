import { useEffect, useState, type ReactNode } from 'react';
import type { Belief, Decision } from './api';

/* ------------------------------------------------------------------ theme */

export type Theme = 'light' | 'dark';

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('recall-theme') as Theme | null;
    if (saved) return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('recall-theme', theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      className="btn ghost"
      onClick={onToggle}
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      aria-label="Toggle colour theme"
    >
      {theme === 'light' ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

/* ------------------------------------------------------------------ atoms */

export function Badge({
  tone = 'neutral',
  children,
  dot,
  pulse,
}: {
  tone?: 'neutral' | 'ok' | 'taint' | 'danger' | 'accent';
  children: ReactNode;
  dot?: boolean;
  pulse?: boolean;
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <i className={`dot${pulse ? ' pulse' : ''}`} />}
      {children}
    </span>
  );
}

export function statusTone(status: string) {
  switch (status) {
    case 'active':
    case 'committed':
      return 'ok' as const;
    case 'quarantined':
      return 'taint' as const;
    case 'retracted':
    case 'reverted':
    case 'failed':
      return 'danger' as const;
    default:
      return 'neutral' as const;
  }
}

/** Short id with click-to-copy. Full value stays available on hover. */
export function Id({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      className="id"
      title={value}
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1000);
      }}
    >
      {copied ? 'copied' : value.slice(0, 8)}
    </span>
  );
}

export function Confidence({ value }: { value: number }) {
  return (
    <div style={{ minWidth: 62 }}>
      <div className="num" style={{ fontSize: 11.5 }}>
        {value.toFixed(2)}
      </div>
      <div className="meter">
        <i style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

export function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${days}d ago ${time}`;
}

export function money(payload: Record<string, unknown>): string | null {
  if (typeof payload.amount_usd === 'number') return `$${payload.amount_usd.toLocaleString()}`;
  if (typeof payload.amount_inr === 'number') return `₹${payload.amount_inr.toLocaleString()}`;
  return null;
}

/* ---------------------------------------------------------- lineage graph */

interface GraphNode {
  id: string;
  label: string;
  meta: string;
  kind: 'belief' | 'decision';
  generation: number;
  tainted: boolean;
  origin?: boolean;
}

/**
 * Renders the contamination chain as a left-to-right DAG: the falsified belief
 * on the left, then each generation of decisions it reached.
 *
 * Hand-laid-out rather than force-directed on purpose -- the story is causal
 * order, and a physics simulation would move things between renders and make
 * the same data look different every time.
 */
export function LineageGraph({
  origin,
  decisions,
}: {
  origin: Belief;
  decisions: Decision[];
}) {
  const cols = new Map<number, GraphNode[]>();
  cols.set(-1, [
    {
      id: origin.id,
      label: origin.subject,
      meta: 'falsified belief',
      kind: 'belief',
      generation: -1,
      tainted: true,
      origin: true,
    },
  ]);

  for (const d of decisions) {
    const g = Number(d.generation ?? 0);
    const list = cols.get(g) ?? [];
    list.push({
      id: d.id,
      label: d.action.replace(/_/g, ' '),
      meta: money(d.payload) ?? String((d.payload as { customer?: number }).customer ?? ''),
      kind: 'decision',
      generation: g,
      tainted: true,
    });
    cols.set(g, list);
  }

  const order = [...cols.keys()].sort((a, b) => a - b);
  const COL_W = 190;
  const NODE_W = 156;
  const NODE_H = 42;
  const GAP_Y = 14;
  const PAD = 14;

  const height =
    PAD * 2 + Math.max(...order.map((g) => cols.get(g)!.length)) * (NODE_H + GAP_Y);
  const width = PAD * 2 + order.length * COL_W;

  const pos = new Map<string, { x: number; y: number }>();
  order.forEach((g, ci) => {
    const list = cols.get(g)!;
    const colH = list.length * (NODE_H + GAP_Y) - GAP_Y;
    const startY = (height - colH) / 2;
    list.forEach((n, ri) => {
      pos.set(n.id, { x: PAD + ci * COL_W, y: startY + ri * (NODE_H + GAP_Y) });
    });
  });

  // Edges: origin -> generation 0, then generation n -> n+1.
  const edges: Array<[GraphNode, GraphNode]> = [];
  for (let i = 1; i < order.length; i++) {
    const from = cols.get(order[i - 1])!;
    const to = cols.get(order[i])!;
    for (const t of to) for (const f of from) edges.push([f, t]);
  }

  return (
    <svg className="graph" viewBox={`0 0 ${width} ${height}`} role="img"
         aria-label="Contamination lineage graph">
      {edges.map(([f, t], i) => {
        const a = pos.get(f.id)!;
        const b = pos.get(t.id)!;
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        return (
          <path
            key={i}
            className="edge tainted"
            d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
          />
        );
      })}

      {order.flatMap((g) =>
        cols.get(g)!.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`}>
              <rect
                className={`node-box ${n.kind} ${n.origin ? 'origin' : n.tainted ? 'tainted' : ''}`}
                width={NODE_W}
                height={NODE_H}
              />
              <text x={10} y={17}>
                {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
              </text>
              <text className="meta" x={10} y={31}>
                {n.meta}
              </text>
            </g>
          );
        }),
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ icons */

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
