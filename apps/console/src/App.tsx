import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './lib/api.ts';
import type { Bootstrap } from './lib/api.ts';
import { useAsync, usePoll, useToasts } from './lib/ui.tsx';
import { Setup } from './views/Setup.tsx';
import { Profile } from './views/Profile.tsx';
import { Train } from './views/Train.tsx';
import { Memories } from './views/Memories.tsx';
import { Workspaces } from './views/Workspaces.tsx';
import { Graph } from './views/Graph.tsx';
import { Observability } from './views/Observability.tsx';

type ViewId =
  | 'setup' | 'profile' | 'train' | 'memories'
  | 'workspaces' | 'graph' | 'observability';

const VIEWS: Array<{
  id: ViewId;
  label: string;
  icon: string;
  group: string;
  subtitle: string;
}> = [
  { id: 'setup',        label: 'Setup',      icon: '◎', group: 'Start',  subtitle: 'Connect your tools to one memory' },
  { id: 'profile',      label: 'Profile',    icon: '◍', group: 'You',    subtitle: 'What Orbis knows about you' },
  { id: 'train',        label: 'Train',      icon: '◔', group: 'You',    subtitle: 'Fill the gaps in your profile' },
  { id: 'memories',     label: 'Memories',   icon: '≡', group: 'Memory', subtitle: 'Everything, searchable' },
  { id: 'workspaces',   label: 'Workspaces', icon: '▤', group: 'Memory', subtitle: 'Projects and folders' },
  { id: 'graph',        label: 'Graph',      icon: '◈', group: 'Memory', subtitle: 'How it all connects' },
  { id: 'observability',label: 'Signals',    icon: '◊', group: 'System', subtitle: 'What your agents are doing' },
];

export default function App() {
  const [view, setView] = useState<ViewId>(() => {
    const h = window.location.hash.slice(1) as ViewId;
    return VIEWS.some((v) => v.id === h) ? h : 'setup';
  });

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('orbis-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const [workspace, setWorkspace] = useState<string | null>(
    () => localStorage.getItem('orbis-workspace'),
  );

  const toasts = useToasts();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('orbis-theme', theme);
  }, [theme]);

  useEffect(() => {
    window.location.hash = view;
  }, [view]);

  useEffect(() => {
    if (workspace) localStorage.setItem('orbis-workspace', workspace);
    else localStorage.removeItem('orbis-workspace');
  }, [workspace]);

  const boot = useAsync<Bootstrap>(() => api.bootstrap(), []);

  // The connection indicator and counters need to notice a new client without
  // a manual refresh — connecting a tool in another window is the moment the
  // Setup page is meant to react to.
  usePoll(boot.reload, 6000, view === 'setup' || view === 'observability');

  const current = VIEWS.find((v) => v.id === view)!;
  const grouped = useMemo(() => {
    const out: Array<[string, typeof VIEWS]> = [];
    for (const v of VIEWS) {
      const last = out[out.length - 1];
      if (last && last[0] === v.group) last[1].push(v);
      else out.push([v.group, [v]]);
    }
    return out;
  }, []);

  const counts = boot.data?.counts;
  const countFor = (id: ViewId): number | undefined => {
    if (!counts) return undefined;
    if (id === 'memories') return counts.memories;
    if (id === 'graph') return counts.entities;
    if (id === 'train') return counts.questions || undefined;
    if (id === 'setup') return boot.data?.connections.length || undefined;
    return undefined;
  };

  const go = useCallback((v: ViewId) => setView(v), []);

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">
          <div className="nav-mark" />
          <div className="nav-name">Orbis</div>
        </div>

        <div className="nav-groups">
          {grouped.map(([group, items]) => (
            <div className="nav-group" key={group}>
              <div className="nav-group-label">{group}</div>
              {items.map((v) => {
                const n = countFor(v.id);
                return (
                  <button
                    key={v.id}
                    className={`nav-item${view === v.id ? ' active' : ''}`}
                    onClick={() => go(v.id)}
                    title={v.subtitle}
                  >
                    <span className="ico">{v.icon}</span>
                    <span>{v.label}</span>
                    {n !== undefined && <span className="count">{n}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="nav-foot">
          <button
            className="nav-item"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <span className="ico">{theme === 'dark' ? '☾' : '☀'}</span>
            <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
        </div>
      </nav>

      <main className="main">
        <header className="header">
          <h1>{current.label}</h1>
          <span className="sub">{current.subtitle}</span>
          <div className="spacer" />

          {boot.data && boot.data.workspaces.length > 0 && (
            <select
              className="input"
              style={{ width: 'auto', minWidth: 150, fontSize: 13 }}
              value={workspace ?? ''}
              onChange={(e) => setWorkspace(e.target.value || null)}
              title="Scope this view to one workspace"
            >
              <option value="">All workspaces</option>
              {boot.data.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.memoryCount ?? 0})
                </option>
              ))}
            </select>
          )}
        </header>

        <div className={`content${view === 'graph' || view === 'observability' ? ' wide' : ''}`}>
          {boot.error && (
            <div className="banner danger">
              <span className="dot" />
              <div className="body">
                <strong>Cannot reach the Orbis API.</strong> {boot.error}
                <div className="faint" style={{ marginTop: 4 }}>
                  Is the server running? <code>npm run api</code>
                </div>
              </div>
            </div>
          )}

          {boot.data && !boot.data.embedder.semantic && (
            <div className="banner warn">
              <span className="dot" />
              <div className="body">
                <strong>Search is running in degraded mode.</strong> No semantic model is
                available, so recall matches shared vocabulary only — it will find
                “refund” from “refund”, but never from “reimbursement”.
                <div className="faint" style={{ marginTop: 3 }}>{boot.data.embedder.reason}</div>
              </div>
            </div>
          )}

          {boot.data && (
            <>
              {view === 'setup' && (
                <Setup boot={boot.data} reload={boot.reload} toast={toasts.push} />
              )}
              {view === 'profile' && (
                <Profile boot={boot.data} workspace={workspace} toast={toasts.push} />
              )}
              {view === 'train' && <Train boot={boot.data} toast={toasts.push} reload={boot.reload} />}
              {view === 'memories' && (
                <Memories workspace={workspace} toast={toasts.push} reload={boot.reload} />
              )}
              {view === 'workspaces' && (
                <Workspaces
                  boot={boot.data}
                  workspace={workspace}
                  setWorkspace={setWorkspace}
                  toast={toasts.push}
                  reload={boot.reload}
                />
              )}
              {view === 'graph' && <Graph workspace={workspace} />}
              {view === 'observability' && <Observability boot={boot.data} />}
            </>
          )}

          {!boot.data && !boot.error && (
            <div className="grid-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton" style={{ height: 82 }} />
              ))}
            </div>
          )}
        </div>
      </main>

      {toasts.view}
    </div>
  );
}
