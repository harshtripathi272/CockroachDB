import type { PoolClient } from 'pg';
import type { Db } from './db.ts';
import type { EmbeddingProvider } from './embeddings.ts';
import { toVectorLiteral } from './embeddings.ts';
import type {
  Fallout,
  Memory,
  MemoryKind,
  RememberInput,
  SearchOptions,
} from './types.ts';

/**
 * The raw memory layer.
 *
 * Two operations here carry the weight of the product:
 *
 *   search()   vector recall that never returns a retracted memory, enforced by
 *              the index prefix rather than by a filter applied afterwards.
 *   fallout()  given a memory that turned out to be wrong, everything that was
 *              built on top of it, transitively.
 *
 * The second one is why this is a SQL database. A vector store can do the
 * first; it cannot do the second, because it never recorded the edge.
 */

/**
 * Cosine distance below which two memories of the same kind are treated as the
 * same memory.
 *
 * Measured, not guessed. On the local MiniLM model, genuine restatements of the
 * same idea land at 0.19–0.22 ("two-space indentation, tabs are a hard no" vs
 * "always two spaces, never tab characters"), while unrelated memories start at
 * 0.88. That leaves a wide, safe corridor.
 *
 * 0.30 sits deliberately near the duplicate end of it. The two failure modes are
 * not symmetric: too loose merges distinct memories and destroys information
 * irrecoverably, while too tight merely leaves duplicates that the dream pass
 * can consolidate later. When in doubt, keep both rows.
 */
const DEDUPE_DISTANCE = 0.3;

/** Columns every read returns, so row → Memory mapping stays in one place. */
const COLS = `
  m.id, m.account_id, m.workspace_id, m.node_id, m.kind, m.title, m.body,
  m.source, m.client, m.source_ref, m.confidence, m.evidence_count, m.status,
  m.tags, m.created_at, m.updated_at, m.valid_from, m.valid_to, m.superseded_by
`;

function toMemory(r: Record<string, any>): Memory {
  return {
    id: r.id,
    accountId: r.account_id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name ?? undefined,
    nodeId: r.node_id,
    nodePath: r.node_path ?? undefined,
    kind: r.kind,
    title: r.title,
    body: r.body,
    source: r.source,
    client: r.client,
    sourceRef: r.source_ref,
    confidence: Number(r.confidence),
    evidenceCount: Number(r.evidence_count),
    status: r.status,
    tags: r.tags ?? [],
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at),
    validFrom: r.valid_from?.toISOString?.() ?? String(r.valid_from),
    validTo: r.valid_to?.toISOString?.() ?? null,
    supersededBy: r.superseded_by ?? null,
    ...(r.distance !== undefined && r.distance !== null
      ? { distance: Number(r.distance), score: 1 - Number(r.distance) }
      : {}),
  };
}

export class MemoryStore {
  #db: Db;
  #embedder: EmbeddingProvider;
  #accountId: string;

  constructor(db: Db, embedder: EmbeddingProvider, accountId: string) {
    this.#db = db;
    this.#embedder = embedder;
    this.#accountId = accountId;
  }

  get embedderId(): string {
    return this.#embedder.id;
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Store a memory.
   *
   * If `dedupe` is on and a near-identical memory of the same kind already
   * exists, this reinforces that one instead of inserting a second copy. That
   * is not a storage optimisation — it is how confidence accrues. A preference
   * stated once is a guess; the same preference observed nine times from three
   * different clients is a rule, and only the reinforcement path can tell the
   * difference between those two situations.
   */
  async remember(
    input: RememberInput,
    opts: { dedupe?: boolean; dedupeThreshold?: number } = {},
  ): Promise<{ memory: Memory; reinforced: boolean }> {
    const dedupe = opts.dedupe ?? true;
    const threshold = opts.dedupeThreshold ?? DEDUPE_DISTANCE;

    const text = `${input.title}\n\n${input.body}`;
    const [vec] = await this.#embedder.embed([text]);
    const literal = toVectorLiteral(vec);

    if (dedupe) {
      const existing = await this.#nearestSameKind(literal, input.kind ?? 'fact', threshold);
      if (existing) return { memory: await this.reinforce(existing), reinforced: true };
    }

    const memory = await this.#db.inTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO memory
           (account_id, workspace_id, node_id, kind, title, body, embedding,
            embed_model, source, client, source_ref, confidence, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7::VECTOR,$8,$9,$10,$11,$12,$13)
         RETURNING ${COLS.replace(/m\./g, '')}`,
        [
          this.#accountId,
          input.workspaceId ?? null,
          input.nodeId ?? null,
          input.kind ?? 'fact',
          input.title,
          input.body,
          literal,
          this.#embedder.id,
          input.source ?? 'api',
          input.client ?? 'unknown',
          input.sourceRef ?? null,
          input.confidence ?? 0.5,
          input.tags ?? [],
        ],
      );
      const created = rows[0];

      // Lineage. Recorded in the same transaction as the memory itself so the
      // graph can never contain a derived node whose parents are missing.
      if (input.derivedFrom?.length) {
        for (const sourceId of input.derivedFrom) {
          await client.query(
            `INSERT INTO memory_source (memory_id, source_id, account_id)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [created.id, sourceId, this.#accountId],
          );
        }
      }

