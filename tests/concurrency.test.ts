import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db, FakeEmbedder, Recall } from '../packages/recall-core/src/index.ts';
import { loadEnv, resolveConnectionString } from '../scripts/env.ts';

loadEnv();

/**
 * Evidence for the claim that a real database is doing real work here.
 *
 * The failure mode being tested is the classic lost update: several agents read
 * the same belief, each computes a new confidence from what it read, and each
 * writes it back. On a store without cross-record transactions the writes
 * clobber one another and the final value reflects only the last writer -- the
 * other agents' observations silently vanish.
 *
 * Under CockroachDB's SERIALIZABLE isolation the conflicting transactions are
 * aborted with SQLSTATE 40001 and retried by `Db.inTransaction`, so every
 * increment survives. That retry loop is the thing under test as much as the
 * database is.
 */

// Honours RECALL_TARGET so the suite runs against either the local
// 3-node cluster or CockroachDB Cloud.
const CONN = resolveConnectionString(process.env.RECALL_TARGET ?? 'local');

let db: Db;
let recall: Recall;
const tenant = randomUUID();

before(() => {
  db = new Db({ connectionString: CONN, applicationName: 'recall-concurrency' });
  recall = new Recall({ db, embedder: new FakeEmbedder(), actor: 'race-agent@v1' });
});

after(async () => {
  await db.close();
});

describe('concurrent agents on shared memory', () => {
  test('no lost updates when 20 agents reinforce the same belief', async () => {
    const belief = await recall.remember({
      tenantId: tenant,
      kind: 'semantic',
      subject: 'contended_fact',
      claim: 'Seat 14A is an exit row',
      confidence: 0.0,
      sourceKind: 'tool',
    });

    const AGENTS = 20;
    const STEP = 0.01;

    // Each "agent" does read-modify-write in its own transaction. Without
    // serializable isolation plus retry, most of these increments are lost.
    const runs = Array.from({ length: AGENTS }, () =>
      db.inTransaction(async (c) => {
        const { rows } = await c.query<{ confidence: number }>(
          `SELECT confidence FROM belief WHERE tenant_id = $1 AND id = $2`,
          [tenant, belief.id],
        );
        const next = Number(rows[0].confidence) + STEP;
        await c.query(
          `UPDATE belief SET confidence = $3 WHERE tenant_id = $1 AND id = $2`,
          [tenant, belief.id, next],
        );
      }),
    );

    await Promise.all(runs);

    const [final] = await db.query<{ confidence: number }>(
      `SELECT confidence FROM belief WHERE tenant_id = $1 AND id = $2`,
      [tenant, belief.id],
    );

    assert.equal(
      Number(final.confidence).toFixed(2),
      (AGENTS * STEP).toFixed(2),
      `expected all ${AGENTS} increments to survive`,
    );
  });

  test('concurrent decisions on one belief all record their lineage', async () => {
    const belief = await recall.remember({
      tenantId: tenant,
      kind: 'semantic',
      subject: 'shared_policy',
      claim: 'Refunds are processed within 7 business days',
      sourceKind: 'import',
    });

    const AGENTS = 12;
    const decisions = await Promise.all(
      Array.from({ length: AGENTS }, (_, i) =>
        recall.decide({
          tenantId: tenant,
          action: 'quote_policy',
          payload: { customer: 1000 + i },
          rationale: 'Quoted refund processing time',
          inputs: [{ beliefId: belief.id, weight: 1.0 }],
        }),
      ),
    );

    assert.equal(new Set(decisions.map((d) => d.id)).size, AGENTS, 'all distinct');

    const [{ count }] = await db.query<{ count: string }>(
      `SELECT count(*)::STRING AS count FROM decision_input
        WHERE tenant_id = $1 AND belief_id = $2`,
      [tenant, belief.id],
    );
    assert.equal(Number(count), AGENTS, 'every decision recorded its lineage edge');

    // And the blast radius must find all of them.
    const blast = await recall.traceBlastRadius(tenant, belief.id);
    assert.equal(blast.length, AGENTS, 'blast radius sees every contaminated decision');
  });
});
