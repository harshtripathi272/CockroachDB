import type { PoolClient } from 'pg';
import { Db } from './db.ts';
import { toVectorLiteral, type Embedder } from './embeddings.ts';
import type {
  Belief,
  BeliefKind,
  ContaminatedDecision,
  Decision,
  RecallQuery,
  RecalledBelief,
  SourceKind,
} from './types.ts';

export interface RecallConfig {
  db: Db;
  embedder: Embedder;
  /** Identity written into every audit row, e.g. 'support-agent@v1'. */
  actor: string;
}

export interface RememberInput {
  tenantId: string;
  kind: BeliefKind;
  subject: string;
  claim: string;
  confidence?: number;
  sourceKind: SourceKind;
  sourceRef?: string;
  /** Set when an agent action produced this belief. Propagates contamination. */
  derivedFromDecision?: string;
}

export interface DecideInput {
  tenantId: string;
  action: string;
  payload: Record<string, unknown>;
  rationale?: string;
  /** The beliefs that drove this decision, with how much each mattered. */
  inputs: Array<{ beliefId: string; weight?: number }>;
  /** The external side effect, committed as intent -- never fired inline. */
  effect?: { kind: string; payload: Record<string, unknown> };
}

/**
 * Recall: governable agent memory.
 *
 * The design rule behind every method here: an agent must never be able to act
 * without leaving a record of *why*. `decide()` is the only way to record an
 * action, and it will not let you record one without its belief lineage.
 */
export class Recall {
  // Explicit field + assignment rather than a constructor parameter property:
  // Node's strip-only TypeScript support cannot emit the implied assignment.
  private cfg: RecallConfig;

  constructor(cfg: RecallConfig) {
    this.cfg = cfg;
  }

  // ---------------------------------------------------------------------
  // Write path
  // ---------------------------------------------------------------------

  /** Store a new belief. Embedding is computed here so callers cannot skip it. */
  async remember(input: RememberInput): Promise<Belief> {
    const embedding = await this.cfg.embedder.embed(
      `${input.subject}: ${input.claim}`,
    );

    return this.cfg.db.inTransaction(async (c) => {
      const { rows } = await c.query<Belief>(
        `INSERT INTO belief
           (tenant_id, kind, subject, claim, confidence, status,
            embedding, source_kind, source_ref, derived_from_decision)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9)
         RETURNING id, tenant_id AS "tenantId", kind, subject, claim,
                   confidence, status, source_kind AS "sourceKind",
                   valid_from AS "validFrom", created_at AS "createdAt"`,
        [
          input.tenantId,
          input.kind,
          input.subject,
          input.claim,
          input.confidence ?? defaultConfidence(input.sourceKind),
          toVectorLiteral(embedding),
          input.sourceKind,
          input.sourceRef ?? null,
          input.derivedFromDecision ?? null,
        ],
      );

      const belief = rows[0];
      await this.audit(c, input.tenantId, 'remember', 'belief', belief.id, {
        subject: input.subject,
        sourceKind: input.sourceKind,
      });
      return belief;
    });
  }

  /**
   * Record an agent action together with everything that caused it.
   *
   * This is the transaction that cannot be expressed on a vector database. In
   * one serializable commit:
   *   1. the decision
   *   2. the exact belief *versions* it consumed (lineage)
   *   3. confidence reinforcement on those beliefs (memory mutation)
   *   4. the external effect, as intent in the outbox
   *   5. the audit row
   *
   * If the effect can never be delivered, the whole thing rolls back. The agent
   * can never believe it did something the world never saw.
   */
  async decide(input: DecideInput): Promise<Decision> {
    if (input.inputs.length === 0) {
      // Refusing this is the entire point of the product. An action with no
      // recorded cause is exactly the thing we exist to make impossible.
      throw new Error(
        `Decision '${input.action}' has no belief lineage. Every action must ` +
          `record the beliefs that caused it.`,
      );
    }

    return this.cfg.db.inTransaction(async (c) => {
      const beliefIds = input.inputs.map((i) => i.beliefId);

      // Guard: never let an agent act on a belief we have already doubted.
      const { rows: bad } = await c.query<{ id: string; status: string }>(
        `SELECT id, status FROM belief
          WHERE tenant_id = $1 AND id = ANY($2::UUID[]) AND status <> 'active'`,
        [input.tenantId, beliefIds],
      );
      if (bad.length > 0) {
        throw new Error(
          `Refusing to act on non-active beliefs: ` +
            bad.map((b) => `${b.id} (${b.status})`).join(', '),
        );
      }

      const { rows: dRows } = await c.query<Decision>(
        `INSERT INTO decision (tenant_id, action, payload, rationale, actor)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, tenant_id AS "tenantId", action, payload, rationale,
                   status, actor, committed_at AS "committedAt"`,
        [
          input.tenantId,
          input.action,
          JSON.stringify(input.payload),
          input.rationale ?? null,
          this.cfg.actor,
        ],
      );
      const decision = dRows[0];

      // Lineage. belief_valid_from pins the exact version consumed, so later
      // edits to a belief do not silently rewrite history.
      for (const { beliefId, weight } of input.inputs) {
        await c.query(
          `INSERT INTO decision_input
             (tenant_id, decision_id, belief_id, belief_valid_from, weight)
           SELECT $1, $2, id, valid_from, $4
             FROM belief WHERE tenant_id = $1 AND id = $3`,
          [input.tenantId, decision.id, beliefId, weight ?? null],
        );
      }

      // Acting on a belief reinforces it.
      await c.query(
        `UPDATE belief SET confidence = least(1.0, confidence + 0.05)
          WHERE tenant_id = $1 AND id = ANY($2::UUID[]) AND status = 'active'`,
        [input.tenantId, beliefIds],
      );

      if (input.effect) {
        await c.query(
          `INSERT INTO effect_outbox (tenant_id, decision_id, kind, payload)
           VALUES ($1,$2,$3,$4)`,
          [
            input.tenantId,
            decision.id,
            input.effect.kind,
            JSON.stringify(input.effect.payload),
          ],
        );
      }

      await this.audit(c, input.tenantId, 'decide', 'decision', decision.id, {
        action: input.action,
        beliefCount: beliefIds.length,
      });
      return decision;
    });
  }

