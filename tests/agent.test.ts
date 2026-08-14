import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db, FakeEmbedder, Recall } from '../packages/recall-core/src/index.ts';
import { SupportAgent } from '../apps/agent/agent.ts';
import { PolicyReasoner } from '../apps/agent/reasoner.ts';
import { loadEnv, resolveConnectionString } from '../scripts/env.ts';

loadEnv();

/**
 * Regression tests for two bugs found by running the agent against real data
 * rather than by reading the code.
 */

let db: Db;
let recall: Recall;
let agent: SupportAgent;
const tenant = randomUUID();

before(() => {
  db = new Db({
    connectionString: resolveConnectionString(process.env.RECALL_TARGET ?? 'local'),
    applicationName: 'recall-agent-tests',
  });
  recall = new Recall({ db, embedder: new FakeEmbedder(), actor: 'test-agent@v1' });
  agent = new SupportAgent({ recall, reasoner: new PolicyReasoner(), tenantId: tenant });
});

after(async () => { await db.close(); });

describe('agent loop', () => {
  test('does not mistake a flight number for a refund amount', async () => {
    await recall.remember({
      tenantId: tenant,
      kind: 'semantic',
      subject: 'bereavement_policy',
      claim: 'Bereavement fares can be refunded retroactively within 90 days of travel',
      sourceKind: 'tool',
    });

    const r = await agent.handle(
      'I could not fly on NW-221 in March. I want a refund of $3400 for the bereavement fare.',
    );

    assert.equal(r.verdict.action, 'approve_refund');
    assert.equal(
      r.verdict.payload.amount_usd,
      3400,
      'must read the $ amount, not the flight number',
    );
  });

  test('records no amount rather than inventing one', async () => {
    const r = await agent.handle('Please refund my bereavement fare on flight NW-118.');
    assert.equal(
      r.verdict.payload.amount_usd,
      undefined,
      'a bare number in the text is not an amount',
    );
  });

  test('refuses to act when no belief supports the request', async () => {
    const r = await agent.handle('Please upgrade me to a private jet, free of charge.');
    assert.equal(r.decisionId, null, 'nothing is committed');
    assert.equal(r.verdict.approve, false);
  });

  test('every committed decision carries its belief lineage', async () => {
    const r = await agent.handle('Can I get a refund of $500 for my bereavement fare?');
    assert.ok(r.decisionId, 'a decision was committed');
    const { inputs } = await (async () => {
      const rows = await db.query<{ belief_id: string }>(
        `SELECT belief_id FROM decision_input WHERE tenant_id = $1 AND decision_id = $2`,
        [tenant, r.decisionId],
      );
      return { inputs: rows };
    })();
    assert.ok(inputs.length > 0, 'lineage edges were written');
    assert.equal(inputs.length, r.verdict.used.length, 'one edge per cited belief');
  });
});

describe('blast radius de-duplication', () => {
  test('a decision reachable by two paths appears once, at its shortest path', async () => {
    const t = randomUUID();
    const local = new Recall({ db, embedder: new FakeEmbedder(), actor: 'dedupe@v1' });

    const poison = await local.remember({
      tenantId: t, kind: 'semantic', subject: 'policy',
      claim: 'Retroactive refunds are permitted', sourceKind: 'tool',
    });

    // d1 uses the poison directly.
    const d1 = await local.decide({
      tenantId: t, action: 'approve_refund', payload: { amount_usd: 100 },
      inputs: [{ beliefId: poison.id, weight: 1 }],
    });

    // d1 spawns an inferred belief.
    const derived = await local.remember({
      tenantId: t, kind: 'procedural', subject: 'precedent',
      claim: 'These are routinely approved', sourceKind: 'inference',
      derivedFromDecision: d1.id,
    });

    // d2 cites BOTH the poison and the belief inferred from d1, so it is
    // reachable at two different depths. Before the fix it appeared twice.
    const d2 = await local.decide({
      tenantId: t, action: 'approve_refund', payload: { amount_usd: 200 },
      inputs: [
        { beliefId: poison.id, weight: 0.5 },
        { beliefId: derived.id, weight: 0.5 },
      ],
    });

    const blast = await local.traceBlastRadius(t, poison.id);
    const ids = blast.map((b) => b.id);

    assert.equal(new Set(ids).size, ids.length, 'no duplicate rows');
    assert.equal(blast.length, 2, 'exactly two decisions');

    const byId = new Map(blast.map((b) => [b.id, Number(b.generation)]));
    assert.equal(byId.get(d1.id), 0);
    assert.equal(
      byId.get(d2.id),
      0,
      'reachable directly and indirectly -> report the shortest path',
    );
  });
});
