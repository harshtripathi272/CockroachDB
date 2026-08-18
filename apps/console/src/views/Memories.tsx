import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { Fallout, Memory } from '../lib/api.ts';
import {
  Badge, Confidence, Drawer, Empty, Id, kindTone, relTime, statusTone, useAsync,
} from '../lib/ui.tsx';

const KINDS = ['fact', 'preference', 'decision', 'event', 'insight', 'doc', 'task', 'question'];

export function Memories({
  workspace,
  toast,
  reload,
}: {
  workspace: string | null;
  toast: (m: string, t?: 'ok' | 'danger') => void;
  reload: () => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tookMs, setTookMs] = useState<number | null>(null);

  // Debounced so typing does not fire an embedding per keystroke — each search
  // embeds the query, which is real work rather than a string comparison.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 260);
    return () => clearTimeout(t);
  }, [query]);

  const list = useAsync<Memory[]>(async () => {
    if (debounced) {
      const r = await api.search(debounced, { workspace, kind: kind || undefined, limit: 40 });
      setTookMs(r.tookMs);
      return r.results;
    }
    setTookMs(null);
    return api.memories({ workspace, kind: kind || undefined, limit: 80 });
  }, [debounced, workspace, kind]);

  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <div className="search-wrap">
          <span className="ico">⌕</span>
          <input
            className="input"
            placeholder="Ask in your own words — “what do I think about testing?”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="input"
          style={{ width: 'auto' }}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <button className="btn primary" onClick={() => setAdding(true)}>Add</button>
      </div>

      {debounced && (
        <div className="faint" style={{ fontSize: 13 }}>
          {list.data?.length ?? 0} semantic matches
          {tookMs !== null && ` · ${tookMs}ms`}
          {' · ranked by meaning, not keywords'}
        </div>
      )}

      <div className="card">
        {list.loading && !list.data ? (
          <div className="card-body col" style={{ gap: 8 }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 52 }} />
            ))}
          </div>
        ) : !list.data?.length ? (
          <Empty
            icon="≡"
            title={debounced ? `Nothing matches “${debounced}”` : 'No memories yet'}
            hint={
              debounced
                ? 'Try describing it differently — search matches meaning, so exact words are not required.'
                : 'Connect a tool on the Setup page, or add one by hand.'
            }
          />
        ) : (
          list.data.map((m) => (
            <div
              key={m.id}
              className={`mem${m.status === 'retracted' ? ' retracted' : ''}`}
              onClick={() => setSelected(m.id)}
            >
              <div className="mem-title">{m.title}</div>
              <div className="mem-body">{m.body}</div>
              <div className="mem-meta">
                <Badge tone={kindTone(m.kind)}>{m.kind}</Badge>
                {m.status !== 'active' && <Badge tone={statusTone(m.status)}>{m.status}</Badge>}
                <Confidence value={m.confidence} evidence={m.evidenceCount} />
                {m.evidenceCount > 1 && <span>seen {m.evidenceCount}×</span>}
                <span>·</span>
                <span>{m.client}</span>
                {m.workspaceName && (
                  <>
                    <span>·</span>
                    <span>{m.workspaceName}</span>
                  </>
                )}
                <span>·</span>
                <span>{relTime(m.createdAt)}</span>
                {m.score !== undefined && (
                  <>
                    <div className="spacer" />
                    <span className="mono" title="cosine similarity">
                      {m.score.toFixed(3)}
                    </span>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {selected && (
        <MemoryDetail
          id={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            list.reload();
            reload();
          }}
          toast={toast}
        />
      )}

      {adding && (
        <AddMemory
          workspace={workspace}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            list.reload();
            reload();
          }}
          toast={toast}
        />
      )}
    </>
  );
}

/**
 * One memory, everything about it.
 *
 * The correction flow lives here because this is where the user has the context
 * to judge it: they can see what the memory says, what it was derived from, and
 * what depends on it, all before deciding to retract.
 */
