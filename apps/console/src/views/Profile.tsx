import { useState } from 'react';
import { api } from '../lib/api.ts';
import type { Bootstrap, Memory, WikiPage } from '../lib/api.ts';
import {
  Badge, Confidence, Drawer, Empty, Markdown, relTime, useAsync,
} from '../lib/ui.tsx';

/**
 * Profile — what Orbis knows about you.
 *
 * The page is generated, and every claim on it is traceable to the raw
 * memories it came from. That is the point: a summariser produces something you
 * have to trust, whereas this produces something you can check. Clicking a
 * source opens the memory that supports it.
 */
export function Profile({
  boot,
  workspace,
  toast,
}: {
  boot: Bootstrap;
  workspace: string | null;
  toast: (m: string, t?: 'ok' | 'danger') => void;
}) {
  const pages = useAsync<WikiPage[]>(() => api.wiki({ workspace }), [workspace]);
  const prefs = useAsync<Memory[]>(
    () => api.memories({ kind: 'preference', status: 'active', limit: 60 }),
    [],
  );
  const [openSource, setOpenSource] = useState<string | null>(null);

  const profile = pages.data?.find((p) => p.kind === 'profile');
  const others = pages.data?.filter((p) => p.kind !== 'profile') ?? [];

  return (
    <>
      <div className="grid-4">
        <div className="stat">
          <div className="label">Memories</div>
          <div className="value">{boot.counts.memories}</div>
          <div className="foot">across {boot.workspaces.length} workspaces</div>
        </div>
        <div className="stat">
          <div className="label">Preferences</div>
          <div className="value">{prefs.data?.length ?? '—'}</div>
          <div className="foot">how you like to work</div>
        </div>
        <div className="stat">
          <div className="label">Entities</div>
          <div className="value">{boot.counts.entities}</div>
          <div className="foot">people, tools, projects</div>
        </div>
        <div className="stat">
          <div className="label">Tools connected</div>
          <div className="value">{boot.connections.length}</div>
          <div className="foot">
            {boot.connections.map((c) => c.client_name).join(', ') || 'none yet'}
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------- profile */}
      <div className="card">
        <div className="card-head">
          <h3>About you</h3>
          <span className="hint">
            {profile
              ? `generated from ${profile.sourceCount} memories · ${relTime(profile.generatedAt)}`
              : 'not generated yet'}
          </span>
          <div className="spacer" />
          {profile?.stale && <Badge tone="warn">stale</Badge>}
        </div>

        {!profile ? (
          <Empty
            icon="◍"
            title="No profile yet"
            hint="Run the consolidation pass once there are memories to work from — npm run dream"
          />
        ) : (
          <div className="card-body">
            <Markdown text={profile.bodyMd} />

            {profile.citations && profile.citations.length > 0 && (
              <>
                <div className="divider" style={{ margin: '16px 0 10px' }} />
                <div className="faint" style={{ fontSize: 13, marginBottom: 6 }}>
                  EVERY CLAIM ABOVE COMES FROM ONE OF THESE
                </div>
                <div className="row wrap" style={{ gap: 5 }}>
                  {profile.citations.map((c) => (
                    <button
                      key={c.memoryId + c.claim}
                      className="btn sm"
                      style={{ fontSize: 13 }}
                      onClick={() => setOpenSource(c.memoryId)}
                      title={c.claim || c.memoryTitle}
                    >
                      {c.memoryStatus === 'retracted' && (
                        <span className="dot" style={{ color: 'var(--danger)' }} />
                      )}
                      {c.memoryTitle ?? c.memoryId.slice(0, 8)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ preferences */}
      <div className="card">
        <div className="card-head">
          <h3>How you like to work</h3>
          <span className="hint">handed to every agent that connects</span>
          <div className="spacer" />
          <span className="faint" style={{ fontSize: 13 }}>
            stronger evidence ranks higher
          </span>
        </div>

        {!prefs.data?.length ? (
          <Empty
            title="No preferences recorded"
            hint="These accumulate as your agents notice how you work — or answer a few questions on the Train page."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Preference</th>
                <th style={{ width: 110 }}>Confidence</th>
                <th style={{ width: 90 }}>Evidence</th>
                <th style={{ width: 110 }}>Source</th>
              </tr>
            </thead>
            <tbody>
              {[...prefs.data]
                .sort((a, b) => b.confidence - a.confidence)
                .map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => setOpenSource(p.id)}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{p.title}</div>
                      <div className="muted" style={{ fontSize: 13.5 }}>{p.body}</div>
                    </td>
                    <td>
                      <Confidence value={p.confidence} evidence={p.evidenceCount} />
                    </td>
                    <td className="faint">
                      {p.evidenceCount === 1 ? 'stated once' : `seen ${p.evidenceCount}×`}
                    </td>
                    <td className="faint">{p.client}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ------------------------------------------------------ other pages */}
      {others.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Generated pages</h3>
            <span className="hint">consolidated views over your memories</span>
          </div>
          <table>
            <thead>
              <tr><th>Page</th><th>Kind</th><th className="num">Sources</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {others.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.title}</strong>
                    {p.stale && <Badge tone="warn">stale</Badge>}
                    {p.summary && (
                      <div className="muted" style={{ fontSize: 13.5 }}>{p.summary}</div>
                    )}
                  </td>
                  <td><Badge>{p.kind}</Badge></td>
                  <td className="num">{p.sourceCount}</td>
                  <td className="faint">{relTime(p.generatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openSource && (
        <SourceDrawer id={openSource} onClose={() => setOpenSource(null)} toast={toast} />
      )}
    </>
  );
}

function SourceDrawer({
  id,
  onClose,
  toast,
}: {
  id: string;
  onClose: () => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
}) {
  const d = useAsync(() => api.memory(id), [id]);
  const m = d.data?.memory;

  return (
    <Drawer title={m?.title ?? 'Source'} onClose={onClose}>
      {!m ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : (
        <>
          <div className="row wrap" style={{ gap: 6 }}>
            <Badge>{m.kind}</Badge>
            <Badge tone={m.status === 'active' ? 'ok' : 'danger'}>{m.status}</Badge>
            <Confidence value={m.confidence} evidence={m.evidenceCount} />
            <span className="faint" style={{ fontSize: 13 }}>
              recorded by {m.client} · {relTime(m.createdAt)}
            </span>
          </div>
          <div className="card">
            <div className="card-body prose" style={{ fontSize: 14.5 }}>{m.body}</div>
          </div>
          {d.data!.sources.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Derived from</h3></div>
              {d.data!.sources.map((s) => (
                <div className="mem" key={s.id}>
                  <div className="mem-title">{s.title}</div>
                  <div className="mem-body">{s.body}</div>
                </div>
              ))}
            </div>
          )}
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(m.id);
              toast('Memory id copied');
            }}
          >
            Copy id
          </button>
        </>
      )}
    </Drawer>
  );
}