  // ---------------------------------------------------------------------
  // Read path
  // ---------------------------------------------------------------------

  /**
   * Semantic search over active beliefs.
   *
   * Every clause here is deliberate and was verified against EXPLAIN:
   *  - `status = 'active'` is a prefix column, so quarantined beliefs are
   *    excluded *by the index*, not by a post-filter that could be forgotten.
   *  - the distance operator is `<=>` because the index declares
   *    vector_cosine_ops. Using `<->` here silently degrades to a full scan.
   */
  async recall(q: RecallQuery): Promise<RecalledBelief[]> {
    const embedding = toVectorLiteral(await this.cfg.embedder.embed(q.text));
    const limit = q.limit ?? 8;

    // Historical reads bypass the vector index: within the GC window we read
    // the whole row set as of that timestamp, beyond it we use the bitemporal
    // columns. Both are exact rather than approximate, which is the right
    // trade-off for forensics.
    if (q.asOf) return this.recallAsOf(q, embedding, limit);

    const params: unknown[] = [q.tenantId, embedding, limit];
    let kindFilter = '';
    if (q.kinds?.length) {
      params.push(q.kinds);
      kindFilter = `AND kind = ANY($${params.length}::STRING[])`;
    }
    let confFilter = '';
    if (q.minConfidence !== undefined) {
      params.push(q.minConfidence);
      confFilter = `AND confidence >= $${params.length}`;
    }

    return this.cfg.db.query<RecalledBelief>(
      `SELECT id, tenant_id AS "tenantId", kind, subject, claim, confidence,
              status, source_kind AS "sourceKind", source_ref AS "sourceRef",
              derived_from_decision AS "derivedFromDecision",
              valid_from AS "validFrom", created_at AS "createdAt",
              embedding <=> $2 AS distance
         FROM belief
        WHERE tenant_id = $1
          AND status = 'active'
          ${kindFilter}
          ${confFilter}
        ORDER BY embedding <=> $2
        LIMIT $3`,
      params,
    );
  }

  private async recallAsOf(
    q: RecallQuery,
    embedding: string,
    limit: number,
  ): Promise<RecalledBelief[]> {
    const at = q.asOf!;
    const select = `
      SELECT id, tenant_id AS "tenantId", kind, subject, claim, confidence,
             status, source_kind AS "sourceKind", source_ref AS "sourceRef",
             derived_from_decision AS "derivedFromDecision",
             valid_from AS "validFrom", created_at AS "createdAt",
             embedding <=> $2 AS distance
        FROM belief AS_OF_PLACEHOLDER
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY embedding <=> $2 LIMIT $3`;

    if (this.cfg.db.isWithinGcWindow(at)) {
      return this.cfg.db.asOf<RecalledBelief>(at, select, [
        q.tenantId,
        embedding,
        limit,
      ]);
    }

    // Older than the GC window: reconstruct from bitemporal columns instead.
    return this.cfg.db.query<RecalledBelief>(
      select
        .replace('AS_OF_PLACEHOLDER', '')
        .replace(
          `WHERE tenant_id = $1 AND status = 'active'`,
          `WHERE tenant_id = $1
             AND valid_from <= $4
             AND (valid_to IS NULL OR valid_to > $4)`,
        ),
      [q.tenantId, embedding, limit, at],
    );
  }

  // ---------------------------------------------------------------------
  // Governance
  // ---------------------------------------------------------------------

