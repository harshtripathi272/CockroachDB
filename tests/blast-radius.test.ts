import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Db, FakeEmbedder, Recall } from '../packages/recall-core/src/index.ts';
import { loadEnv, resolveConnectionString } from '../scripts/env.ts';

loadEnv();

/**
 * End-to-end against a real CockroachDB cluster.
 *
 * Uses FakeEmbedder so the suite needs no AWS credentials and stays
 * deterministic -- we are testing lineage and governance here, not embedding
 * quality.
 */

// Honours RECALL_TARGET so the suite runs against either the local
// 3-node cluster or CockroachDB Cloud.
const CONN = resolveConnectionString(process.env.RECALL_TARGET ?? 'local');

let db: Db;
let recall: Recall;
const tenant = randomUUID();

before(() => {
  db = new Db({ connectionString: CONN, applicationName: 'recall-tests' });
  recall = new Recall({
    db,
    embedder: new FakeEmbedder(),
    actor: 'test-agent@v1',
  });
});

after(async () => {
  await db.close();
});

describe('contamination tracing', () => {
  test('traces a false belief through transitive decisions', async () => {
    // A policy belief that will later turn out to be false.
    const policy = await recall.remember({
      tenantId: tenant,
      kind: 'semantic',
      subject: 'refund_policy',
      claim: 'Bereavement fares can be refunded retroactively within 90 days',
      sourceKind: 'tool',
      sourceRef: 's3://recall-evidence/ticket-4471.json',
    });

    const customer = await recall.remember({
      tenantId: tenant,
      kind: 'entity',
      subject: 'customer_8812',
      claim: 'Customer 8812 travelled on flight NW-221 in March',
      sourceKind: 'user',
    });

    // Decision 1 consumed the false policy directly.
    const d1 = await recall.decide({
      tenantId: tenant,
      action: 'approve_refund',
      payload: { customer: 8812, amount_usd: 4000 },
      rationale: 'Policy permits retroactive bereavement refund',
      inputs: [
        { beliefId: policy.id, weight: 0.9 },
        { beliefId: customer.id, weight: 0.4 },
      ],
      effect: { kind: 'issue_refund', payload: { amount_usd: 4000 } },
    });

    // That decision made the agent infer a *new* belief. This is the edge that
    // makes contamination transitive.
    const precedent = await recall.remember({
      tenantId: tenant,
      kind: 'procedural',
      subject: 'refund_precedent',
      claim: 'Retroactive bereavement refunds are routinely approved',
      sourceKind: 'inference',
      derivedFromDecision: d1.id,
    });

    // Decision 2 consumed only the derived belief -> one generation downstream.
    const d2 = await recall.decide({
      tenantId: tenant,
      action: 'approve_refund',
      payload: { customer: 9004, amount_usd: 2750 },
      rationale: 'Precedent supports approval',
      inputs: [{ beliefId: precedent.id, weight: 0.85 }],
      effect: { kind: 'issue_refund', payload: { amount_usd: 2750 } },
    });

    // A clean decision that must NOT show up in the blast radius.
    const d3 = await recall.decide({
      tenantId: tenant,
      action: 'send_itinerary',
      payload: { customer: 8812 },
      inputs: [{ beliefId: customer.id, weight: 1.0 }],
    });

    // The policy turns out to be false.
    await recall.retract(tenant, policy.id, 'Contradicted by published tariff');

    const blast = await recall.traceBlastRadius(tenant, policy.id);
    const ids = blast.map((b) => b.id);

    assert.equal(blast.length, 2, 'exactly two decisions were contaminated');
    assert.ok(ids.includes(d1.id), 'directly caused decision is included');
    assert.ok(ids.includes(d2.id), 'downstream decision is included');
    assert.ok(!ids.includes(d3.id), 'unrelated decision is NOT included');

    const byId = new Map(blast.map((b) => [b.id, b]));
    assert.equal(Number(byId.get(d1.id)!.generation), 0, 'd1 is generation 0');
    assert.equal(Number(byId.get(d2.id)!.generation), 1, 'd2 is generation 1');

    // Reverting must also quarantine beliefs inferred from those decisions.
    const result = await recall.revert(tenant, ids, 'contaminated by false policy');
    assert.equal(result.reverted, 2);

    const [after] = await db.query<{ status: string }>(
      `SELECT status FROM belief WHERE tenant_id = $1 AND id = $2`,
      [tenant, precedent.id],
    );
    assert.equal(after.status, 'quarantined', 'derived belief was quarantined');
  });
});

describe('governance guarantees', () => {
  test('refuses to record an action with no belief lineage', async () => {
    await assert.rejects(
      () =>
        recall.decide({
          tenantId: tenant,
          action: 'approve_refund',
          payload: { amount_usd: 100 },
          inputs: [],
        }),
      /no belief lineage/,
    );
  });

  test('refuses to act on a retracted belief', async () => {
    const b = await recall.remember({
      tenantId: tenant,
      kind: 'assumption',
      subject: 'shaky',
      claim: 'This might be true',
      sourceKind: 'inference',
    });
    await recall.retract(tenant, b.id, 'proven false');

    await assert.rejects(
      () =>
        recall.decide({
          tenantId: tenant,
          action: 'approve_refund',
          payload: { amount_usd: 50 },
          inputs: [{ beliefId: b.id }],
        }),
      /non-active beliefs/,
    );
  });

  test('quarantined beliefs are excluded from recall', async () => {
    const b = await recall.remember({
      tenantId: tenant,
      kind: 'semantic',
      subject: 'baggage_policy',
      claim: 'Checked baggage allowance is 23kg on all fares',
      sourceKind: 'tool',
    });

    const before = await recall.recall({
      tenantId: tenant,
      text: 'Checked baggage allowance is 23kg on all fares',
      limit: 5,
    });
    assert.ok(before.some((r) => r.id === b.id), 'findable while active');

    await recall.retract(tenant, b.id, 'superseded by new tariff');

    const afterRetract = await recall.recall({
      tenantId: tenant,
      text: 'Checked baggage allowance is 23kg on all fares',
      limit: 5,
    });
    assert.ok(
      !afterRetract.some((r) => r.id === b.id),
      'retracted belief is not returned by recall',
    );
  });
});
