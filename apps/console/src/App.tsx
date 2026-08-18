import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './lib/api.ts';
import type { Bootstrap } from './lib/api.ts';
import { useAsync, usePoll, useToasts } from './lib/ui.tsx';
import { Icon } from './lib/icons.tsx';
import { Setup } from './views/Setup.tsx';
import { Profile } from './views/Profile.tsx';
import { Train } from './views/Train.tsx';
import { Memories } from './views/Memories.tsx';
import { Workspaces } from './views/Workspaces.tsx';
import { Graph } from './views/Graph.tsx';
import { Observability } from './views/Observability.tsx';
import { Chat } from './views/Chat.tsx';
import { Welcome, useWelcome } from './views/Welcome.tsx';

type ViewId =
  | 'setup' | 'chat' | 'profile' | 'train' | 'memories'
  | 'workspaces' | 'graph' | 'observability';

/**
 * The navigation, and the one sentence each page opens with.
 *
 * `label` is what the tab is called. `lede` is what the page is *for*, said
 * plainly enough that someone who has never seen this before knows whether
 * they are in the right place. Both are written to a deliberate voice: short
 * sentences, no jargon, lowercase where it can be — "connections", not "graph";
 * "activity", not "observability".
 *
 * The old labels were accurate and useless. "Signals" is a word that means
 * something to whoever built it and nothing to anyone else, and a person who
 * has to guess what a tab does has already been failed by it.
 */
const VIEWS: Array<{
  id: ViewId;
  label: string;
  icon: string;
  group: string;
  lede: React.ReactNode;
}> = [
  {
    id: 'setup', label: 'connect', icon: 'plug', group: 'start here',
    lede: <>Paste one address into Claude, Cursor or ChatGPT. From then on they read
      and write the <strong>same memory</strong> — no copying between tools.</>,
  },
  {
    id: 'chat', label: 'ask', icon: 'chat', group: 'start here',
    lede: <>Ask a question and it searches everything you have saved. It shows you the
      entries it used, so you can check the answer rather than trust it.</>,
  },
  {
    id: 'profile', label: 'about you', icon: 'person', group: 'you',
    lede: <>What your tools have worked out about you, built only from things you saved.
      This is what a brand-new chat gets handed, so you never explain yourself twice.</>,
  },
  {
    id: 'train', label: 'fill the gaps', icon: 'question', group: 'you',
    lede: <>Questions nothing has answered yet. Answer one here and{' '}
      <strong>every connected tool</strong> knows it from the next message on.</>,
  },
  {
    id: 'memories', label: 'memories', icon: 'list', group: 'your memory',
    lede: <>Everything you have saved, newest first. Search works by meaning, so
      “how long to get my money back” finds a note about refunds.</>,
  },
  {
    id: 'workspaces', label: 'projects', icon: 'folders', group: 'your memory',
    lede: <>Keep work, side projects and personal life apart. A tool can be pointed at
      one project so it only ever sees what is relevant to it.</>,
  },
  {
    id: 'graph', label: 'connections', icon: 'nodes', group: 'your memory',
    lede: <>The people, tools and projects that keep coming up in your memories, and
      what each one is linked to.</>,
  },
  {
    id: 'observability', label: 'activity', icon: 'pulse', group: 'behind the scenes',
    lede: <>Every time a tool read or wrote something. The quickest way to check that a
      connection is genuinely working.</>,
  },
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
  const welcome = useWelcome();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('orbis-theme', theme);
  }, [theme]);

  useEffect(() => {
    window.location.hash = view;
  }, [view]);

  // The hash was written on navigation but never read again after mount, so the
  // back button and a pasted deep link both silently did nothing — the URL
  // changed and the page did not. Listening closes the loop in both directions.
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1) as ViewId;
      if (VIEWS.some((v) => v.id === h)) setView(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (workspace) localStorage.setItem('orbis-workspace', workspace);
    else localStorage.removeItem('orbis-workspace');
  }, [workspace]);

  const boot = useAsync<Bootstrap>(() => api.bootstrap(), []);

  // The connection indicator and counters need to notice a new client without
  // a manual refresh — connecting a tool in another window is the moment the
  // Connect page is meant to react to.
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
                    aria-current={view === v.id ? 'page' : undefined}
                  >
                    <Icon name={v.icon} />
                    <span>{v.label}</span>
                    {n !== undefined && <span className="count">{n}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="nav-foot">
          <button className="nav-item" onClick={welcome.reopen}>
            <Icon name="question" />
            <span>what is this?</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
            <span>{theme === 'dark' ? 'dark' : 'light'}</span>
          </button>
        </div>
      </nav>

      <main className="main">
        <div className={`content${view === 'graph' || view === 'observability' || view === 'chat' ? ' wide' : ''}`}>
          <div className="page-head" hidden={boot.data ? !welcome.seen : false}>
            <div className="page-head-row">
              <h1>{current.label}</h1>
              {boot.data && boot.data.workspaces.length > 0 && (
                <label className="ws-pick">
                  <span>showing</span>
                  <select
                    value={workspace ?? ''}
                    onChange={(e) => setWorkspace(e.target.value || null)}
                  >
                    <option value="">everything</option>
                    {boot.data.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.memoryCount ?? 0})
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="lede">{current.lede}</div>
          </div>

          {boot.error && (
            <div className="banner danger">
              <span className="dot" />
              <div className="body">
                <strong>Can’t reach Orbis.</strong> {boot.error}
                <div className="faint" style={{ marginTop: 4 }}>
                  The server may not be running. Try <code>npm run api</code>.
                </div>
              </div>
            </div>
          )}

          {boot.data && !boot.data.embedder.semantic && (
            <div className="banner warn">
              <span className="dot" />
              <div className="body">
                <strong>Search is only matching exact words right now.</strong> The model that
                understands meaning isn’t loaded, so “refund” will find “refund” but not
                “reimbursement”.
                <div className="faint" style={{ marginTop: 3 }}>{boot.data.embedder.reason}</div>
              </div>
            </div>
          )}

          {boot.data && !welcome.seen && (
            <Welcome onDone={() => { welcome.dismiss(); setView('setup'); }} />
          )}

          {boot.data && welcome.seen && (
            <>
              {view === 'setup' && (
                <Setup boot={boot.data} reload={boot.reload} toast={toasts.push} />
              )}
              {view === 'chat' && (
                <Chat boot={boot.data} workspace={workspace} onWrote={boot.reload} />
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
                <div key={i} className="skeleton" style={{ height: 96 }} />
              ))}
            </div>
          )}
        </div>
      </main>

      {toasts.view}
    </div>
  );
}
