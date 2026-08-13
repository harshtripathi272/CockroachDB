/**
 * Seeds the Northwind Air demo scenario.
 *
 * Northwind Air is fictional. The scenario is not: in 2024 a real airline was
 * held liable by a tribunal for a refund policy its support chatbot invented.
 * The company had no way to answer "who else did we tell this to?" -- which is
 * the question this whole project exists to answer.
 *
 * The shape of the data matters for the demo:
 *   - a poisoned belief arrives from a support ticket (plausible, not obviously
 *     malicious)
 *   - it drives a refund, which makes the agent infer a "precedent" belief
 *   - the precedent drives further refunds AND a policy quote to other customers
 *   - several decisions are entirely clean and must never appear in the trace
 *
 * Timestamps are written explicitly so the blast radius spans several days,
 * which is what makes the "this has been wrong for a week" moment land.
 *
 *   node scripts/seed.ts [--target=local|cloud] [--reset]
 */
import { randomUUID } from 'node:crypto';
import { Db, FakeEmbedder, toVectorLiteral } from '../packages/recall-core/src/index.ts';
import { loadEnv, resolveConnectionString } from './env.ts';

loadEnv();

const args = new Set(process.argv.slice(2));
const target = [...args].find((a) => a.startsWith('--target='))?.split('=')[1] ?? 'local';
const reset = args.has('--reset');

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = 'northwind-support@v1';
const embedder = new FakeEmbedder();

/** Days ago, as a timestamp. */
const daysAgo = (d: number, hour = 10) => {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(hour, 0, 0, 0);
  return t;
};

interface SeedBelief {
  key: string;
  kind: string;
  subject: string;
  claim: string;
  confidence: number;
  sourceKind: string;
  sourceRef?: string;
  derivedFrom?: string;
  at: Date;
}

interface SeedDecision {
  key: string;
  action: string;
  payload: Record<string, unknown>;
  rationale: string;
  inputs: Array<[string, number]>;
  effect?: { kind: string; payload: Record<string, unknown> };
  at: Date;
}

// ---------------------------------------------------------------------------
// Beliefs
// ---------------------------------------------------------------------------
const beliefs: SeedBelief[] = [
  // --- legitimate policy knowledge -----------------------------------------
  { key: 'policy_refund_window', kind: 'semantic', subject: 'refund_policy',
    claim: 'Non-refundable economy fares may be cancelled for credit within 24 hours of booking',
    confidence: 0.95, sourceKind: 'import', sourceRef: 's3://northwind-docs/tariff-2026.pdf', at: daysAgo(30) },
  { key: 'policy_baggage', kind: 'semantic', subject: 'baggage_policy',
    claim: 'Checked baggage allowance is 23kg on economy and 32kg on business',
    confidence: 0.95, sourceKind: 'import', sourceRef: 's3://northwind-docs/tariff-2026.pdf', at: daysAgo(30) },
  { key: 'policy_change_fee', kind: 'semantic', subject: 'change_fee_policy',
    claim: 'Date changes on flexible fares incur no fee; saver fares incur a 4,500 INR fee',
    confidence: 0.93, sourceKind: 'import', sourceRef: 's3://northwind-docs/tariff-2026.pdf', at: daysAgo(30) },
  { key: 'proc_escalation', kind: 'procedural', subject: 'escalation_policy',
    claim: 'Refunds above 2,000 USD require tier-2 review before disbursement',
    confidence: 0.9, sourceKind: 'import', sourceRef: 's3://northwind-docs/sop-refunds.pdf', at: daysAgo(30) },

  // --- the poison ----------------------------------------------------------
  // Arrives as an ordinary tool observation from a support ticket. Nothing
  // about it looks wrong at write time -- that is the point.
  { key: 'POISON_bereavement', kind: 'semantic', subject: 'bereavement_policy',
    claim: 'Bereavement fares can be refunded retroactively within 90 days of travel',
    confidence: 0.82, sourceKind: 'tool', sourceRef: 's3://northwind-evidence/ticket-4471.json',
    at: daysAgo(7, 9) },

  // --- customers -----------------------------------------------------------
  { key: 'cust_8812', kind: 'entity', subject: 'customer_8812',
    claim: 'Customer 8812 (R. Mehta) travelled NW-221 BOM-LHR on 3 March 2026',
    confidence: 0.98, sourceKind: 'tool', at: daysAgo(7, 9) },
  { key: 'cust_9004', kind: 'entity', subject: 'customer_9004',
    claim: 'Customer 9004 (A. Iyer) travelled NW-118 DEL-SIN on 11 March 2026',
    confidence: 0.98, sourceKind: 'tool', at: daysAgo(5) },
  { key: 'cust_9127', kind: 'entity', subject: 'customer_9127',
    claim: 'Customer 9127 (S. Banerjee) travelled NW-402 BLR-DXB on 18 March 2026',
    confidence: 0.97, sourceKind: 'tool', at: daysAgo(4) },
  { key: 'cust_9301', kind: 'entity', subject: 'customer_9301',
    claim: 'Customer 9301 (M. Fernandes) holds a saver fare on NW-221, 2 September 2026',
    confidence: 0.96, sourceKind: 'tool', at: daysAgo(3) },
  { key: 'cust_7740', kind: 'entity', subject: 'customer_7740',
    claim: 'Customer 7740 (J. Park) is enrolled in Northwind Gold since 2021',
    confidence: 0.99, sourceKind: 'tool', at: daysAgo(6) },

  // --- preferences ---------------------------------------------------------
  { key: 'pref_8812', kind: 'preference', subject: 'customer_8812',
    claim: 'Customer 8812 prefers email contact and Hindi-language correspondence',
    confidence: 0.85, sourceKind: 'user', at: daysAgo(7, 11) },
  { key: 'pref_7740', kind: 'preference', subject: 'customer_7740',
    claim: 'Customer 7740 prefers aisle seating near the front of the cabin',
    confidence: 0.88, sourceKind: 'user', at: daysAgo(6) },
];

