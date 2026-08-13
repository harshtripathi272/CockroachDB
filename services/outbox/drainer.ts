/**
 * Outbox drainer.
 *
 * This is the other half of the atomicity guarantee. `Recall.decide()` writes an
 * external side effect into `effect_outbox` inside the same transaction as the
 * decision and the belief mutation -- it never fires the effect inline, because
 * a serializable transaction can be retried and a retried transaction must not
 * send two refunds.
 *
 * So something has to deliver them afterwards. That is this process.
 *
 * Two properties matter:
 *
 *  - **At-least-once, never lost.** An effect is only marked `confirmed` after
 *    the handler returns. A crash mid-delivery leaves it `pending`, and the next
 *    drainer picks it up.
 *  - **Safe to run many.** Rows are claimed with FOR UPDATE SKIP LOCKED, so N
 *    drainers partition the queue between themselves without coordinating and
 *    without ever handing the same effect to two workers.
 *
 *   node services/outbox/drainer.ts [--once] [--target=local|cloud]
 */
import { Db } from '../../packages/recall-core/src/index.ts';
import { loadEnv, resolveConnectionString } from '../../scripts/env.ts';

loadEnv();

const args = new Set(process.argv.slice(2));
const once = args.has('--once');
const target = [...args].find((a) => a.startsWith('--target='))?.split('=')[1] ?? 'local';

const BATCH = 10;
const POLL_MS = 1500;
const MAX_ATTEMPTS = 5;

interface OutboxRow {
  id: string;
  tenant_id: string;
  decision_id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Where a real deployment would call Stripe, SES, the reservation system, etc.
 * Kept as a simulation so the demo is self-contained and never moves real money.
 *
 * `compensate:` effects are the reversal path, enqueued by `Recall.revert()`
 * when a contaminated decision had already been delivered to the world.
 */
async function deliver(row: OutboxRow): Promise<void> {
  const reversal = row.kind.startsWith('compensate:');
  const label = reversal ? `↩ ${row.kind.slice(11)}` : row.kind;
  console.log(`  ${label}  ${JSON.stringify(row.payload)}`);

  // Simulated remote latency; a real handler would await the provider SDK here.
  await new Promise((r) => setTimeout(r, 40));
}

async function drainBatch(db: Db): Promise<number> {
  return db.inTransaction(async (c) => {
    // SKIP LOCKED lets multiple drainers share the queue without coordination:
    // each claims a disjoint set and never blocks on the others.
    const { rows } = await c.query<OutboxRow>(
      `SELECT id, tenant_id, decision_id, kind, payload, attempts
         FROM effect_outbox
        WHERE state = 'pending' AND attempts < $1
        ORDER BY created_at
        LIMIT $2
          FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, BATCH],
    );
    if (rows.length === 0) return 0;

    for (const row of rows) {
      try {
        await deliver(row);
        await c.query(
          `UPDATE effect_outbox
              SET state = 'confirmed', delivered_at = now(), attempts = attempts + 1
            WHERE tenant_id = $1 AND id = $2`,
          [row.tenant_id, row.id],
        );
      } catch (err) {
        const attempts = row.attempts + 1;
        // Give up only after MAX_ATTEMPTS; a permanently failed effect is a
        // signal that its decision needs human review, not a silent drop.
        await c.query(
          `UPDATE effect_outbox
              SET state = $3, attempts = $4, last_error = $5
            WHERE tenant_id = $1 AND id = $2`,
          [
            row.tenant_id,
            row.id,
            attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            attempts,
            (err as Error).message.slice(0, 500),
          ],
        );
      }
    }
    return rows.length;
  });
}

async function main() {
  const db = new Db({
    connectionString: resolveConnectionString(target),
    applicationName: 'recall-outbox',
  });

  console.log(`outbox drainer -> ${target}${once ? ' (single pass)' : ''}`);

  let total = 0;
  for (;;) {
    const n = await drainBatch(db).catch((e) => {
      console.error('drain failed:', (e as Error).message);
      return 0;
    });
    total += n;

    if (once && n === 0) break;
    if (n === 0) await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.log(`delivered ${total} effect(s)`);
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
