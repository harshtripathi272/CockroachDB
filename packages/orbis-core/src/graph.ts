import type { PoolClient } from 'pg';
import type { Db } from './db.ts';
import type { EmbeddingProvider } from './embeddings.ts';
import { toVectorLiteral } from './embeddings.ts';
import type { Entity, EntityKind, GraphEdge } from './types.ts';

/**
 * Entities and the graph between them.
 *
 * Extraction is deterministic by default — pattern rules, not a model. That is
 * a design decision rather than a limitation:
 *
 *   - It runs on every write at no cost and with no network round trip.
 *   - It is reproducible, so the same memory always produces the same graph and
 *     a re-run does not quietly reshape history.
 *   - It cannot hallucinate an entity that was never mentioned, which matters
 *     because a fabricated node here becomes a fabricated claim in the wiki.
 *
 * An LLM extractor is strictly better at nuance and is used by the dream pass
 * when one is available. It refines what this produced; it does not replace it.
 */

/** Technologies worth recognising even when they are not capitalised. */
const KNOWN_TOOLS = new Map<string, EntityKind>([
  ['typescript', 'tool'], ['javascript', 'tool'], ['python', 'tool'], ['rust', 'tool'],
  ['golang', 'tool'], ['react', 'tool'], ['vue', 'tool'], ['svelte', 'tool'],
  ['postgres', 'tool'], ['postgresql', 'tool'], ['cockroachdb', 'tool'], ['sqlite', 'tool'],
  ['redis', 'tool'], ['kafka', 'tool'], ['docker', 'tool'], ['kubernetes', 'tool'],
  ['terraform', 'tool'], ['lambda', 'tool'], ['bedrock', 'tool'], ['claude', 'tool'],
  ['cursor', 'tool'], ['vscode', 'tool'], ['neovim', 'tool'], ['obsidian', 'tool'],
  ['git', 'tool'], ['github', 'org'], ['gitlab', 'org'], ['aws', 'org'],
  ['vercel', 'org'], ['anthropic', 'org'], ['openai', 'org'], ['node', 'tool'],
  ['vite', 'tool'], ['tailwind', 'tool'], ['telegram', 'tool'], ['codex', 'tool'],
]);

/** Words that begin a sentence and would otherwise look like proper nouns. */
const SENTENCE_STARTERS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'It', 'They', 'We', 'I', 'You', 'He', 'She',
  'A', 'An', 'And', 'But', 'Or', 'If', 'When', 'While', 'After', 'Before', 'Because',
  'For', 'From', 'With', 'Without', 'There', 'Their', 'His', 'Her', 'My', 'Our', 'Your',
  'Every', 'Each', 'Some', 'Any', 'All', 'No', 'Not', 'Now', 'Then', 'Also', 'However',
  'Should', 'Would', 'Could', 'Must', 'Can', 'Will', 'Do', 'Does', 'Did', 'Is', 'Are',
  'Was', 'Were', 'Has', 'Have', 'Had', 'Been', 'Being', 'Use', 'Using', 'Used', 'Note',
]);

export interface ExtractedEntity {
  name: string;
  kind: EntityKind;
  confidence: number;
}

