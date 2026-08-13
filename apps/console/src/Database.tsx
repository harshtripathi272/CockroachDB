import { useEffect, useState } from 'react';
import { api, type Health, type QueryPlan, type RangesResponse, type SchemaResponse } from './api';
import { Badge } from './components';

/**
 * "CockroachDB in action."
 *
 * Every other view shows what Recall does *with* the database. This one shows
 * the database itself doing distributed-database work, read live from the
 * cluster serving the app. Nothing here is illustrative or mocked.
 *
 * Three things are worth watching:
 *   - the replica map, where killing a node visibly moves leases
 *   - the query plans, which either say "vector search" or expose that we
 *     silently degraded to a full scan
 *   - the schema, showing memory really is relational tables, not a blob store
 */
export function Database({ health }: { health: Health | null }) {
  const [ranges, setRanges] = useState<RangesResponse | null>(null);
  const [plans, setPlans] = useState<QueryPlan[]>([]);
  const [schema, setSchema] = useState<SchemaResponse | null>(null);
  const [openPlan, setOpenPlan] = useState<string | null>('vector');

  // Ranges poll: leaseholders move within seconds of a node dying, and that
  // movement is the entire point of this panel.
  useEffect(() => {
    let alive = true;
    const tick = () => api.ranges().then((r) => alive && setRanges(r)).catch(() => {});
    void tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    void api.plans().then((r) => setPlans(r.plans)).catch(() => {});
    void api.schema().then(setSchema).catch(() => {});
  }, []);

  const nodes = health?.nodes ?? [];

  return (
    <>
      <div className="grid-3">
        <div className="stat">
          <div className="label">Replication factor</div>
          <div className="value ok">{ranges?.replicationFactor ?? '—'}×</div>
          <div className="foot">every range on {ranges?.replicationFactor ?? 3} nodes</div>
        </div>
        <div className="stat">
          <div className="label">Ranges</div>
          <div className="value">{ranges?.ranges.length ?? '—'}</div>
          <div className="foot">memory split across the cluster</div>
        </div>
        <div className="stat">
          <div className="label">Vector index</div>
          <div className={`value ${plans.find((p) => p.id === 'vector')?.usesVectorIndex ? 'ok' : 'danger'}`}
               style={{ fontSize: 17 }}>
            {plans.length === 0 ? '—' : plans.find((p) => p.id === 'vector')?.usesVectorIndex ? 'in use' : 'NOT USED'}
          </div>
          <div className="foot">verified against the live query plan</div>
        </div>
      </div>

      {/* ------------------------------------------------- replica placement */}
      <div className="card">
        <div className="card-head">
          <h3>Replica placement</h3>
          <span className="hint">
            ● = replica, ★ = leaseholder (the node serving reads for that range)
          </span>
        </div>

        {!ranges?.available && (
          <div className="empty">
            This target is serverless — CockroachDB Cloud Basic manages ranges for
            you and does not expose them to the tenant. Run against the local
            3-node cluster to watch replicas and leases move.
          </div>
        )}

        {ranges?.available && (
          <div className="card-body">
            <div className="row" style={{ gap: 12, marginBottom: 14 }}>
              {ranges.perNode.map((n) => {
                const dead = nodes.length > 0 && !nodes.find((x) => x.id === n.node)?.live;
                return (
                  <div key={n.node} className="stat" style={{ flex: 1, minWidth: 130 }}>
                    <div className="label">node {n.node}</div>
                    <div className={`value ${dead ? 'danger' : ''}`} style={{ fontSize: 15 }}>
                      {dead ? 'down' : `${n.leases} leases`}
                    </div>
                    <div className="foot">{n.replicas} replicas</div>
                  </div>
                );
              })}
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Range</th>
                    {ranges.perNode.map((n) => <th key={n.node}>node {n.node}</th>)}
                    <th>Span</th>
                  </tr>
                </thead>
                <tbody>
                  {ranges.ranges.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">r{r.id}</td>
                      {ranges.perNode.map((n) => {
                        const has = r.replicas.includes(n.node);
                        const lease = r.leaseHolder === n.node;
                        return (
                          <td key={n.node} style={{ textAlign: 'center' }}>
                            <span
                              title={lease ? 'leaseholder' : has ? 'replica' : 'no replica'}
                              style={{
                                color: lease ? 'var(--ok)' : has ? 'var(--text-faint)' : 'var(--border)',
                                fontSize: lease ? 14 : 12,
                              }}
                            >
                              {lease ? '★' : has ? '●' : '·'}
                            </span>
                          </td>
                        );
                      })}
                      <td className="id truncate" style={{ maxWidth: '28ch' }}>{r.span}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
              Kill a node and watch the ★ column empty out — its leases move to a
              surviving replica within seconds, and reads keep being served.
            </p>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ query plans */}
      <div className="card">
        <div className="card-head">
          <h3>Query plans</h3>
          <span className="hint">EXPLAIN, run live against the real statements this app issues</span>
        </div>
        <div className="card-body col" style={{ gap: 10 }}>
          {plans.length === 0 && <div className="empty">Loading plans…</div>}
          {plans.map((p) => (
            <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
              <button
                className="btn ghost"
                style={{ width: '100%', justifyContent: 'flex-start', padding: '9px 12px' }}
                onClick={() => setOpenPlan(openPlan === p.id ? null : p.id)}
              >
                <span style={{ fontWeight: 600 }}>{p.label}</span>
                {p.id === 'vector' && (
                  <Badge tone={p.usesVectorIndex ? 'ok' : 'danger'} dot>
                    {p.usesVectorIndex ? 'vector index' : 'FULL SCAN'}
                  </Badge>
                )}
                <span className="spacer" />
                <span className="id">{p.tookMs}ms</span>
                <span className="faint">{openPlan === p.id ? '−' : '+'}</span>
              </button>

              {openPlan === p.id && (
                <div style={{ borderTop: '1px solid var(--border)', padding: 12 }}>
                  <div className="faint" style={{ fontSize: 11.5, marginBottom: 8 }}>{p.why}</div>
                  <pre className="mono" style={{
                    background: 'var(--surface-2)', padding: 10, borderRadius: 'var(--radius)',
                    overflowX: 'auto', fontSize: 11, lineHeight: 1.45, marginBottom: 8,
                  }}>{p.sql}</pre>
                  <div className="label" style={{ marginBottom: 4 }}>Plan</div>
                  <pre className="mono" style={{
                    background: 'var(--surface-2)', padding: 10, borderRadius: 'var(--radius)',
                    overflowX: 'auto', fontSize: 11, lineHeight: 1.45,
                  }}>{p.plan}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ----------------------------------------------------------- schema */}
      <div className="card">
        <div className="card-head">
          <h3>Memory schema</h3>
          <span className="hint">agent memory is relational tables, not an opaque blob</span>
        </div>
        <div className="card-body">
          <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
            {schema?.tables.map((t) => (
              <div key={t.table_name} className="stat" style={{ minWidth: 128 }}>
                <div className="label">{t.table_name}</div>
                <div className="value" style={{ fontSize: 17 }}>
                  {t.estimated_row_count ?? 0}
                </div>
                <div className="foot">rows (est.)</div>
              </div>
            ))}
          </div>
          {schema && (
            <>
              <div className="label" style={{ marginBottom: 4 }}>Vector index</div>
              <pre className="mono" style={{
                background: 'var(--surface-2)', padding: 10, borderRadius: 'var(--radius)',
                overflowX: 'auto', fontSize: 11, lineHeight: 1.45,
              }}>{schema.vectorIndex.definition}</pre>
              <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
                <code className="mono">status</code> sits in the index prefix so quarantined
                beliefs are excluded by the index itself, not by a post-filter that
                could be forgotten. The operator class must match the query operator —
                a cosine query against a default L2 index silently full-scans.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
