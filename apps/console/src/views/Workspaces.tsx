import { useState } from 'react';
import { api } from '../lib/api.ts';
import type { Bootstrap, Memory, TreeNode, Workspace } from '../lib/api.ts';
import { Badge, Drawer, Empty, kindTone, relTime, useAsync } from '../lib/ui.tsx';

/**
 * Workspaces and their folder trees.
 *
 * Ordinary folders and projects, because that is the mental model people
 * already carry for their own work. Inventing a novel organising metaphor would
 * mean teaching it, and nothing here is improved by being unfamiliar.
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
  const [creating, setCreating] = useState(false);
  const active = workspace ?? boot.workspaces.find((w) => w.isDefault)?.id ?? boot.workspaces[0]?.id;

  return (
    <>
      <div className="row">
        <div className="faint" style={{ fontSize: 12.5 }}>
          A workspace scopes what an agent recalls. Ask about deployment in one project and you
          should not get another project's deployment notes.
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>New workspace</button>
      </div>

      <div className="grid-2">
        {boot.workspaces.map((w) => (
          <WorkspaceCard
            key={w.id}
            ws={w}
            active={w.id === active}
            onSelect={() => setWorkspace(w.id)}
            toast={toast}
            reload={reload}
          />
        ))}
      </div>

      {boot.workspaces.length === 0 && (
        <div className="card">
          <Empty icon="▤" title="No workspaces" hint="Create one to start organising." />
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

function WorkspaceCard({
  ws,
  active,
  onSelect,
  toast,
  reload,
}: {
  ws: Workspace;
  active: boolean;
  onSelect: () => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
  reload: () => void;
}) {
  const tree = useAsync<TreeNode[]>(() => api.tree(ws.id), [ws.id]);
  const [openNode, setOpenNode] = useState<TreeNode | null>(null);
  const [addingTo, setAddingTo] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState('');

  const addNode = async (parentId: string | null) => {
    if (name.trim().length < 1) return;
    try {
      await api.createNode({ workspaceId: ws.id, parentId, name: name.trim() });
      setName('');
      setAddingTo(undefined);
      tree.reload();
      toast('Folder created', 'ok');
      reload();
    } catch (e) {
      toast((e as Error).message, 'danger');
    }
  };

  return (
    <div className="card" style={active ? { borderColor: 'var(--accent-border)' } : undefined}>
      <div className="card-head">
        <h3>{ws.name}</h3>
        {ws.isDefault && <Badge>default</Badge>}
        {active && <Badge tone="accent">viewing</Badge>}
        <div className="spacer" />
        <span className="faint" style={{ fontSize: 11.5 }}>{ws.memoryCount ?? 0} memories</span>
      </div>

      <div className="card-body col" style={{ gap: 8 }}>
        {ws.description && <div className="muted" style={{ fontSize: 12.5 }}>{ws.description}</div>}

        <div className="col" style={{ gap: 1 }}>
          {tree.loading && !tree.data ? (
            <div className="skeleton" style={{ height: 46 }} />
          ) : !tree.data?.length ? (
            <div className="faint" style={{ fontSize: 12.5, padding: '6px 0' }}>
              No folders yet — memories live at the workspace root.
            </div>
          ) : (
            tree.data.map((n) => (
              <NodeRow key={n.id} node={n} depth={0} onOpen={setOpenNode} />
            ))
          )}
        </div>

        {addingTo !== undefined ? (
          <div className="row" style={{ gap: 6 }}>
            <input
              className="input"
              autoFocus
              placeholder="Folder name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addNode(addingTo ?? null);
                if (e.key === 'Escape') setAddingTo(undefined);
              }}
            />
            <button className="btn sm primary" onClick={() => addNode(addingTo ?? null)}>Add</button>
            <button className="btn sm ghost" onClick={() => setAddingTo(undefined)}>Cancel</button>
          </div>
        ) : (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm ghost" onClick={() => setAddingTo(null)}>+ folder</button>
            {!active && (
              <button className="btn sm ghost" onClick={onSelect}>view this workspace</button>
            )}
          </div>
        )}
      </div>

      {openNode && (
        <NodeDrawer node={openNode} onClose={() => setOpenNode(null)} />
      )}
    </div>
  );
}

function NodeRow({
  node,
  depth,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  onOpen: (n: TreeNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = Boolean(node.children?.length);

  return (
    <>
      <div
        className="row"
        style={{
          padding: '3px 4px',
          paddingLeft: 4 + depth * 14,
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 13,
        }}
        onClick={() => (hasChildren ? setOpen(!open) : onOpen(node))}
      >
        <span className="faint" style={{ width: 12, fontSize: 10 }}>
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </span>
        <span>{node.name}</span>
        <div className="spacer" />
        {node.memoryCount ? (
          <span className="faint" style={{ fontSize: 11 }}>{node.memoryCount}</span>
        ) : null}
        <button
          className="btn sm ghost"
          style={{ padding: '0 4px', fontSize: 11 }}
          onClick={(e) => { e.stopPropagation(); onOpen(node); }}
        >
          open
        </button>
      </div>
      {open &&
        node.children?.map((c) => (
          <NodeRow key={c.id} node={c} depth={depth + 1} onOpen={onOpen} />
        ))}
    </>
  );
}

function NodeDrawer({ node, onClose }: { node: TreeNode; onClose: () => void }) {
  const mems = useAsync<Memory[]>(() => api.memories({ node: node.id, limit: 100 }), [node.id]);

  return (
    <Drawer title={node.name} onClose={onClose}>
      <div className="faint mono" style={{ fontSize: 12 }}>{node.path}</div>
      {node.summary && <div className="muted">{node.summary}</div>}
      <div className="card">
        <div className="card-head">
          <h3>Memories here</h3>
          <span className="hint">{mems.data?.length ?? 0}</span>
        </div>
        {!mems.data?.length ? (
          <Empty title="Nothing filed here yet" />
        ) : (
          mems.data.map((m) => (
            <div className="mem" key={m.id}>
              <div className="mem-title">{m.title}</div>
              <div className="mem-body">{m.body}</div>
              <div className="mem-meta">
                <Badge tone={kindTone(m.kind)}>{m.kind}</Badge>
                <span>{m.client}</span>
                <span>·</span>
                <span>{relTime(m.createdAt)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </Drawer>
  );
}

function NewWorkspace({
  onClose,
  onSaved,
  toast,
}: {
  onClose: () => void;
  onSaved: () => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.createWorkspace({ name: name.trim(), description: description.trim() });
      toast('Workspace created', 'ok');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="New workspace" onClose={onClose}>
      <div className="field">
        <label>Name</label>
        <input
          className="input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Side projects"
        />
      </div>
      <div className="field">
        <label>What is it for?</label>
        <textarea
          className="input"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Given to agents as context when they work in this workspace."
        />
      </div>
      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || name.trim().length < 2}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Drawer>
  );
}
