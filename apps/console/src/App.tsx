import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AuditEntry, type Belief, type Decision, type Health } from './api';
import {
  Badge, Confidence, Id, LineageGraph, ThemeToggle,
  money, statusTone, useTheme, when,
} from './components';

type View = 'overview' | 'beliefs' | 'investigate' | 'resilience' | 'audit';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'beliefs', label: 'Beliefs' },
  { id: 'investigate', label: 'Investigate' },
  { id: 'resilience', label: 'Resilience' },
  { id: 'audit', label: 'Audit log' },
];

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [view, setView] = useState<View>('overview');
  const [health, setHealth] = useState<Health | null>(null);
  const [beliefs, setBeliefs] = useState<Belief[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [b, d] = await Promise.all([api.beliefs(), api.decisions()]);
    setBeliefs(b.beliefs);
    setDecisions(d.decisions);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Health polls continuously so the resilience panel reacts to a node dying
  // without anyone touching the UI.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await api.health();
        if (alive) setHealth(h);
      } catch {
        if (alive) setHealth((p) => (p ? { ...p, ok: false } : null));
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const counts = useMemo(() => ({
    beliefs: beliefs.length,
    active: beliefs.filter((b) => b.status === 'active').length,
    suspect: beliefs.filter((b) => b.status !== 'active').length,
    decisions: decisions.length,
    reverted: decisions.filter((d) => d.status === 'reverted').length,
  }), [beliefs, decisions]);

  const investigate = useCallback((id: string) => {
    setSelected(id);
    setView('investigate');
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1><Logo /> Recall</h1>
          <div className="tag">governable agent memory</div>
        </div>

        <nav className="nav">
          {VIEWS.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)} aria-current={view === v.id}>
              {v.label}
              {v.id === 'beliefs' && <span className="count">{counts.beliefs}</span>}
              {v.id === 'investigate' && counts.suspect > 0 && (
                <span className="count" style={{ color: 'var(--taint)' }}>{counts.suspect}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <ClusterPill health={health} />
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h2>{VIEWS.find((v) => v.id === view)!.label}</h2>
            <div className="sub">Northwind Air · support operations</div>
          </div>
          <div className="spacer" />
          <span className="id">{health?.target ?? '…'}</span>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </header>

        <div className="content">
          {view === 'overview' && (
            <Overview counts={counts} health={health} decisions={decisions}
                      beliefs={beliefs} onInvestigate={investigate} />
          )}
          {view === 'beliefs' && (
            <Beliefs beliefs={beliefs} setBeliefs={setBeliefs} onInvestigate={investigate} />
          )}
          {view === 'investigate' && (
            <Investigate beliefs={beliefs} selected={selected} setSelected={setSelected}
                         onChanged={refresh} />
          )}
          {view === 'resilience' && <Resilience health={health} />}
          {view === 'audit' && <AuditLog />}
        </div>
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------- overview */

function Overview({
  counts, health, decisions, beliefs, onInvestigate,
}: {
  counts: { beliefs: number; active: number; suspect: number; decisions: number; reverted: number };
  health: Health | null;
  decisions: Decision[];
  beliefs: Belief[];
  onInvestigate: (id: string) => void;
}) {
  const suspect = beliefs.filter((b) => b.status !== 'active');

  return (
    <>
      {suspect.length > 0 && (
        <div className="banner">
          <span className="dot pulse" />
          <div>
            <strong>{suspect.length} belief{suspect.length > 1 ? 's' : ''} flagged.</strong>{' '}
            Decisions made from {suspect.length > 1 ? 'them' : 'it'} may need reverting.
          </div>
          <div className="spacer" />
          <button className="btn" onClick={() => onInvestigate(suspect[0].id)}>
            Investigate
          </button>
        </div>
      )}

      <div className="grid-3">
        <Stat label="Beliefs held" value={counts.beliefs}
              foot={`${counts.active} active · ${counts.suspect} flagged`} />
        <Stat label="Decisions recorded" value={counts.decisions}
              foot={`${counts.reverted} reverted`} />
        <Stat label="Memory read latency" value={health ? `${health.latencyMs}ms` : '—'}
              tone={health?.ok ? 'ok' : 'danger'}
              foot={health?.topologyAvailable
                ? `${health.liveNodes}/${health.totalNodes} nodes live`
                : 'serverless — no node topology'} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Recent decisions</h3>
          <span className="hint">every action, with the beliefs that caused it</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Action</th><th>Detail</th><th>Rationale</th><th>Status</th><th>When</th>
            </tr>
          </thead>
          <tbody>
            {decisions.slice(0, 10).map((d) => (
              <tr key={d.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{d.action.replace(/_/g, ' ')}</td>
                <td className="num">{money(d.payload) ?? <span className="faint">—</span>}</td>
                <td className="muted truncate">{d.rationale}</td>
                <td><Badge tone={statusTone(d.status)}>{d.status}</Badge></td>
                <td className="mono faint" style={{ whiteSpace: 'nowrap' }}>{when(d.committedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value, foot, tone }: {
  label: string; value: string | number; foot?: string;
  tone?: 'ok' | 'taint' | 'danger';
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value${tone ? ` ${tone}` : ''}`}>{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- beliefs */

function Beliefs({
  beliefs, setBeliefs, onInvestigate,
}: {
  beliefs: Belief[];
  setBeliefs: (b: Belief[]) => void;
  onInvestigate: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<string>('list');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await api.beliefs(q.trim().length > 1 ? { q } : {});
      setBeliefs(r.beliefs);
      setMode(r.mode);
    }, 220);
    return () => clearTimeout(t);
  }, [q, setBeliefs]);

  const detail = beliefs.find((b) => b.id === open);

  return (
    <div className="split">
      <div className="card">
        <div className="card-head">
          <input type="search" placeholder="Search beliefs semantically…"
                 value={q} onChange={(e) => setQ(e.target.value)} />
          {mode === 'semantic' && <Badge tone="accent">vector search</Badge>}
        </div>
        <table>
          <thead>
            <tr>
              <th>Subject</th><th>Claim</th><th>Kind</th>
              <th>Confidence</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {beliefs.map((b) => (
              <tr key={b.id} className={`clickable${open === b.id ? ' selected' : ''}`}
                  onClick={() => setOpen(b.id)}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{b.subject}</td>
                <td className="truncate">{b.claim}</td>
                <td><Badge>{b.kind}</Badge></td>
                <td><Confidence value={b.confidence} /></td>
                <td><Badge tone={statusTone(b.status)}>{b.status}</Badge></td>
              </tr>
            ))}
            {beliefs.length === 0 && (
              <tr><td colSpan={5}><div className="empty">No beliefs match.</div></td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head"><h3>Provenance</h3></div>
        <div className="card-body">
          {!detail && <div className="empty">Select a belief to inspect where it came from.</div>}
          {detail && (
            <div className="col" style={{ gap: 12 }}>
              <div className={`claim${detail.status !== 'active' ? ' tainted' : ''}`}>
                {detail.claim}
              </div>
              <dl className="kv">
                <dt>id</dt><dd><Id value={detail.id} /></dd>
                <dt>kind</dt><dd>{detail.kind}</dd>
                <dt>source</dt><dd>{detail.sourceKind}</dd>
                {detail.sourceRef && (
                  <>
                    <dt>evidence</dt>
                    <dd className="mono" style={{ fontSize: 11 }}>{detail.sourceRef}</dd>
                  </>
                )}
                {detail.derivedFromDecision && (
                  <>
                    <dt>inferred from</dt>
                    <dd><Id value={detail.derivedFromDecision} /> <span className="faint">(a decision)</span></dd>
                  </>
                )}
                <dt>confidence</dt><dd className="num">{detail.confidence.toFixed(2)}</dd>
                <dt>status</dt><dd><Badge tone={statusTone(detail.status)}>{detail.status}</Badge></dd>
                <dt>valid from</dt><dd className="mono" style={{ fontSize: 11 }}>{when(detail.validFrom)}</dd>
              </dl>
              <button className="btn primary" onClick={() => onInvestigate(detail.id)}>
                Trace blast radius
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- investigate */

function Investigate({
  beliefs, selected, setSelected, onChanged,
}: {
  beliefs: Belief[];
  selected: string | null;
  setSelected: (id: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.blastRadius>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const belief = beliefs.find((b) => b.id === selected) ?? null;

  useEffect(() => {
    if (!selected) { setResult(null); return; }
    void api.blastRadius(selected).then(setResult);
  }, [selected]);

  const markFalse = async () => {
    if (!belief) return;
    setBusy(true);
    await api.retract(belief.id, 'Contradicted by published tariff');
    await onChanged();
    setResult(await api.blastRadius(belief.id));
    setBusy(false);
  };

  const revertAll = async () => {
    if (!result) return;
    setBusy(true);
    const r = await api.revert(result.decisions.map((d) => d.id), 'contaminated by falsified belief');
    await onChanged();
    setResult(await api.blastRadius(result.beliefId));
    setDone(`Reverted ${r.reverted} decision${r.reverted === 1 ? '' : 's'}, queued ${r.compensations} compensating effect${r.compensations === 1 ? '' : 's'}.`);
    setBusy(false);
  };

  const exposure = result?.decisions.reduce((sum, d) => {
    const p = d.payload as { amount_usd?: number };
    return sum + (typeof p.amount_usd === 'number' ? p.amount_usd : 0);
  }, 0) ?? 0;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Which belief turned out to be false?</h3>
        </div>
        <div className="card-body">
          <div className="row wrap" style={{ gap: 6 }}>
            {beliefs.filter((b) => b.kind === 'semantic' || b.kind === 'procedural').map((b) => (
              <button key={b.id}
                      className={`btn${selected === b.id ? ' primary' : ''}`}
                      onClick={() => { setSelected(b.id); setDone(null); }}>
                {b.subject}
              </button>
            ))}
          </div>
        </div>
      </div>

      {belief && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>{belief.subject}</h3>
              <Badge tone={statusTone(belief.status)}>{belief.status}</Badge>
              <div className="spacer" />
              {belief.status === 'active' && (
                <button className="btn danger" onClick={markFalse} disabled={busy}>
                  Mark as false
                </button>
              )}
            </div>
            <div className="card-body">
              <div className={`claim${belief.status !== 'active' ? ' tainted' : ''}`}>
                {belief.claim}
              </div>
              <div className="row faint" style={{ marginTop: 8, fontSize: 11.5 }}>
                <span>from {belief.sourceKind}</span>
                {belief.sourceRef && <span className="mono">{belief.sourceRef}</span>}
              </div>
            </div>
          </div>

          {result && result.decisions.length > 0 && (
            <>
              <div className="grid-3">
                <Stat label="Decisions contaminated" value={result.decisions.length} tone="taint"
                      foot={`across ${result.generations} generation${result.generations > 1 ? 's' : ''}`} />
                <Stat label="Financial exposure" value={`$${exposure.toLocaleString()}`} tone="taint"
                      foot="money already moved" />
                <Stat label="Traced in" value={`${result.tookMs}ms`}
                      foot="one recursive SQL query" />
              </div>

              {done && <div className="banner"><span className="dot" />{done}</div>}

              <div className="card">
                <div className="card-head">
                  <h3>Contamination chain</h3>
                  <span className="hint">
                    left to right: the false belief, then each generation it reached
                  </span>
                </div>
                <div className="card-body" style={{ overflowX: 'auto' }}>
                  <LineageGraph origin={belief} decisions={result.decisions} />
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>Affected decisions</h3>
                  <div className="spacer" />
                  <button className="btn danger" onClick={revertAll}
                          disabled={busy || result.decisions.every((d) => d.status !== 'committed')}>
                    Revert all {result.decisions.length}
                  </button>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Gen</th><th>Action</th><th>Amount</th>
                      <th>Rationale</th><th>Status</th><th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.decisions.map((d) => (
                      <tr key={d.id} className="tainted">
                        <td>
                          <Badge tone={Number(d.generation) === 0 ? 'danger' : 'taint'}>
                            {Number(d.generation) === 0 ? 'direct' : `+${d.generation}`}
                          </Badge>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>{d.action.replace(/_/g, ' ')}</td>
                        <td className="num">{money(d.payload) ?? <span className="faint">—</span>}</td>
                        <td className="muted truncate">{d.rationale}</td>
                        <td><Badge tone={statusTone(d.status)}>{d.status}</Badge></td>
                        <td className="mono faint" style={{ whiteSpace: 'nowrap' }}>{when(d.committedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {result && result.decisions.length === 0 && (
            <div className="card">
              <div className="empty">
                Nothing downstream. No committed decision used this belief.
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------- resilience */

function Resilience({ health }: { health: Health | null }) {
  const [log, setLog] = useState<Array<{ at: string; ok: boolean; ms: number; live: number }>>([]);

  useEffect(() => {
    if (!health) return;
    setLog((prev) => [
      { at: new Date(health.at).toLocaleTimeString(), ok: health.ok, ms: health.latencyMs, live: health.liveNodes },
      ...prev,
    ].slice(0, 24));
  }, [health]);

  const degraded = health?.topologyAvailable && health.liveNodes < health.totalNodes;

  return (
    <>
      {degraded && (
        <div className="banner">
          <span className="dot pulse" />
          <div>
            <strong>{health!.totalNodes - health!.liveNodes} node down.</strong>{' '}
            Memory is still serving reads and writes.
          </div>
        </div>
      )}

      <div className="grid-3">
        <Stat label="Memory available" value={health?.ok ? 'yes' : 'no'}
              tone={health?.ok ? 'ok' : 'danger'} foot="can we still read beliefs?" />
        <Stat label="Read latency" value={health ? `${health.latencyMs}ms` : '—'}
              foot="round trip, live query" />
        <Stat label="Nodes live"
              value={health?.topologyAvailable ? `${health.liveNodes}/${health.totalNodes}` : 'n/a'}
              tone={degraded ? 'taint' : 'ok'}
              foot={health?.topologyAvailable ? 'local 3-node cluster' : 'serverless — no topology'} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Nodes</h3>
          <span className="hint">
            kill one with <code className="mono">npm run chaos:kill</code>
          </span>
        </div>
        <div className="card-body">
          {!health?.topologyAvailable && (
            <div className="empty">
              This target is serverless, so there is no node topology to show.
              The chaos demo runs against the local 3-node cluster.
            </div>
          )}
          <div className="row wrap" style={{ gap: 10 }}>
            {health?.nodes.map((n) => (
              <div key={n.id} className="stat" style={{ minWidth: 150 }}>
                <div className="label">node {n.id}</div>
                <div className={`value ${n.live ? 'ok' : 'danger'}`} style={{ fontSize: 16 }}>
                  {n.live ? 'live' : 'down'}
                </div>
                <div className="foot mono" style={{ fontSize: 10.5 }}>{n.address}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Availability probe</h3>
          <span className="hint">a real memory read, every 2 seconds</span>
        </div>
        <table>
          <thead><tr><th>Time</th><th>Result</th><th>Latency</th><th>Nodes live</th></tr></thead>
          <tbody>
            {log.map((l, i) => (
              <tr key={i}>
                <td className="mono faint">{l.at}</td>
                <td><Badge tone={l.ok ? 'ok' : 'danger'} dot>{l.ok ? 'served' : 'failed'}</Badge></td>
                <td className="num">{l.ms}ms</td>
                <td className="num">{l.live || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ audit */

function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  useEffect(() => { void api.audit().then((r) => setEntries(r.entries)); }, []);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Audit log</h3>
        <span className="hint">append-only; every memory mutation is recorded</span>
      </div>
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Operation</th><th>Target</th><th>Detail</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="mono faint" style={{ whiteSpace: 'nowrap' }}>{when(e.at)}</td>
              <td className="mono">{e.actor}</td>
              <td><Badge tone={e.operation === 'revert' || e.operation === 'retract' ? 'danger' : 'neutral'}>{e.operation}</Badge></td>
              <td className="faint">{e.targetKind} <Id value={e.targetId} /></td>
              <td className="muted truncate mono" style={{ fontSize: 11 }}>
                {e.detail ? JSON.stringify(e.detail) : '—'}
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr><td colSpan={5}><div className="empty">No audit entries yet.</div></td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------- misc */

function ClusterPill({ health }: { health: Health | null }) {
  if (!health) return <span className="id">connecting…</span>;
  const degraded = health.topologyAvailable && health.liveNodes < health.totalNodes;
  return (
    <div className="col" style={{ gap: 5 }}>
      <Badge tone={!health.ok ? 'danger' : degraded ? 'taint' : 'ok'} dot pulse={degraded}>
        {!health.ok ? 'memory unavailable' : degraded ? 'degraded, serving' : 'healthy'}
      </Badge>
      <span className="id">
        {health.topologyAvailable ? `${health.liveNodes}/${health.totalNodes} nodes · ` : ''}
        {health.latencyMs}ms
      </span>
    </div>
  );
}

function Logo() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3a9 9 0 0 1 9 9M12 21a9 9 0 0 1-9-9" />
      <path d="M12 7.5V4M16.5 12H20" />
    </svg>
  );
}
