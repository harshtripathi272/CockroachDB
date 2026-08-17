import type { Db } from './db.ts';
import { audit } from './memory.ts';
import type { WikiCitation, WikiKind, WikiPage } from './types.ts';

/**
 * The organise layer.
 *
 * A wiki page is never authoritative — it is a rendering of the memories
 * underneath it, and every claim records which ones. That single constraint is
 * what separates this from a summariser:
 *
 *   - The UI can show receipts. Click a claim, see the raw memories behind it.
 *   - A correction knows precisely which pages it invalidates.
 *   - A page can be regenerated from scratch at any time, because nothing lives
 *     only in the prose.
 *
 * Pages are marked stale rather than deleted when a source is corrected. Stale
 * beats blank: the page keeps serving while the UI flags it, instead of a single
 * correction blanking half the wiki until the next dream pass.
 */

function toPage(r: Record<string, any>): WikiPage {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    title: r.title,
    kind: r.kind,
    bodyMd: r.body_md ?? '',
    summary: r.summary ?? '',
    generator: r.generator ?? 'dream',
    sourceCount: Number(r.source_count ?? 0),
    stale: Boolean(r.stale),
    generatedAt: r.generated_at?.toISOString?.() ?? String(r.generated_at),
  };
}

export class WikiStore {
  #db: Db;
  #accountId: string;

  constructor(db: Db, accountId: string) {
    this.#db = db;
    this.#accountId = accountId;
  }

  async list(opts: { workspaceId?: string | null; kind?: WikiKind } = {}): Promise<WikiPage[]> {
    const params: unknown[] = [this.#accountId];
    const where = ['account_id = $1'];
    if (opts.workspaceId) {
      params.push(opts.workspaceId);
      where.push(`workspace_id = $${params.length}`);
    }
    if (opts.kind) {
      params.push(opts.kind);
      where.push(`kind = $${params.length}`);
    }
    const rows = await this.#db.query(
      `SELECT * FROM wiki_page WHERE ${where.join(' AND ')}
        ORDER BY kind, title`,
      params,
    );
    return rows.map(toPage);
  }

  /** A page plus its citations, each resolved to the memory it points at. */
  async get(slug: string): Promise<WikiPage | null> {
    const row = await this.#db.one(
      `SELECT * FROM wiki_page WHERE account_id = $1 AND slug = $2`,
      [this.#accountId, slug],
    );
    if (!row) return null;

    const cites = await this.#db.query(
      `SELECT c.memory_id, c.claim, m.title, m.status
         FROM wiki_citation c
         JOIN memory m ON m.id = c.memory_id
        WHERE c.account_id = $1 AND c.page_id = $2
        ORDER BY c.claim`,
      [this.#accountId, row.id],
    );

    return {
      ...toPage(row),
      citations: cites.map(
        (c): WikiCitation => ({
          memoryId: c.memory_id,
          claim: c.claim,
          memoryTitle: c.title,
          memoryStatus: c.status,
        }),
      ),
    };
  }

  /**
   * Write a page and replace its citations atomically.
   *
   * Citations are deleted and reinserted rather than diffed. A page is fully
   * regenerated each time, so a surviving citation from a previous generation
   * would be a claim the current text no longer makes — which is exactly the
   * kind of quiet inconsistency the receipts are meant to prevent.
   */
  async upsert(input: {
    slug: string;
    title: string;
    kind: WikiKind;
    bodyMd: string;
    summary?: string;
    workspaceId?: string | null;
    generator?: string;
    citations?: Array<{ memoryId: string; claim?: string }>;
  }): Promise<WikiPage> {
    const row = await this.#db.inTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO wiki_page
           (account_id, workspace_id, slug, title, kind, body_md, summary,
            generator, source_count, stale, generated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,now())
         ON CONFLICT (account_id, slug) DO UPDATE
            SET title = excluded.title, kind = excluded.kind,
                body_md = excluded.body_md, summary = excluded.summary,
                generator = excluded.generator, source_count = excluded.source_count,
                workspace_id = excluded.workspace_id,
                stale = false, generated_at = now()
         RETURNING *`,
        [
          this.#accountId,
          input.workspaceId ?? null,
          input.slug,
          input.title,
          input.kind,
          input.bodyMd,
          input.summary ?? '',
          input.generator ?? 'dream',
          input.citations?.length ?? 0,
        ],
      );
      const page = rows[0];

      await client.query(`DELETE FROM wiki_citation WHERE page_id = $1 AND account_id = $2`, [
        page.id,
        this.#accountId,
      ]);

      for (const c of input.citations ?? []) {
        await client.query(
          `INSERT INTO wiki_citation (page_id, memory_id, account_id, claim)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [page.id, c.memoryId, this.#accountId, c.claim ?? ''],
        );
      }

      await audit(client, this.#accountId, 'wiki.generate', 'wiki_page', page.id, {
        slug: input.slug,
        citations: input.citations?.length ?? 0,
        generator: input.generator ?? 'dream',
      });

      return page;
    });

    return toPage(row);
  }

  async stalePages(): Promise<WikiPage[]> {
    const rows = await this.#db.query(
      `SELECT * FROM wiki_page WHERE account_id = $1 AND stale = true ORDER BY generated_at`,
      [this.#accountId],
    );
    return rows.map(toPage);
  }

  /** Pages citing a given memory — the reverse lookup a correction needs. */
  async pagesCiting(memoryId: string): Promise<WikiPage[]> {
    const rows = await this.#db.query(
      `SELECT p.* FROM wiki_page p
         JOIN wiki_citation c ON c.page_id = p.id
        WHERE c.account_id = $1 AND c.memory_id = $2`,
      [this.#accountId, memoryId],
    );
    return rows.map(toPage);
  }

  async search(query: string, limit = 10): Promise<WikiPage[]> {
    // Plain ILIKE. The wiki is small (tens of pages, not thousands) and it is
    // the memories underneath that carry the vector index; adding a second
    // embedding surface here would be cost without benefit.
    const rows = await this.#db.query(
      `SELECT * FROM wiki_page
        WHERE account_id = $1 AND (title ILIKE $2 OR summary ILIKE $2 OR body_md ILIKE $2)
        ORDER BY CASE WHEN title ILIKE $2 THEN 0 ELSE 1 END, title
        LIMIT $3`,
      [this.#accountId, `%${query}%`, limit],
    );
    return rows.map(toPage);
  }
}