function MemoryDetail({
  id,
  onClose,
  onChanged,
  toast,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
}) {
  const detail = useAsync(() => api.memory(id), [id]);
  const trace = useAsync<Fallout>(() => api.trace(id), [id]);
  const [correcting, setCorrecting] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const m = detail.data?.memory;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.correct(id, {
        reason,
        replacement: replacement.trim() || undefined,
      });
      const n = r.fallout.memories.length;
      toast(
        n > 0
          ? `Retracted. ${n} downstream memor${n === 1 ? 'y needs' : 'ies need'} review.`
          : 'Retracted. Nothing else depended on it.',
        'ok',
      );
      setCorrecting(false);
      detail.reload();
      trace.reload();
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      title={m?.title ?? 'Memory'}
      onClose={onClose}
      actions={
        m?.status === 'active' && !correcting ? (
          <button className="btn danger sm" onClick={() => setCorrecting(true)}>
            This is wrong
          </button>
        ) : null
      }
    >
      {!m ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : (
        <>
          <div className="row wrap" style={{ gap: 6 }}>
            <Badge tone={kindTone(m.kind)}>{m.kind}</Badge>
            <Badge tone={statusTone(m.status)}>{m.status}</Badge>
            <Confidence value={m.confidence} evidence={m.evidenceCount} />
            <span className="faint" style={{ fontSize: 13 }}>
              via {m.client} · {relTime(m.createdAt)}
            </span>
            <div className="spacer" />
            <Id value={m.id} />
          </div>

          <div className="card">
            <div className="card-body prose" style={{ fontSize: 14.5 }}>
              {m.body}
            </div>
          </div>

          {correcting && (
            <div className="card">
              <div className="card-head">
                <h3>Correct this memory</h3>
                <span className="hint">it is retracted, never deleted</span>
              </div>
              <div className="card-body col" style={{ gap: 10 }}>
                {trace.data && trace.data.memories.length > 0 && (
                  <div className="banner warn">
                    <span className="dot" />
                    <div className="body">
                      <strong>
                        {trace.data.memories.length} other memor
                        {trace.data.memories.length === 1 ? 'y was' : 'ies were'} derived from
                        this.
                      </strong>{' '}
                      They will be flagged for review.
                    </div>
                  </div>
                )}
                <div className="field">
                  <label>What is actually true? (optional)</label>
                  <textarea
                    className="input"
                    rows={3}
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                    placeholder="Leave blank to simply retract it."
                  />
                </div>
                <div className="field">
                  <label>Why was it wrong?</label>
                  <input
                    className="input"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="changed my mind / was never true / out of date"
                  />
                </div>
                <div className="row">
                  <div className="spacer" />
                  <button className="btn ghost" onClick={() => setCorrecting(false)}>Cancel</button>
                  <button className="btn danger" onClick={submit} disabled={busy}>
                    {busy ? 'Retracting…' : 'Retract'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {detail.data!.sources.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>Derived from</h3>
                <span className="hint">where this came from</span>
              </div>
              {detail.data!.sources.map((s) => (
                <div className="mem" key={s.id}>
                  <div className="mem-title">{s.title}</div>
                  <div className="mem-body">{s.body}</div>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <h3>What was built on this</h3>
              <span className="hint">
                {trace.data ? `traced in ${trace.data.tookMs}ms` : 'tracing…'}
              </span>
            </div>
            {!trace.data?.memories.length ? (
              <Empty title="Nothing derived from it yet" />
            ) : (
              trace.data.memories.map((d) => (
                <div className="mem" key={d.id}>
                  <div className="mem-title">
                    <span className="faint mono" style={{ fontSize: 13 }}>
                      {'→'.repeat(d.hops ?? 1)}{' '}
                    </span>
                    {d.title}
                  </div>
                  <div className="mem-body">{d.body}</div>
                  <div className="mem-meta">
                    <Badge tone={kindTone(d.kind)}>{d.kind}</Badge>
                    <span>{d.hops} hop{d.hops === 1 ? '' : 's'} away</span>
                  </div>
                </div>
              ))
            )}
          </div>

          {detail.data!.pages.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>Cited by</h3>
                <span className="hint">pages that used this as a source</span>
              </div>
              <div className="card-body col" style={{ gap: 6 }}>
                {detail.data!.pages.map((p) => (
                  <div key={p.id} className="row">
                    <span>{p.title}</span>
                    {p.stale && <Badge tone="warn">stale</Badge>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

function AddMemory({
  workspace,
  onClose,
  onSaved,
  toast,
}: {
  workspace: string | null;
  onClose: () => void;
  onSaved: () => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('fact');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.createMemory({
        title, body, kind, workspaceId: workspace, confidence: 0.7,
      });
      toast(
        r.reinforced
          ? `Already knew this — reinforced instead (now ${r.memory.evidenceCount}×)`
          : 'Stored',
        'ok',
      );
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="Add a memory" onClose={onClose}>
      <div className="field">
        <label>Title</label>
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="A short label"
          autoFocus
        />
      </div>
      <div className="field">
        <label>What should be remembered?</label>
        <textarea
          className="input"
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write it so it makes sense with no surrounding conversation."
        />
      </div>
      <div className="field">
        <label>Kind</label>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>
      <div className="row">
        <div className="faint" style={{ fontSize: 13 }}>
          Near-identical memories are merged rather than duplicated.
        </div>
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || title.trim().length < 2 || body.trim().length < 8}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Drawer>
  );
}