  /** Mark a belief false. Does not touch downstream decisions -- see trace(). */
  async retract(
    tenantId: string,
    beliefId: string,
    reason: string,
  ): Promise<void> {
    await this.cfg.db.inTransaction(async (c) => {
      await c.query(
        `UPDATE belief SET status = 'retracted', valid_to = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, beliefId],
      );
      await this.audit(c, tenantId, 'retract', 'belief', beliefId, { reason });
    });
  }

  /**
   * "This belief was false. What did it contaminate?"
   *
   * Walks belief -> decision -> derived belief -> decision ... transitively.
   * See db/queries/blast_radius.sql for the full annotated query and why it is
   * shaped as a single recursive walk over a flattened edge set.
   */
  async traceBlastRadius(
    tenantId: string,
    beliefId: string,
  ): Promise<ContaminatedDecision[]> {
    return this.cfg.db.query<ContaminatedDecision>(
      `WITH RECURSIVE
       edges (src_kind, src_id, dst_kind, dst_id) AS (
           SELECT 'belief', di.belief_id, 'decision', di.decision_id
             FROM decision_input di WHERE di.tenant_id = $1::UUID
         UNION ALL
           SELECT 'decision', b.derived_from_decision, 'belief', b.id
             FROM belief b
            WHERE b.tenant_id = $1::UUID AND b.derived_from_decision IS NOT NULL
       ),
       taint (kind, id, hops) AS (
           SELECT 'belief', $2::UUID, 0
         UNION
           SELECT e.dst_kind, e.dst_id, t.hops + 1
             FROM taint t
             JOIN edges e ON e.src_kind = t.kind AND e.src_id = t.id
            WHERE t.hops < 32
       )
       -- A decision can be reached by more than one path: an agent that cites
       -- both the false belief AND something inferred from it shows up at two
       -- depths. Group to the SHORTEST path, so each decision appears once at
       -- its most direct link to the falsified belief.
       SELECT d.id, d.action, d.payload, d.rationale, d.status, d.actor,
              d.committed_at AS "committedAt",
              min((t.hops - 1) // 2) AS generation
         FROM taint t
         JOIN decision d ON d.tenant_id = $1::UUID AND d.id = t.id
        WHERE t.kind = 'decision' AND d.status = 'committed'
        GROUP BY d.id, d.action, d.payload, d.rationale, d.status, d.actor, d.committed_at
        ORDER BY generation ASC, d.committed_at ASC`,
      [tenantId, beliefId],
    );
  }

  /**
   * Undo the blast radius: quarantine the contaminated decisions, quarantine
   * every belief inferred from them, and enqueue compensating effects.
   *
   * Done in one transaction so a partially-reverted world is not observable.
   */
  async revert(
    tenantId: string,
    decisionIds: string[],
    reason: string,
  ): Promise<{ reverted: number; compensations: number }> {
    if (decisionIds.length === 0) return { reverted: 0, compensations: 0 };

    return this.cfg.db.inTransaction(async (c) => {
      const { rowCount: reverted } = await c.query(
        `UPDATE decision SET status = 'reverted', reverted_at = now()
          WHERE tenant_id = $1 AND id = ANY($2::UUID[]) AND status = 'committed'`,
        [tenantId, decisionIds],
      );

      // Beliefs the agent inferred from a reverted decision are no longer
      // trustworthy either.
      await c.query(
        `UPDATE belief SET status = 'quarantined', valid_to = now()
          WHERE tenant_id = $1 AND derived_from_decision = ANY($2::UUID[])
            AND status = 'active'`,
        [tenantId, decisionIds],
      );

      // Compensating effects for anything already delivered to the world.
      const { rowCount: compensations } = await c.query(
        `INSERT INTO effect_outbox (tenant_id, decision_id, kind, payload)
         SELECT tenant_id, decision_id, 'compensate:' || kind,
                jsonb_build_object('original', payload, 'reason', $3::STRING)
           FROM effect_outbox
          WHERE tenant_id = $1 AND decision_id = ANY($2::UUID[])
            AND state = 'confirmed'`,
        [tenantId, decisionIds, reason],
      );

      for (const id of decisionIds) {
        await this.audit(c, tenantId, 'revert', 'decision', id, { reason });
      }
      return { reverted: reverted ?? 0, compensations: compensations ?? 0 };
    });
  }

  private async audit(
    c: PoolClient,
    tenantId: string,
    operation: string,
    targetKind: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await c.query(
      `INSERT INTO audit_log
         (tenant_id, actor, operation, target_kind, target_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, this.cfg.actor, operation, targetKind, targetId, JSON.stringify(detail)],
    );
  }
}

/** Provenance drives how much we trust a belief on arrival. */
function defaultConfidence(source: SourceKind): number {
  switch (source) {
    case 'user':
      return 0.8;
    case 'tool':
      return 0.9;
    case 'import':
      return 0.7;
    case 'inference':
      return 0.5;
  }
}