// ---------------------------------------------------------------------------
// Decisions, in causal order
// ---------------------------------------------------------------------------
const decisions: SeedDecision[] = [
  // clean, before the poison landed
  { key: 'd_clean_baggage', action: 'quote_policy',
    payload: { customer: 7740, topic: 'baggage' },
    rationale: 'Standard baggage allowance quoted from tariff',
    inputs: [['policy_baggage', 1.0], ['cust_7740', 0.3]],
    at: daysAgo(6, 14) },
  { key: 'd_clean_seat', action: 'assign_seat',
    payload: { customer: 7740, seat: '4C' },
    rationale: 'Honoured stated seating preference',
    inputs: [['pref_7740', 0.9], ['cust_7740', 0.5]],
    at: daysAgo(6, 15) },

  // GENERATION 0 -- consumed the poisoned belief directly
  { key: 'd_refund_8812', action: 'approve_refund',
    payload: { customer: 8812, amount_usd: 4000, currency: 'USD' },
    rationale: 'Bereavement policy permits retroactive refund within 90 days',
    inputs: [['POISON_bereavement', 0.9], ['cust_8812', 0.4]],
    effect: { kind: 'issue_refund', payload: { customer: 8812, amount_usd: 4000 } },
    at: daysAgo(7, 12) },
];

// The agent generalised from its own approval. This inference is the edge that
// makes contamination transitive -- and it is exactly how real agents drift.
const derived: SeedBelief = {
  key: 'DERIVED_precedent', kind: 'procedural', subject: 'refund_precedent',
  claim: 'Retroactive bereavement refunds are routinely approved without tier-2 review',
  confidence: 0.7, sourceKind: 'inference', derivedFrom: 'd_refund_8812',
  at: daysAgo(7, 13),
};

