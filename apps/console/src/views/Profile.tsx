import { useMemo, useState } from 'react';
import { api } from '../lib/api.ts';
import type { Bootstrap, Memory, WikiPage } from '../lib/api.ts';
import { Badge, Drawer, Empty, Markdown, relTime, useAsync } from '../lib/ui.tsx';

/**
 * About you — laid out as a wiki article.
 *
 * The content was always here; it was presented as a stack of dashboard cards,
 * which is the wrong shape for something you read top to bottom. An encyclopedia
 * article is the right reference: a lead paragraph that stands alone, a
 * contents list you can jump from, sections with real headings, an infobox of
 * facts at a glance, and citations under every claim.
 *
 * The citation part is not decoration. This page is generated, and a generated
 * profile you cannot check is just something to trust. Every line here traces
 * back to a memory you can open, which is the difference between a summary and
 * a reference.
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

  // Headings become the contents list. Parsed from the markdown rather than
  // stored, so the two can never drift apart.
  const toc = useMemo(() => {
    if (!profile?.bodyMd) return [];
    return [...profile.bodyMd.matchAll(/^##\s+(.+)$/gm)].map((m) => ({
      text: m[1].trim(),
      id: m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    }));
  }, [profile?.bodyMd]);

  if (!pages.data) {
    return <div className="skeleton" style={{ height: 320 }} />;
  }

  if (!profile) {
    return (
      <div className="card">
        <Empty
          title="Nothing written yet"
          hint="This page is built from what you have saved. Save a few things — or answer a question in “fill the gaps” — and it will write itself."
        />
      </div>
    );
  }

  return (
    <>
      {profile.stale && (
        <div className="banner warn">
          <span className="dot" />
          <div className="body">
            <strong>Something this was based on has changed.</strong> A memory behind this page
            was corrected or removed, so parts of it may be out of date.
          </div>
        </div>
      )}

      <div className="wiki">
        <article className="wiki-body">
          <header className="wiki-head">
            <h1>{profile.title}</h1>
            <div className="wiki-meta">
              Updated {relTime(profile.generatedAt)} · built from{' '}
              <strong>{profile.sourceCount}</strong> of your memories · written by rules, not a
              language model
            </div>
          </header>

          {profile.summary && <p className="wiki-lead">{profile.summary}</p>}

          <div className="prose wiki-prose">
            <Markdown text={profile.bodyMd} />
          </div>

          {profile.citations && profile.citations.length > 0 && (
            <section className="wiki-refs" id="sources">
              <h2>Sources</h2>
              <p className="faint" style={{ fontSize: 14.5 }}>
                Every claim above came from one of these. Open one to read it in full.
              </p>
              <ol className="ref-list">
                {profile.citations.map((c, i) => (
                  <li key={c.memoryId + i}>
                    <button className="ref-link" onClick={() => setOpenSource(c.memoryId)}>
                      {c.memoryTitle ?? c.claim}
                    </button>
                    {c.memoryStatus && c.memoryStatus !== 'active' && (
                      <Badge tone="warn">{c.memoryStatus}</Badge>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </article>

        <aside className="wiki-side">
          <div className="infobox">
            <div className="infobox-head">At a glance</div>
            <dl>
              <div><dt>Memories</dt><dd>{boot.counts.memories}</dd></div>
              <div><dt>Preferences</dt><dd>{prefs.data?.length ?? '—'}</dd></div>
              <div><dt>People &amp; tools</dt><dd>{boot.counts.entities}</dd></div>
              <div><dt>Projects</dt><dd>{boot.workspaces.length}</dd></div>
              <div><dt>Tools connected</dt><dd>{boot.connections.length}</dd></div>
            </dl>
            {boot.connections.length > 0 && (
              <div className="infobox-foot">
                {boot.connections.map((c) => c.client_name).join(', ')}
              </div>
            )}
          </div>

          {toc.length > 0 && (
            <nav className="toc">
              <div className="toc-head">Contents</div>
              <ol>
                {toc.map((t, i) => (
                  <li key={t.id}>
                    <a href={`#${t.id}`}>
                      <span className="toc-n">{i + 1}</span>
                      {t.text}
                    </a>
                  </li>
                ))}
                {profile.citations?.length ? (
                  <li>
                    <a href="#sources">
                      <span className="toc-n">{toc.length + 1}</span>Sources
                    </a>
                  </li>
                ) : null}
              </ol>
            </nav>
          )}

          {others.length > 0 && (
            <nav className="toc">
              <div className="toc-head">Related pages</div>
              <ol>
                {others.map((p) => (
                  <li key={p.id}>
                    <a href={`#${p.slug}`}>{p.title}</a>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </aside>
      </div>

      {others.map((p) => (
        <article className="wiki-body sub" id={p.slug} key={p.id}>
          <h2>{p.title}</h2>
          <div className="wiki-meta">
            Updated {relTime(p.generatedAt)} · {p.sourceCount} sources
            {p.stale && <> · <Badge tone="warn">may be out of date</Badge></>}
          </div>
          <div className="prose wiki-prose">
            <Markdown text={p.bodyMd} />
          </div>
        </article>
      ))}

      {openSource && (
        <SourceDrawer id={openSource} onClose={() => setOpenSource(null)} toast={toast} />
      )}
    </>
  );
}

function SourceDrawer({
  id, onClose,
}: {
  id: string;
  onClose: () => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
}) {
  const mem = useAsync(() => api.memory(id), [id]);
  return (
    <Drawer title="Source" onClose={onClose}>
      {!mem.data ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : (
        <>
          <h3 style={{ marginBottom: 8 }}>{mem.data.memory.title}</h3>
          <div className="faint" style={{ fontSize: 13.5, marginBottom: 16 }}>
            {mem.data.memory.kind} · saved by {mem.data.memory.client} ·{' '}
            {relTime(mem.data.memory.createdAt)}
          </div>
          <div className="prose">{mem.data.memory.body}</div>
        </>
      )}
    </Drawer>
  );
}