      await audit(client, this.#accountId, 'memory.create', 'memory', created.id, {
        kind: created.kind,
        client: input.client ?? 'unknown',
        derivedFrom: input.derivedFrom?.length ?? 0,
      });

      return created;
    });

    return { memory: toMemory(memory), reinforced: false };
  }

  /**
   * Another observation of something already known.
   *
   * Confidence approaches 1 asymptotically rather than incrementing linearly:
   * the second observation should move it a lot and the twentieth barely at
   * all, otherwise a chatty agent repeating itself manufactures certainty that
   * was never earned.
   */
  async reinforce(id: string): Promise<Memory> {
    const row = await this.#db.inTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE memory
            SET evidence_count = evidence_count + 1,
                confidence = least(0.99, confidence + (1 - confidence) * 0.35),
                last_reinforced_at = now(),
                updated_at = now()
          WHERE id = $1 AND account_id = $2
      RETURNING ${COLS.replace(/m\./g, '')}`,
        [id, this.#accountId],
      );
      if (!rows[0]) throw new Error(`memory ${id} not found`);
      await audit(client, this.#accountId, 'memory.reinforce', 'memory', id, {
        evidenceCount: rows[0].evidence_count,
      });
      return rows[0];
    });
    return toMemory(row);
  }

  /**
   * Mark a memory wrong, optionally replacing it.
   *
   * Nothing is deleted. The old row moves to 'retracted' and keeps its
   * valid_from/valid_to, so "what did Orbis believe last Tuesday, and why did
   * it act on it" stays answerable long after the MVCC window has closed.
   *
   * Every wiki page citing the memory is marked stale in the same transaction.
   * Stale beats blank: the page keeps serving its old content and the UI flags
   * it, rather than a correction blanking half the wiki until the next dream
   * pass runs.
   */
  async correct(
    id: string,
    opts: { replacement?: RememberInput; reason?: string } = {},
  ): Promise<{ retracted: Memory; replacement: Memory | null; pagesMarkedStale: number }> {
    let replacement: Memory | null = null;

    if (opts.replacement) {
      const r = await this.remember(
        { ...opts.replacement, derivedFrom: [] },
        { dedupe: false },
      );
      replacement = r.memory;
    }

    const result = await this.#db.inTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE memory
            SET status = 'retracted', valid_to = now(), updated_at = now(),
                superseded_by = $3
          WHERE id = $1 AND account_id = $2
      RETURNING ${COLS.replace(/m\./g, '')}`,
        [id, this.#accountId, replacement?.id ?? null],
      );
      if (!rows[0]) throw new Error(`memory ${id} not found`);

      const { rows: staled } = await client.query(
        `UPDATE wiki_page SET stale = true
          WHERE account_id = $1
            AND id IN (SELECT page_id FROM wiki_citation
                        WHERE account_id = $1 AND memory_id = $2)
        RETURNING id`,
        [this.#accountId, id],
      );

      await audit(client, this.#accountId, 'memory.correct', 'memory', id, {
        reason: opts.reason ?? '',
        replacedBy: replacement?.id ?? null,
        pagesMarkedStale: staled.length,
      });

      return { retracted: rows[0], pagesMarkedStale: staled.length };
    });

    return {
      retracted: toMemory(result.retracted),
      replacement,
      pagesMarkedStale: result.pagesMarkedStale,
    };
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Semantic recall.
   *
   * The query is built in two stages on purpose. The inner stage constrains
   * only columns that sit in the vector index prefix
   * (account_id, status, workspace_id) and does the ORDER BY on the distance
   * operator, which is what keeps the C-SPANN index in the plan. Filters on
   * anything else — kind, tags — are applied in the outer stage against an
   * over-fetched candidate set.
   *
   * Collapsing this into a single WHERE clause is the mistake that costs a day:
   * a predicate on a non-prefix column silently drops the index and the query
   * full-scans while still returning correct-looking rows.
   *
   * Two specific traps, both confirmed by reading plans against a real 800-row
   * table rather than by reasoning about them:
   *
   *   `AND embedding IS NOT NULL` looks like harmless defensive filtering and
   *   disqualifies the index outright — it is a predicate on the indexed vector
   *   column itself. It is also unnecessary: a NULL embedding yields a NULL
   *   distance, which sorts last and is cut by the LIMIT anyway.
   *
   *   Leaving workspace_id unconstrained to search everywhere also drops the
   *   index, because a nullable trailing prefix column still has to be
   *   constrained. That is why there are two vector indexes and why this picks
   *   between them rather than relying on one to serve both shapes.
   */
  async search(opts: SearchOptions): Promise<Memory[]> {
    const limit = Math.min(opts.limit ?? 10, 100);
    const [vec] = await this.#embedder.embed([opts.query]);
    const literal = toVectorLiteral(vec);

    const hasKindFilter = Boolean(opts.kind);
    const hasTagFilter = Boolean(opts.tags?.length);
    // Over-fetch only when an outer filter can discard rows, otherwise the
    // extra candidates are pure cost.
    const overfetch = hasKindFilter || hasTagFilter ? Math.min(limit * 6, 300) : limit;

    const inner: string[] = ['m.account_id = $2'];
    const params: unknown[] = [literal, this.#accountId];

    inner.push(opts.includeInactive ? `m.status <> 'retracted'` : `m.status = 'active'`);

    if (opts.workspaceId) {
      params.push(opts.workspaceId);
      inner.push(`m.workspace_id = $${params.length}`);
    }
    params.push(overfetch);
    const limitParam = params.length;

    const outer: string[] = [];
    if (opts.kind) {
      params.push(opts.kind);
      outer.push(`m.kind = $${params.length}`);
    }
    if (opts.tags?.length) {
      params.push(opts.tags);
      outer.push(`m.tags && $${params.length}`);
    }
    if (opts.maxDistance !== undefined) {
      params.push(opts.maxDistance);
      outer.push(`h.distance <= $${params.length}`);
    }
    params.push(limit);
    const finalLimit = params.length;

    const sql = `
      WITH hits AS (
        SELECT m.id, m.embedding <=> $1::VECTOR AS distance
          FROM memory m
         WHERE ${inner.join(' AND ')}
         ORDER BY m.embedding <=> $1::VECTOR
         LIMIT $${limitParam}
      )
      SELECT ${COLS}, h.distance, w.name AS workspace_name, n.path AS node_path
        FROM hits h
        JOIN memory m ON m.id = h.id
   LEFT JOIN workspace w ON w.id = m.workspace_id
   LEFT JOIN node n ON n.id = m.node_id
       ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
       ORDER BY h.distance
       LIMIT $${finalLimit}`;

    const rows = await this.#db.query(sql, params);
    const hits = rows.map(toMemory);

    // Relative cutoff, applied after ranking. See SearchOptions.relevanceWindow
    // for why this is relative and not absolute. The best hit always survives:
    // returning nothing when something ranked first is worse than returning one
    // weak answer the caller can judge for itself.
    if (opts.relevanceWindow !== undefined && hits.length > 1) {
      const best = hits[0].distance;
      if (best !== undefined) {
        const ceiling = best + opts.relevanceWindow;
        return hits.filter((h, i) => i === 0 || (h.distance ?? Infinity) <= ceiling);
      }
    }
    return hits;
  }

  /** Exact lookup by id. */
  async get(id: string): Promise<Memory | null> {
    const row = await this.#db.one(
      `SELECT ${COLS}, w.name AS workspace_name, n.path AS node_path
         FROM memory m
    LEFT JOIN workspace w ON w.id = m.workspace_id
    LEFT JOIN node n ON n.id = m.node_id
        WHERE m.id = $1 AND m.account_id = $2`,
      [id, this.#accountId],
    );
    return row ? toMemory(row) : null;
  }

  /** Most recent first. The Memories tab and the activity feed both use this. */
  async list(
    opts: {
      workspaceId?: string | null;
      nodeId?: string | null;
      kind?: MemoryKind;
      client?: string;
      status?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Memory[]> {
    const where: string[] = ['m.account_id = $1'];
    const params: unknown[] = [this.#accountId];

    if (opts.workspaceId) {
      params.push(opts.workspaceId);
      where.push(`m.workspace_id = $${params.length}`);
    }
    if (opts.nodeId) {
      params.push(opts.nodeId);
      where.push(`m.node_id = $${params.length}`);
    }
    if (opts.kind) {
      params.push(opts.kind);
      where.push(`m.kind = $${params.length}`);
    }
    if (opts.client) {
      params.push(opts.client);
      where.push(`m.client = $${params.length}`);
    }
    where.push(opts.status ? `m.status = '${opts.status.replace(/\W/g, '')}'` : `m.status <> 'superseded'`);

    params.push(Math.min(opts.limit ?? 50, 500));
    params.push(opts.offset ?? 0);

    const rows = await this.#db.query(
      `SELECT ${COLS}, w.name AS workspace_name, n.path AS node_path
         FROM memory m
    LEFT JOIN workspace w ON w.id = m.workspace_id
    LEFT JOIN node n ON n.id = m.node_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map(toMemory);
  }

  // -------------------------------------------------------------------------
  // Correction propagation
  // -------------------------------------------------------------------------

  /**
   * Everything downstream of one memory.
   *
   * A single recursive walk over memory_source. The `min(hops)` grouping is not
   * cosmetic: a memory reachable by two different paths appears once per path,
   * so without it a two-hop insight double-counts and the UI reports fallout
   * larger than reality. Shortest path is the honest generation number.
   *
   * The depth cap is a cycle guard. UNION (not UNION ALL) already dedupes, but
   * a mutually-derived pair would otherwise alternate forever, and a runaway
   * recursive CTE on the request path is a much worse failure than a truncated
   * answer.
   */
  async fallout(memoryId: string, maxHops = 16): Promise<Fallout> {
    const t0 = Date.now();

    const memRows = await this.#db.query(
      `WITH RECURSIVE taint (id, hops) AS (
            SELECT $2::UUID, 0
          UNION
            SELECT ms.memory_id, t.hops + 1
              FROM taint t
              JOIN memory_source ms
                ON ms.source_id = t.id AND ms.account_id = $1
             WHERE t.hops < ${Number(maxHops) | 0}
       ),
       shortest AS (
            SELECT id, min(hops) AS hops FROM taint GROUP BY id
       )
       SELECT ${COLS}, s.hops, w.name AS workspace_name
         FROM shortest s
         JOIN memory m ON m.id = s.id AND m.account_id = $1
    LEFT JOIN workspace w ON w.id = m.workspace_id
        WHERE s.id <> $2::UUID
        ORDER BY s.hops, m.created_at`,
      [this.#accountId, memoryId],
    );

    const ids = [memoryId, ...memRows.map((r) => r.id)];

    // Wiki pages that cite the memory or anything derived from it. Done as a
    // second query rather than another CTE branch because the citation edge is
    // memory→page, not memory→memory, and folding two different edge shapes
    // into one recursive term is what made the previous build's version of this
    // query illegal.
    const pageRows = await this.#db.query(
      `SELECT DISTINCT p.id, p.slug, p.title, m.title AS via
         FROM wiki_citation c
         JOIN wiki_page p ON p.id = c.page_id
         JOIN memory m ON m.id = c.memory_id
        WHERE c.account_id = $1 AND c.memory_id = ANY($2::UUID[])
        ORDER BY p.title`,
      [this.#accountId, ids],
    );

    const entityRows = await this.#db.query(
      `SELECT DISTINCT e.id, e.name, e.kind
         FROM edge g
         JOIN entity e ON e.id = g.dst_id
        WHERE g.account_id = $1 AND g.src_kind = 'memory'
          AND g.dst_kind = 'entity' AND g.src_id = ANY($2::UUID[])
        ORDER BY e.name`,
      [this.#accountId, ids],
    );

    return {
      memories: memRows.map((r) => ({ ...toMemory(r), hops: Number(r.hops) })),
      pages: pageRows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, via: r.via })),
      entities: entityRows.map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
      tookMs: Date.now() - t0,
    };
  }

  /** Direct parents of a memory — "where did this come from". */
  async sources(memoryId: string): Promise<Memory[]> {
    const rows = await this.#db.query(
      `SELECT ${COLS}
         FROM memory_source ms
         JOIN memory m ON m.id = ms.source_id
        WHERE ms.memory_id = $1 AND ms.account_id = $2
        ORDER BY m.created_at`,
      [memoryId, this.#accountId],
    );
    return rows.map(toMemory);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Closest active memory of the same kind, if it is closer than `threshold`. */
  async #nearestSameKind(
    literal: string,
    kind: MemoryKind,
    threshold: number,
  ): Promise<string | null> {
    const row = await this.#db.one(
      `WITH hits AS (
         SELECT id, kind, embedding <=> $1::VECTOR AS distance
           FROM memory
          WHERE account_id = $2 AND status = 'active'
          ORDER BY embedding <=> $1::VECTOR
          LIMIT 10
       )
       SELECT id FROM hits WHERE kind = $3 AND distance < $4 ORDER BY distance LIMIT 1`,
      [literal, this.#accountId, kind, threshold],
    );
    return row?.id ?? null;
  }
}

/** Append-only. Every mutation lands here in the same transaction that made it. */
export async function audit(
  client: PoolClient,
  accountId: string,
  action: string,
  targetKind: string,
  targetId: string | null,
  detail: Record<string, unknown> = {},
  actor = 'system',
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (account_id, action, target_kind, target_id, actor, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [accountId, action, targetKind, targetId, actor, JSON.stringify(detail)],
  );
}