/**
 * Pull candidate entities out of text.
 *
 * Three independent signals, strongest first. Each is conservative on its own;
 * a name has to be produced by at least one of them to become a node, and a
 * missed entity is a much cheaper mistake than an invented one.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const found = new Map<string, ExtractedEntity>();

  const add = (name: string, kind: EntityKind, confidence: number) => {
    const clean = name.trim().replace(/[.,;:!?'"]+$/, '');
    if (clean.length < 2 || clean.length > 60) return;
    const key = canonicalise(clean);
    const prev = found.get(key);
    if (!prev || prev.confidence < confidence) {
      found.set(key, { name: clean, kind, confidence });
    }
  };

  // 1. Backticked or quoted identifiers — an explicit signal from the author.
  for (const m of text.matchAll(/`([^`\n]{2,50})`/g)) add(m[1], 'tool', 0.9);

  // 2. owner/repo, and bare domains.
  for (const m of text.matchAll(/\b([a-z0-9][\w.-]*\/[\w.-]{2,})\b/gi)) add(m[1], 'repo', 0.85);
  for (const m of text.matchAll(/\b([a-z0-9-]+\.(?:com|io|dev|ai|org|net|sh|live))\b/gi)) {
    add(m[1], 'org', 0.7);
  }

  // 3. Known technology names, case-insensitively.
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9+#.]{1,20})\b/g)) {
    const kind = KNOWN_TOOLS.get(m[1].toLowerCase());
    if (kind) add(m[1], kind, 0.8);
  }

  // 4. Capitalised runs, minus sentence-initial words.
  //    "Northwind Air" survives; "The API" loses "The" and keeps "API".
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*)*)\b/g)) {
    const words = m[1].split(/\s+/).filter((w) => !SENTENCE_STARTERS.has(w));
    if (words.length === 0) continue;
    const phrase = words.join(' ');
    if (phrase.length < 3) continue;
    if (KNOWN_TOOLS.has(phrase.toLowerCase())) continue; // already added, better kind
    add(phrase, words.length > 1 ? 'project' : 'concept', words.length > 1 ? 0.6 : 0.45);
  }

  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}

/** "CockroachDB", "cockroach db" and "Cockroach  DB" must converge on one node. */
export function canonicalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export class GraphStore {
  #db: Db;
  #embedder: EmbeddingProvider;
  #accountId: string;

  constructor(db: Db, embedder: EmbeddingProvider, accountId: string) {
    this.#db = db;
    this.#embedder = embedder;
    this.#accountId = accountId;
  }

  /**
   * Extract entities from a memory and wire up the edges.
   *
   * Runs in one transaction with the memory link so the graph can never contain
   * an edge to an entity whose mention was rolled back.
   */
  async indexMemory(
    memoryId: string,
    text: string,
    opts: { minConfidence?: number; max?: number } = {},
  ): Promise<Entity[]> {
    const min = opts.minConfidence ?? 0.6;
    const max = opts.max ?? 12;
    const candidates = extractEntities(text).filter((e) => e.confidence >= min).slice(0, max);
    if (candidates.length === 0) return [];

    const vectors = await this.#embedder.embed(candidates.map((c) => c.name));

    return this.#db.inTransaction(async (client) => {
      const out: Entity[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const { rows } = await client.query(
          `INSERT INTO entity (account_id, kind, name, canonical, embedding, embed_model)
           VALUES ($1,$2,$3,$4,$5::VECTOR,$6)
           ON CONFLICT (account_id, kind, canonical) DO UPDATE
              SET mention_count = entity.mention_count + 1, last_seen = now()
           RETURNING *`,
          [
            this.#accountId,
            c.kind,
            c.name,
            canonicalise(c.name),
            toVectorLiteral(vectors[i]),
            this.#embedder.id,
          ],
        );
        const e = rows[0];
        await linkEdge(client, this.#accountId, 'memory', memoryId, 'entity', e.id, 'mentions', c.confidence);
        out.push(toEntity(e));
      }
      return out;
    });
  }

  async entities(opts: { limit?: number; kind?: EntityKind; minMentions?: number } = {}): Promise<Entity[]> {
    const params: unknown[] = [this.#accountId];
    const where = ['account_id = $1'];
    if (opts.kind) { params.push(opts.kind); where.push(`kind = $${params.length}`); }
    params.push(opts.minMentions ?? 1);
    where.push(`mention_count >= $${params.length}`);
    params.push(Math.min(opts.limit ?? 200, 1000));

    const rows = await this.#db.query(
      `SELECT * FROM entity WHERE ${where.join(' AND ')}
        ORDER BY mention_count DESC, last_seen DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toEntity);
  }

  /**
   * The graph as the UI needs it: nodes plus edges, already bounded.
   *
   * Capped server-side rather than client-side. A force simulation past a few
   * hundred nodes stops being a picture and becomes a hairball, so sending ten
   * thousand and letting the browser cope helps nobody.
   */
  async snapshot(opts: { workspaceId?: string | null; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 120, 400);

    const entities = await this.#db.query(
      `SELECT e.* FROM entity e WHERE e.account_id = $1
        ORDER BY e.mention_count DESC LIMIT $2`,
      [this.#accountId, limit],
    );
    const entityIds = entities.map((e) => e.id);

    const params: unknown[] = [this.#accountId, entityIds];
    let memWhere = '';
    if (opts.workspaceId) {
      params.push(opts.workspaceId);
      memWhere = `AND m.workspace_id = $${params.length}`;
    }

    const memories = await this.#db.query(
      `SELECT DISTINCT m.id, m.title, m.kind, m.status, m.workspace_id
         FROM memory m
         JOIN edge g ON g.src_id = m.id AND g.src_kind = 'memory'
        WHERE g.account_id = $1 AND g.dst_id = ANY($2::UUID[])
          AND m.status <> 'superseded' ${memWhere}
        LIMIT 400`,
      params,
    );
    const memoryIds = memories.map((m) => m.id);

    const edges = await this.#db.query(
      `SELECT src_kind, src_id, dst_kind, dst_id, rel, weight FROM edge
        WHERE account_id = $1
          AND ((src_kind = 'memory' AND src_id = ANY($2::UUID[]) AND dst_id = ANY($3::UUID[]))
            OR (src_kind = 'entity' AND src_id = ANY($3::UUID[]) AND dst_id = ANY($3::UUID[])))`,
      [this.#accountId, memoryIds, entityIds],
    );

    // Lineage edges, so the graph shows derivation as well as mention.
    const lineage = await this.#db.query(
      `SELECT source_id, memory_id FROM memory_source
        WHERE account_id = $1 AND memory_id = ANY($2::UUID[]) AND source_id = ANY($2::UUID[])`,
      [this.#accountId, memoryIds],
    );

    return {
      entities: entities.map(toEntity),
      memories: memories.map((m) => ({
        id: m.id,
        title: m.title,
        kind: m.kind,
        status: m.status,
        workspaceId: m.workspace_id,
      })),
      edges: [
        ...edges.map(
          (e): GraphEdge => ({
            srcKind: e.src_kind,
            srcId: e.src_id,
            dstKind: e.dst_kind,
            dstId: e.dst_id,
            rel: e.rel,
            weight: Number(e.weight),
          }),
        ),
        ...lineage.map(
          (l): GraphEdge => ({
            srcKind: 'memory',
            srcId: l.source_id,
            dstKind: 'memory',
            dstId: l.memory_id,
            rel: 'derives',
            weight: 1,
          }),
        ),
      ],
    };
  }

  /** Everything connected to one entity — the drill-down from a graph node. */
  async neighbourhood(entityId: string) {
    const memories = await this.#db.query(
      `SELECT m.id, m.title, m.kind, m.status, m.created_at, g.weight
         FROM edge g JOIN memory m ON m.id = g.src_id
        WHERE g.account_id = $1 AND g.dst_kind = 'entity' AND g.dst_id = $2
          AND g.src_kind = 'memory' AND m.status <> 'superseded'
        ORDER BY g.weight DESC, m.created_at DESC LIMIT 50`,
      [this.#accountId, entityId],
    );

    // Entities that co-occur with this one, ranked by how often.
    const related = await this.#db.query(
      `SELECT e.id, e.name, e.kind, count(*)::INT AS shared
         FROM edge a
         JOIN edge b ON b.src_id = a.src_id AND b.account_id = a.account_id
                    AND b.dst_kind = 'entity' AND b.dst_id <> a.dst_id
         JOIN entity e ON e.id = b.dst_id
        WHERE a.account_id = $1 AND a.dst_kind = 'entity' AND a.dst_id = $2
          AND a.src_kind = 'memory'
     GROUP BY e.id, e.name, e.kind
     ORDER BY shared DESC LIMIT 12`,
      [this.#accountId, entityId],
    );

    return { memories, related };
  }
}

async function linkEdge(
  client: PoolClient,
  accountId: string,
  srcKind: string,
  srcId: string,
  dstKind: string,
  dstId: string,
  rel: string,
  weight: number,
): Promise<void> {
  await client.query(
    `INSERT INTO edge (account_id, src_kind, src_id, dst_kind, dst_id, rel, weight)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (account_id, src_kind, src_id, dst_kind, dst_id, rel)
     DO UPDATE SET weight = greatest(edge.weight, excluded.weight)`,
    [accountId, srcKind, srcId, dstKind, dstId, rel, weight],
  );
}

function toEntity(r: Record<string, any>): Entity {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    canonical: r.canonical,
    summary: r.summary ?? '',
    mentionCount: Number(r.mention_count),
    firstSeen: r.first_seen?.toISOString?.() ?? String(r.first_seen),
    lastSeen: r.last_seen?.toISOString?.() ?? String(r.last_seen),
  };
}
