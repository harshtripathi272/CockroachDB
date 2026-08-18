import { useState } from 'react';
import { api } from '../lib/api.ts';
import type { Bootstrap, Memory, TreeNode, Workspace } from '../lib/api.ts';
import { Badge, CodeBlock, Empty, kindTone, relTime, useAsync } from '../lib/ui.tsx';

/**
 * Projects — list, then one project in full.
 *
 * This page used to be a grid of cards where the only action, "view this
 * workspace", set a global filter and left you looking at the same grid. A
 * project is the main organising idea in the product and opening one did
 * nothing, which made the whole feature look decorative.
 *
 * So it is master–detail now. The list answers "what have I got"; the detail
 * answers "what is in this one, and how do I point a tool at just it". Nothing
 * is behind a tab that a person would need on first visit.
 */
export function Workspaces({
  boot,
  workspace,
  setWorkspace,
  toast,
  reload,
}: {
  boot: Bootstrap;
  workspace: string | null;
  setWorkspace: (id: string | null) => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
  reload: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const open = boot.workspaces.find((w) => w.id === openId);

  if (open) {
    return (
      <ProjectDetail
        ws={open}
        onBack={() => setOpenId(null)}
        isFilter={workspace === open.id}
        setWorkspace={setWorkspace}
        toast={toast}
      />
    );
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 4 }}>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>New project</button>
      </div>

      {boot.workspaces.length === 0 ? (
        <div className="card">
          <Empty
            title="No projects yet"
            hint="A project keeps one piece of work separate from the rest. Ask about deployment inside “Website” and you should never get the app's deployment notes back."
          />
        </div>
      ) : (
        <div className="grid-2">
          {boot.workspaces.map((w) => (
            <button key={w.id} className="proj-card" onClick={() => setOpenId(w.id)}>
              <div className="proj-card-top">
                <span className="proj-dot" style={{ background: w.color || 'var(--accent)' }} />
                <h3>{w.name}</h3>
                {w.isDefault && <Badge>default</Badge>}
              </div>
              <p className="proj-desc">
                {w.description || 'No description yet.'}
              </p>
              <div className="proj-card-foot">
                <span><strong>{w.memoryCount ?? 0}</strong> memories</span>
                <span className="faint">open →</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {creating && (
        <NewWorkspace
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); reload(); }}
          toast={toast}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

function ProjectDetail({
  ws, onBack, isFilter, setWorkspace, toast,
}: {
  ws: Workspace;
  onBack: () => void;
  isFilter: boolean;
  setWorkspace: (id: string | null) => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
}) {
  const memories = useAsync<Memory[]>(() => api.memories({ workspace: ws.id, limit: 60 }), [ws.id]);
  const tree = useAsync<TreeNode[]>(() => api.tree(ws.id), [ws.id]);
  const [adding, setAdding] = useState(false);
  const [folderName, setFolderName] = useState('');

  const origin = window.location.origin;

  async function addFolder() {
    const name = folderName.trim();
    if (name.length < 2) return;
    try {
      await api.createNode({ workspaceId: ws.id, name });
      setFolderName('');
      setAdding(false);
      tree.reload();
      toast(`Added “${name}”`);
    } catch (e) {
      toast((e as Error).message, 'danger');
    }
  }

  return (
    <>
      <div className="detail-bar">
        <button className="btn ghost" onClick={onBack}>← All projects</button>
        <div className="spacer" />
        <button
          className={`btn${isFilter ? '' : ' primary'}`}
          onClick={() => setWorkspace(isFilter ? null : ws.id)}
        >
          {isFilter ? 'Showing only this everywhere' : 'Show only this everywhere'}
        </button>
      </div>

      <div className="detail-head">
        <span className="proj-dot lg" style={{ background: ws.color || 'var(--accent)' }} />
        <div>
          <h2>{ws.name}</h2>
          <p className="prose" style={{ marginTop: 6, marginBottom: 0 }}>
            {ws.description || 'No description yet.'}
          </p>
        </div>
      </div>

      <div className="grid-3">
        <div className="stat">
          <div className="label">Memories here</div>
          <div className="value">{memories.data?.length ?? ws.memoryCount ?? 0}</div>
          <div className="foot">everything saved to this project</div>
        </div>
        <div className="stat">
          <div className="label">Folders</div>
          <div className="value">{tree.data?.length ?? 0}</div>
          <div className="foot">optional — for splitting a big project up</div>
        </div>
        <div className="stat">
          <div className="label">Last saved</div>
          <div className="value" style={{ fontSize: 19, marginTop: 9 }}>
            {memories.data?.[0] ? relTime(memories.data[0].createdAt) : '—'}
          </div>
          <div className="foot">{memories.data?.[0]?.client ?? 'nothing yet'}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>What’s in here</h3>
          <span className="hint">newest first</span>
        </div>
        {!memories.data ? (
          <div className="card-body"><div className="skeleton" style={{ height: 90 }} /></div>
        ) : memories.data.length === 0 ? (
          <div className="card-body">
            <Empty
              title="Nothing saved to this project yet"
              hint="Point a tool at it using the block below, then ask it to remember something."
            />
          </div>
        ) : (
          <div className="mem-list">
            {memories.data.map((m) => (
              <div key={m.id} className="mem-row">
                <div className="mem-row-head">
                  <strong>{m.title}</strong>
                  <Badge tone={kindTone(m.kind)}>{m.kind}</Badge>
                </div>
                <div className="mem-row-body">{m.body}</div>
                <div className="mem-row-foot faint">
                  {relTime(m.createdAt)} · saved by {m.client}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Folders</h3>
          <span className="hint">only if this project is big enough to need them</span>
          <div className="spacer" />
          {!adding && (
            <button className="btn sm" onClick={() => setAdding(true)}>Add folder</button>
          )}
        </div>
        <div className="card-body">
          {adding && (
            <div className="row" style={{ marginBottom: 12 }}>
              <input
                className="input"
                autoFocus
                placeholder="Folder name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addFolder()}
              />
              <button className="btn primary" onClick={addFolder}>Add</button>
              <button className="btn ghost" onClick={() => { setAdding(false); setFolderName(''); }}>
                Cancel
              </button>
            </div>
          )}
          {!tree.data?.length ? (
            <div className="faint">No folders. Most projects never need any.</div>
          ) : (
            <div className="folder-list">
              {tree.data.map((n) => (
                <div key={n.id} className="folder-row">
                  <span className="folder-name">{n.name}</span>
                  <span className="faint">{n.memoryCount ?? 0}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Point a tool at only this project</h3>
          <span className="hint">it will read and write here, and nowhere else</span>
        </div>
        <div className="card-body">
          <p className="prose" style={{ fontSize: 15 }}>
            Same address as always, with this project’s name on the end. Useful when a tool
            lives inside one repo and should never see the rest of your memory.
          </p>
          <CodeBlock
            lang="bash"
            code={`claude mcp add --transport http orbis-${ws.slug} \\
  ${origin}/api/mcp \\
  --header "Authorization: Bearer <your key>" \\
  --header "X-Orbis-Workspace: ${ws.slug}"`}
          />
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function NewWorkspace({
  onClose, onSaved, toast,
}: {
  onClose: () => void;
  onSaved: () => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.createWorkspace({ name: name.trim(), description: description.trim() });
      toast(`Created “${name.trim()}”`);
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'danger');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: 4 }}>New project</h3>
        <p className="faint" style={{ marginBottom: 18 }}>
          A project keeps one piece of work separate from everything else.
        </p>

        <div className="field">
          <label htmlFor="p-name">Name</label>
          <input
            id="p-name"
            className="input"
            autoFocus
            placeholder="Website redesign"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim().length >= 2 && save()}
          />
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="p-desc">What is it? <span className="faint">optional</span></label>
          <input
            id="p-desc"
            className="input"
            placeholder="Copy, layout and launch plan"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="row" style={{ marginTop: 22, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || name.trim().length < 2}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
