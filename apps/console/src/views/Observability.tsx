import { useState } from 'react';
import { api } from '../lib/api.ts';
import type { Bootstrap, CloudStatus, ToolCall } from '../lib/api.ts';
import { Badge, Bars, CodeBlock, Empty, relTime, useAsync, usePoll } from '../lib/ui.tsx';

/**
 * Signals — what your agents are actually doing.
 *
 * Every number here comes from a table that real traffic writes to. Nothing is
 * synthesised for the sake of having a chart, which is why several panels are
 * empty until something has genuinely happened.
 */

type Tab = 'activity' | 'tools' | 'growth' | 'database' | 'cloud' | 'audit';

const TABS: Array<[Tab, string]> = [
  ['activity', 'Activity'],
  ['tools', 'Latency'],
  ['growth', 'Growth'],
  ['database', 'CockroachDB'],
  ['cloud', 'Cloud MCP'],
  ['audit', 'Audit'],
];

export function Observability({ boot }: { boot: Bootstrap }) {
  const [tab, setTab] = useState<Tab>('activity');

  return (
    <>
      <div className="grid-4">
        <div className="stat">
          <div className="label">Tool calls</div>
          <div className="value">{boot.counts.calls}</div>
          <div className="foot">all time</div>
        </div>
        <div className="stat">
          <div className="label">Clients</div>
          <div className="value">{boot.connections.length}</div>
          <div className="foot">
            {boot.connections.map((c) => c.client_name).join(', ') || 'none connected'}
          </div>
        </div>
        <div className="stat">
          <div className="label">Memories</div>
          <div className="value">{boot.counts.memories}</div>
          <div className="foot">{boot.counts.entities} entities extracted</div>
        </div>
        <div className="stat">
          <div className="label">Embeddings</div>
          <div className="value" style={{ fontSize: 15, lineHeight: 1.35, marginTop: 6 }}>
            {boot.embedder.semantic ? 'semantic' : 'degraded'}
          </div>
          <div className="foot">{boot.embedder.label}</div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            className={`tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'activity' && <Activity />}
      {tab === 'tools' && <Latency />}
      {tab === 'growth' && <Growth />}
      {tab === 'database' && <Database />}
      {tab === 'cloud' && <CloudMcp />}
      {tab === 'audit' && <Audit />}
    </>
  );
}

function Activity() {
  const calls = useAsync<ToolCall[]>(() => api.calls(80), []);
  const activity = useAsync(() => api.activity('24h'), []);
  usePoll(() => { calls.reload(); activity.reload(); }, 5000);

  // Bucket per hour across all clients, so the shape of the day is visible.
  const buckets = activity.data?.buckets ?? [];
  const byHour = new Map<string, number>();
  for (const b of buckets) {
    byHour.set(b.bucket, (byHour.get(b.bucket) ?? 0) + b.calls);
  }
  const series = [...byHour.entries()]
    .sort()
    .map(([bucket, value]) => ({ label: new Date(bucket).toLocaleTimeString([], { hour: '2-digit' }), value }));

  const clients = new Map<string, number>();
  for (const b of buckets) clients.set(b.client, (clients.get(b.client) ?? 0) + b.calls);

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Calls per hour</h3>
          <span className="hint">last 24 hours · live</span>
          <div className="spacer" />
          <Badge dot pulse tone="ok">streaming</Badge>
        </div>
        <div className="card-body">
          {series.length === 0 ? (
            <Empty title="No activity yet" hint="Connect a tool and use it — calls appear here in real time." />
          ) : (
            <>
              <Bars data={series} height={90} />
              <div className="row faint" style={{ fontSize: 13, marginTop: 6 }}>
                <span>{series[0]?.label}</span>
                <div className="spacer" />
                <span>now</span>
              </div>
            </>
          )}
        </div>
      </div>

      {clients.size > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Which tool is doing the work</h3>
            <span className="hint">the same memory, several clients</span>
          </div>
          <table>
            <thead>
              <tr><th>Client</th><th className="num">Calls</th><th>Share</th></tr>
            </thead>
            <tbody>
              {[...clients.entries()].sort((a, b) => b[1] - a[1]).map(([client, n]) => {
                const total = [...clients.values()].reduce((a, b) => a + b, 0);
                return (
                  <tr key={client}>
                    <td><strong>{client}</strong></td>
                    <td className="num">{n}</td>
                    <td>
                      <div style={{
                        height: 6, borderRadius: 3, background: 'var(--surface-3)',
                        width: 180, overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%', width: `${(n / total) * 100}%`,
                          background: 'var(--accent)',
                        }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Recent calls</h3>
          <span className="hint">every MCP and console request</span>
        </div>
        {!calls.data?.length ? (
          <Empty title="Nothing recorded yet" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th><th>Client</th><th>Tool</th>
                <th className="num">ms</th><th className="num">Results</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {calls.data.map((c) => (
                <tr key={c.id}>
                  <td className="faint">{relTime(c.at)}</td>
                  <td>{c.client}</td>
                  <td className="mono" style={{ fontSize: 13 }}>{c.tool}</td>
                  <td className="num">{c.latency_ms}</td>
                  <td className="num">{c.result_count || '—'}</td>
                  <td>
                    {c.ok ? (
                      <Badge tone="ok">ok</Badge>
                    ) : (
                      <Badge tone="danger" title={c.error ?? ''}>error</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Latency() {
  const stats = useAsync(() => api.toolStats(), []);
  const tools = stats.data?.tools ?? [];

  return (
    <div className="card">
      <div className="card-head">
        <h3>Per-tool latency</h3>
        <span className="hint">last 7 days · percentiles computed in SQL</span>
      </div>
      {!tools.length ? (
        <Empty title="No calls yet" hint="Latency percentiles need traffic to compute." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tool</th><th className="num">Calls</th>
              <th className="num">p50</th><th className="num">p95</th>
              <th className="num">max</th><th className="num">Errors</th><th>Shape</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.tool}>
                <td className="mono" style={{ fontSize: 13.5 }}>{t.tool}</td>
                <td className="num">{t.calls}</td>
                <td className="num">{t.p50}</td>
                <td className="num">{t.p95}</td>
                <td className="num">{t.max_ms}</td>
                <td className="num">
                  {t.errors ? <Badge tone="danger">{t.errors}</Badge> : <span className="faint">0</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: 150 }}>
                    <div style={{
                      height: 5, borderRadius: 3, background: 'var(--accent)',
                      width: `${Math.min(100, (t.p50 / Math.max(1, t.max_ms)) * 100)}%`,
                      minWidth: 3,
                    }} />
                    <div style={{
                      height: 5, borderRadius: 3, background: 'var(--border-strong)',
                      width: `${Math.min(100, ((t.p95 - t.p50) / Math.max(1, t.max_ms)) * 100)}%`,
                    }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Growth() {
  const growth = useAsync(() => api.growth(), []);
  const rows = growth.data ?? [];

  const byDay = new Map<string, number>();
  for (const r of rows) {
    const d = String(r.day).slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + r.n);
  }
  const series = [...byDay.entries()].sort().map(([label, value]) => ({ label, value }));

  const byKind = new Map<string, number>();
  for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + r.n);

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Memories added per day</h3>
          <span className="hint">last 30 days</span>
        </div>
        <div className="card-body">
          {series.length === 0 ? (
            <Empty title="Nothing yet" />
          ) : (
            <>
              <Bars data={series} height={90} />
              <div className="row faint" style={{ fontSize: 13, marginTop: 6 }}>
                <span>{series[0]?.label}</span>
                <div className="spacer" />
                <span>{series[series.length - 1]?.label}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>By kind</h3></div>
        <table>
          <thead><tr><th>Kind</th><th className="num">Count</th><th>Share</th></tr></thead>
          <tbody>
            {[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => {
              const total = [...byKind.values()].reduce((a, b) => a + b, 0);
              return (
                <tr key={kind}>
                  <td><Badge>{kind}</Badge></td>
                  <td className="num">{n}</td>
                  <td>
                    <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-3)', width: 200 }}>
                      <div style={{
                        height: '100%', width: `${(n / total) * 100}%`,
                        background: 'var(--info)', borderRadius: 3,
                      }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * CockroachDB itself.
 *
 * The EXPLAIN panel is the point of this tab. "We use a distributed vector
 * index" is a claim; a live query plan naming the index is evidence, and it
 * stays honest because it is generated on request rather than pasted in.
 */
function Database() {
  const crdb = useAsync(() => api.crdb(), []);
  const plans = useAsync(() => api.plans('what do I prefer'), []);

  const d = crdb.data;

  return (
    <>
      <div className="grid-3">
        <div className="stat">
          <div className="label">Health</div>
          <div className="value" style={{ fontSize: 19 }}>
            {d?.health?.ok ? 'reachable' : 'down'}
          </div>
          <div className="foot">round trip {d?.health?.latencyMs ?? '—'}ms</div>
        </div>
        <div className="stat">
          <div className="label">Transactions</div>
          <div className="value">{d?.retries?.transactions ?? 0}</div>
          <div className="foot">
            {d?.retries?.retries ?? 0} retried · {d?.retries?.exhausted ?? 0} gave up
          </div>
        </div>
        <div className="stat">
          <div className="label">Queries</div>
          <div className="value">{d?.retries?.queries ?? 0}</div>
          <div className="foot">since the server started</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Query plans, live</h3>
          <span className="hint">generated now — not a screenshot</span>
        </div>
        <div className="card-body col" style={{ gap: 12 }}>
          <div className="faint" style={{ fontSize: 13.5 }}>
            A vector index that is silently ignored still returns correct-looking rows, so the
            only way to know it is being used is to read the plan. Look for{' '}
            <code className="mono">vector search</code>.
          </div>
          {Object.entries(plans.data?.plans ?? {}).map(([label, text]) => {
            const used = /vector search/i.test(text);
            return (
              <div key={label}>
                <div className="row" style={{ marginBottom: 5 }}>
                  <strong style={{ fontSize: 13 }}>{label}</strong>
                  <Badge tone={used ? 'ok' : 'warn'}>
                    {used ? 'vector index used' : 'full scan'}
                  </Badge>
                </div>
                <CodeBlock code={text} />
              </div>
            );
          })}
          {!plans.data && <div className="skeleton" style={{ height: 120 }} />}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Indexes on memory</h3>
        </div>
        {!d?.indexes?.length ? (
          <Empty title="Index metadata unavailable" />
        ) : (
          <table>
            <thead><tr><th>Index</th><th>Column</th><th>Direction</th></tr></thead>
            <tbody>
              {d.indexes.map((i: any, n: number) => (
                <tr key={n}>
                  <td className="mono" style={{ fontSize: 13 }}>{i.index_name}</td>
                  <td className="mono" style={{ fontSize: 13 }}>{i.column_name}</td>
                  <td className="faint">{i.direction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Ranges and replicas</h3>
          <span className="hint">
            {d?.rangesError ? 'restricted on this cluster' : 'how the data is distributed'}
          </span>
        </div>
        {d?.rangesError ? (
          <div className="card-body faint" style={{ fontSize: 13.5 }}>
            {d.rangesError}
            <div style={{ marginTop: 6 }}>
              Serverless clusters do not expose node topology — this panel is populated when
              running against a multi-node cluster.
            </div>
          </div>
        ) : !d?.ranges?.length ? (
          <Empty title="No range information" />
        ) : (
          <table>
            <thead><tr><th>Range</th><th>Leaseholder</th><th>Replicas</th></tr></thead>
            <tbody>
              {d.ranges.map((r: any) => (
                <tr key={r.range_id}>
                  <td className="mono">{r.range_id}</td>
                  <td><Badge tone="accent">n{r.lease_holder}</Badge></td>
                  <td className="faint mono">{JSON.stringify(r.replicas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {d?.version && (
        <div className="faint mono" style={{ fontSize: 13 }}>{d.version}</div>
      )}
    </>
  );
}

/**
 * Orbis as an MCP *client*.
 *
 * Every other panel in this console looks inward. This one looks out: it
 * handshakes with CockroachDB Cloud's managed MCP server at
 * https://cockroachlabs.cloud/mcp, lists the tools that server advertises, and
 * lets you call the read-only ones and read the raw answer.
 *
 * The unconfigured state is a first-class state, not an error. It shows the
 * endpoint, the tools Orbis would call, and the exact steps to produce a key —
 * because "we integrate with X" and "we would integrate with X if you gave us a
 * credential" are different claims and the panel should not blur them.
 */
function CloudMcp() {
  const status = useAsync<CloudStatus>(() => api.cloud(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tool: string; text: string; ms: number; ok: boolean } | null>(null);
  const [sql, setSql] = useState(
    "SELECT id FROM memory WHERE status = 'active' ORDER BY embedding <=> '[0,0,0]'::VECTOR LIMIT 10",
  );

  const s = status.data;
  const live = Boolean(s?.configured && s?.reachable);

  async function run(tool: string, args: Record<string, unknown> = {}) {
    setBusy(tool);
    setResult(null);
    try {
      const r = await api.cloudCall(tool, args);
      setResult({ tool, text: r.text, ms: r.latencyMs, ok: r.ok });
    } catch (err) {
      setResult({ tool, text: (err as Error).message, ms: 0, ok: false });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>CockroachDB Cloud, over its managed MCP server</h3>
          <Badge tone={live ? 'ok' : s?.configured ? 'danger' : 'warn'}>
            {live ? 'connected' : s?.configured ? 'refused' : 'not configured'}
          </Badge>
        </div>
        <div className="card-body col" style={{ gap: 10 }}>
          <div className="faint" style={{ fontSize: 13.5 }}>
            Orbis is an MCP server — that is the whole product. This is the other direction:
            Orbis connecting out as an MCP <em>client</em> to a server it does not own, so the
            chat agent can ask CockroachDB about the cluster in the same turn it asks memory
            about you.
          </div>

          <table>
            <tbody>
              <tr>
                <td className="faint" style={{ width: 130 }}>Endpoint</td>
                <td className="mono" style={{ fontSize: 13 }}>{s?.url ?? '—'}</td>
              </tr>
              <tr>
                <td className="faint">Authentication</td>
                <td>
                  {s?.configured
                    ? <>service-account API key <span className="mono faint">{s.keyHint}</span></>
                    : <span className="faint">none — OAuth needs a browser, so a key is the only unattended option</span>}
                </td>
              </tr>
              <tr>
                <td className="faint">Scope</td>
                <td className="mono" style={{ fontSize: 13 }}>
                  {s?.clusterId
                    ? <>cluster {s.clusterId} <span className="faint">(mcp-cluster-id header)</span></>
                    : <span className="faint">every cluster the service account can reach</span>}
                </td>
              </tr>
              {live && (
                <>
                  <tr>
                    <td className="faint">Server</td>
                    <td>
                      {s?.server?.name ?? 'unnamed'}{' '}
                      <span className="faint mono">{s?.server?.version ?? ''}</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="faint">Protocol</td>
                    <td className="mono" style={{ fontSize: 13 }}>{s?.protocolVersion}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>

          {s && !live && (
            <div className="banner warn" style={{ margin: 0 }}>
              <span className="dot" />
              <div className="body">
                <strong>{s.error ?? s.reason}</strong>
                {s.hint && <div className="faint" style={{ marginTop: 4 }}>{s.hint}</div>}
                {!s.configured && (
                  <div style={{ marginTop: 8 }}>
                    <CodeBlock code={'CRDB_CLOUD_API_KEY=<service account secret> npm run api'} />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="row">
            <button className="btn" onClick={() => api.cloud(true).then(() => status.reload())}>
              Probe again
            </button>
            {s && <span className="faint" style={{ fontSize: 13 }}>checked {relTime(s.checkedAt)}</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Tools</h3>
          <span className="hint">
            {live
              ? `${s!.tools.length} advertised · ${s!.allowed.length} Orbis will call`
              : 'what Orbis would call, once a key exists'}
          </span>
        </div>
        <div className="card-body col" style={{ gap: 10 }}>
          <div className="faint" style={{ fontSize: 13.5 }}>
            The allowlist is enumerated in code, not derived from the server's own
            read-only hints. The Cloud server will register <code className="mono">insert_rows</code>,{' '}
            <code className="mono">update_rows</code> and <code className="mono">delete_rows</code> for
            a service account with the roles to use them, and a chat agent that can be talked
            into <code className="mono">delete_rows</code> on a production cluster is not a feature.
          </div>
          <table>
            <thead>
              <tr><th>Tool</th><th>Status</th><th>What it does</th></tr>
            </thead>
            <tbody>
              {(s?.allowlist ?? []).map((name) => {
                const found = s?.tools.find((t) => t.name === name);
                return (
                  <tr key={name}>
                    <td className="mono" style={{ fontSize: 13 }}>{name}</td>
                    <td>
                      {!live
                        ? <span className="faint">—</span>
                        : found
                          ? <Badge tone="ok">live</Badge>
                          : <Badge tone="warn">not offered</Badge>}
                    </td>
                    <td className="faint truncate" style={{ fontSize: 13 }}>
                      {found?.description ?? ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {live && s!.tools.some((t) => !s!.allowlist.includes(t.name)) && (
            <div className="faint" style={{ fontSize: 13 }}>
              Also advertised, and deliberately not called:{' '}
              <span className="mono">
                {s!.tools.filter((t) => !s!.allowlist.includes(t.name)).map((t) => t.name).join(', ')}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Run one</h3>
          <span className="hint">{live ? 'live, against your cluster' : 'needs a key'}</span>
        </div>
        <div className="card-body col" style={{ gap: 10 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {['get_cluster', 'list_cluster_nodes', 'list_databases', 'show_running_queries'].map((t) => (
              <button
                key={t}
                className="btn"
                disabled={!live || busy !== null}
                onClick={() => run(t)}
              >
                {busy === t ? 'running…' : t}
              </button>
            ))}
          </div>

          <div className="col" style={{ gap: 6 }}>
            <label className="faint" style={{ fontSize: 13 }}>
              explain_query — ask CockroachDB's own tooling whether the vector index is used
            </label>
            <textarea
              className="input mono"
              rows={3}
              style={{ fontSize: 13 }}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
            />
            <div>
              <button
                className="btn primary"
                disabled={!live || busy !== null}
                onClick={() => run('explain_query', { query: sql })}
              >
                {busy === 'explain_query' ? 'running…' : 'Explain'}
              </button>
            </div>
          </div>

          {result && (
            <div>
              <div className="row" style={{ marginBottom: 5 }}>
                <strong style={{ fontSize: 13 }} className="mono">{result.tool}</strong>
                <Badge tone={result.ok ? 'ok' : 'danger'}>{result.ok ? 'ok' : 'failed'}</Badge>
                {result.ms > 0 && <span className="faint" style={{ fontSize: 13 }}>{result.ms}ms</span>}
              </div>
              <CodeBlock code={result.text} />
            </div>
          )}

          {!status.data && <div className="skeleton" style={{ height: 80 }} />}
        </div>
      </div>
    </>
  );
}

function Audit() {
  const entries = useAsync(() => api.audit(150), []);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Audit log</h3>
        <span className="hint">append-only, written in the same transaction as each change</span>
      </div>
      {!entries.data?.length ? (
        <Empty title="Nothing yet" />
      ) : (
        <table>
          <thead>
            <tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {entries.data.map((e: any) => (
              <tr key={e.id}>
                <td className="faint">{relTime(e.at)}</td>
                <td className="mono" style={{ fontSize: 13 }}>{e.action}</td>
                <td className="faint">{e.target_kind}</td>
                <td className="faint mono truncate" style={{ fontSize: 13 }}>
                  {JSON.stringify(e.detail)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