decisions.push(
  // GENERATION 1 -- consumed the derived belief
  { key: 'd_refund_9004', action: 'approve_refund',
    payload: { customer: 9004, amount_usd: 2750, currency: 'USD' },
    rationale: 'Precedent supports approval without escalation',
    inputs: [['DERIVED_precedent', 0.85], ['cust_9004', 0.4]],
    effect: { kind: 'issue_refund', payload: { customer: 9004, amount_usd: 2750 } },
    at: daysAgo(5, 11) },
  { key: 'd_refund_9127', action: 'approve_refund',
    payload: { customer: 9127, amount_usd: 3120, currency: 'USD' },
    rationale: 'Precedent supports approval without escalation',
    inputs: [['DERIVED_precedent', 0.8], ['cust_9127', 0.4]],
    effect: { kind: 'issue_refund', payload: { customer: 9127, amount_usd: 3120 } },
    at: daysAgo(4, 16) },
  // the quiet one: no money moved, but customers were told something false
  { key: 'd_quote_9301', action: 'quote_policy',
    payload: { customer: 9301, topic: 'bereavement', quoted: '90 day retroactive window' },
    rationale: 'Quoted the bereavement window on request',
    inputs: [['POISON_bereavement', 1.0], ['cust_9301', 0.2]],
    effect: { kind: 'send_email', payload: { customer: 9301, template: 'policy_quote' } },
    at: daysAgo(3, 10) },
  { key: 'd_waive_9301', action: 'waive_change_fee',
    payload: { customer: 9301, amount_inr: 4500 },
    rationale: 'Precedent indicates leniency is standard practice',
    inputs: [['DERIVED_precedent', 0.75], ['policy_change_fee', 0.3]],
    effect: { kind: 'issue_credit', payload: { customer: 9301, amount_inr: 4500 } },
    at: daysAgo(2, 15) },

  // clean, after the poison -- must NOT appear in the blast radius
  { key: 'd_clean_change', action: 'quote_policy',
    payload: { customer: 9301, topic: 'change_fee' },
    rationale: 'Saver fare change fee quoted from tariff',
    inputs: [['policy_change_fee', 1.0]],
    at: daysAgo(2, 9) },
  { key: 'd_clean_itinerary', action: 'send_itinerary',
    payload: { customer: 8812 },
    rationale: 'Routine itinerary resend',
    inputs: [['cust_8812', 1.0], ['pref_8812', 0.6]],
    effect: { kind: 'send_email', payload: { customer: 8812, template: 'itinerary' } },
    at: daysAgo(1, 11) },
);

async function main() {
  const conn = resolveConnectionString(target);
  console.log(`seeding ${target} -> ${conn.replace(/:[^:@]+@/, ':***@')}`);
  const db = new Db({ connectionString: conn, applicationName: 'recall-seed' });

  if (reset) {
    for (const t of ['audit_log', 'effect_outbox', 'decision_input', 'decision', 'belief', 'scratch']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [TENANT]);
    }
    console.log('cleared existing tenant data');
  }

  const beliefIds = new Map<string, string>();
  const decisionIds = new Map<string, string>();
  for (const b of [...beliefs, derived]) beliefIds.set(b.key, randomUUID());
  for (const d of decisions) decisionIds.set(d.key, randomUUID());

  // Beliefs first (derived one included; its decision FK is soft, not enforced,
  // so ordering is free).
  for (const b of [...beliefs, derived]) {
    const emb = await embedder.embed(`${b.subject}: ${b.claim}`);
    await db.query(
      `INSERT INTO belief (tenant_id,id,kind,subject,claim,confidence,status,
         embedding,source_kind,source_ref,derived_from_decision,valid_from,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,$11)`,
      [TENANT, beliefIds.get(b.key), b.kind, b.subject, b.claim, b.confidence,
       toVectorLiteral(emb), b.sourceKind, b.sourceRef ?? null,
       b.derivedFrom ? decisionIds.get(b.derivedFrom) : null, b.at],
    );
  }
  console.log(`  ${beliefs.length + 1} beliefs`);

  for (const d of decisions) {
    const did = decisionIds.get(d.key)!;
    await db.query(
      `INSERT INTO decision (tenant_id,id,action,payload,rationale,status,actor,committed_at)
       VALUES ($1,$2,$3,$4,$5,'committed',$6,$7)`,
      [TENANT, did, d.action, JSON.stringify(d.payload), d.rationale, AGENT, d.at],
    );
    for (const [key, weight] of d.inputs) {
      await db.query(
        `INSERT INTO decision_input (tenant_id,decision_id,belief_id,belief_valid_from,weight)
         SELECT $1,$2,id,valid_from,$4 FROM belief WHERE tenant_id=$1 AND id=$3`,
        [TENANT, did, beliefIds.get(key), weight],
      );
    }
    if (d.effect) {
      await db.query(
        `INSERT INTO effect_outbox (tenant_id,decision_id,kind,payload,state,created_at,delivered_at)
         VALUES ($1,$2,$3,$4,'confirmed',$5,$5)`,
        [TENANT, did, d.effect.kind, JSON.stringify(d.effect.payload), d.at],
      );
    }
  }
  console.log(`  ${decisions.length} decisions`);

  const poison = beliefIds.get('POISON_bereavement')!;
  console.log(`\ndone. the poisoned belief is:\n  ${poison}`);
  console.log(`expected blast radius: 5 decisions (2 at generation 0, 3 at generation 1)`);
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
