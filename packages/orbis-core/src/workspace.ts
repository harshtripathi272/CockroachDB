import type { Db } from './db.ts';
import { audit } from './memory.ts';
import type { TreeNode, Workspace } from './types.ts';

/**
 * Workspaces and the folder tree inside them.
 *
 * A workspace is the unit an agent attaches to: "I am working on Orbis" scopes
 * recall so a question about deployment does not surface an unrelated project's
 * deployment notes. The tree underneath is ordinary folders and projects,
 * because that is the mental model people already have for their own work and
 * inventing a novel one buys nothing.
 */

function toWorkspace(r: Record<string, any>): Workspace {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description ?? '',
    color: r.color ?? 'slate',
    icon: r.icon ?? 'folder',
    isDefault: Boolean(r.is_default),
    memoryCount: r.memory_count !== undefined ? Number(r.memory_count) : undefined,
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
  };
}

function toNode(r: Record<string, any>): TreeNode {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    parentId: r.parent_id,
    kind: r.kind,
    name: r.name,
    slug: r.slug,
    path: r.path,
    summary: r.summary ?? '',
    memoryCount: r.memory_count !== undefined ? Number(r.memory_count) : undefined,
  };
}

export class WorkspaceStore {
  #db: Db;
  #accountId: string;

  constructor(db: Db, accountId: string) {
    this.#db = db;
    this.#accountId = accountId;
  }

  async list(): Promise<Workspace[]> {
    const rows = await this.#db.query(
      `SELECT w.*, count(m.id) FILTER (WHERE m.status = 'active') AS memory_count
         FROM workspace w
    LEFT JOIN memory m ON m.workspace_id = w.id
        WHERE w.account_id = $1
     GROUP BY w.id
     ORDER BY w.is_default DESC, w.name`,
      [this.#accountId],
    );
    return rows.map(toWorkspace);
  }

  async get(idOrSlug: string): Promise<Workspace | null> {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const row = await this.#db.one(
      `SELECT w.*, count(m.id) FILTER (WHERE m.status = 'active') AS memory_count
         FROM workspace w
    LEFT JOIN memory m ON m.workspace_id = w.id
        WHERE w.account_id = $1 AND ${isUuid ? 'w.id = $2' : 'w.slug = $2'}
     GROUP BY w.id`,
      [this.#accountId, idOrSlug],
    );
    return row ? toWorkspace(row) : null;
  }

  async getDefault(): Promise<Workspace | null> {
    const row = await this.#db.one(
      `SELECT * FROM workspace WHERE account_id = $1
        ORDER BY is_default DESC, created_at LIMIT 1`,
      [this.#accountId],
    );
    return row ? toWorkspace(row) : null;
  }

  async create(input: {
    name: string;
    slug?: string;
    description?: string;
    color?: string;
    icon?: string;
    isDefault?: boolean;
  }): Promise<Workspace> {
    const slug = input.slug ?? slugify(input.name);
    const row = await this.#db.inTransaction(async (client) => {
      if (input.isDefault) {
        await client.query(`UPDATE workspace SET is_default = false WHERE account_id = $1`, [
          this.#accountId,
        ]);
      }
      const { rows } = await client.query(
        `INSERT INTO workspace (account_id, slug, name, description, color, icon, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (account_id, slug) DO UPDATE
            SET name = excluded.name, description = excluded.description,
                color = excluded.color, icon = excluded.icon
         RETURNING *`,
        [
          this.#accountId,
          slug,
          input.name,
          input.description ?? '',
          input.color ?? 'slate',
          input.icon ?? 'folder',
          input.isDefault ?? false,
        ],
      );
      await audit(client, this.#accountId, 'workspace.create', 'workspace', rows[0].id, {
        name: input.name,
      });
      return rows[0];
    });
    return toWorkspace(row);
  }

  // -------------------------------------------------------------------------
  // Tree
  // -------------------------------------------------------------------------

  /**
   * The folder tree for a workspace, nested.
   *
   * Assembled in one query and nested in memory rather than fetched
   * recursively. A tree of a few hundred nodes is nothing, and one round trip
   * beats N.
   */
  async tree(workspaceId: string): Promise<TreeNode[]> {
    const rows = await this.#db.query(
      `SELECT n.*, count(m.id) FILTER (WHERE m.status = 'active') AS memory_count
         FROM node n
    LEFT JOIN memory m ON m.node_id = n.id
        WHERE n.account_id = $1 AND n.workspace_id = $2
     GROUP BY n.id
     ORDER BY n.path`,
      [this.#accountId, workspaceId],
    );

    const nodes = rows.map(toNode);
    const byId = new Map(nodes.map((n) => [n.id, { ...n, children: [] as TreeNode[] }]));
    const roots: TreeNode[] = [];

    for (const n of byId.values()) {
      const parent = n.parentId ? byId.get(n.parentId) : null;
      if (parent) parent.children!.push(n);
      else roots.push(n);
    }
    return roots;
  }

  /**
   * Create a folder or project.
   *
   * `path` is derived from the parent rather than supplied, so it cannot drift
   * out of sync with parent_id. Both are stored: parent_id is the truth,
   * path makes "everything under here" a prefix match instead of a walk.
   */
  async createNode(input: {
    workspaceId: string;
    parentId?: string | null;
    name: string;
    kind?: 'folder' | 'project' | 'collection';
    summary?: string;
  }): Promise<TreeNode> {
    const slug = slugify(input.name);
    const row = await this.#db.inTransaction(async (client) => {
      let parentPath = '';
      if (input.parentId) {
        const { rows: p } = await client.query(
          `SELECT path FROM node WHERE id = $1 AND account_id = $2`,
          [input.parentId, this.#accountId],
        );
        if (!p[0]) throw new Error(`parent node ${input.parentId} not found`);
        parentPath = p[0].path;
      }
      const path = `${parentPath}/${slug}`;

      const { rows } = await client.query(
        `INSERT INTO node (account_id, workspace_id, parent_id, kind, name, slug, path, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (workspace_id, path) DO UPDATE
            SET name = excluded.name, summary = excluded.summary
         RETURNING *`,
        [
          this.#accountId,
          input.workspaceId,
          input.parentId ?? null,
          input.kind ?? 'folder',
          input.name,
          slug,
          path,
          input.summary ?? '',
        ],
      );
      return rows[0];
    });
    return toNode(row);
  }

  /** Resolve a path like '/research/hackathon', creating what does not exist. */
  async ensurePath(workspaceId: string, path: string): Promise<TreeNode | null> {
    const parts = path.split('/').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;

    let parentId: string | null = null;
    let current: TreeNode | null = null;
    for (const part of parts) {
      current = await this.createNode({ workspaceId, parentId, name: part });
      parentId = current.id;
    }
    return current;
  }

  async getNode(id: string): Promise<TreeNode | null> {
    const row = await this.#db.one(
      `SELECT * FROM node WHERE id = $1 AND account_id = $2`,
      [id, this.#accountId],
    );
    return row ? toNode(row) : null;
  }
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}
