#!/usr/bin/env node
/**
 * Run the consolidation pass.
 *
 *   node services/dream/run.ts                 the dev account, local cluster
 *   node services/dream/run.ts --target=cloud
 *   node services/dream/run.ts --account=<uuid>
 *
 * Designed to be safe to run repeatedly and on a schedule: it is idempotent,
 * so a cron entry or an EventBridge rule can fire it hourly without producing
 * a different wiki each time.
 */
import { Orbis } from '../../packages/orbis-core/src/index.ts';
import { logToolCall } from '../../packages/orbis-core/src/index.ts';
import { dream } from './consolidate.ts';
import { loadEnv, resolveConnectionString } from '../../scripts/env.mjs';

loadEnv();

const arg = (name: string, fallback = '') =>
  (process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);

const target = arg('target', process.env.ORBIS_TARGET ?? 'local');
const orbis = new Orbis({
  connectionString: resolveConnectionString(target),
  applicationName: 'orbis-dream',
  embedder: {
    preferred: process.env.ORBIS_EMBEDDER,
    awsRegion: process.env.AWS_REGION,
    bedrockModel: process.env.BEDROCK_EMBED_MODEL,
  },
});

const choice = await orbis.ready();
console.log(`dream · ${target} · ${choice.provider.label}\n`);

let accountId = arg('account');
if (!accountId) {
  // The configured account first, then whichever holds the most memories.
  // Picking the oldest row is wrong the moment a test account exists, and it
  // fails quietly by consolidating the wrong person's memory.
  const row = await orbis.db.one(
    `SELECT a.id, a.email, count(m.id)::INT AS n
       FROM account a
  LEFT JOIN memory m ON m.account_id = a.id AND m.status = 'active'
      GROUP BY a.id, a.email
      ORDER BY (a.email = $1) DESC, n DESC
      LIMIT 1`,
    [process.env.ORBIS_DEV_EMAIL ?? 'you@orbis.local'],
  );
  if (!row) {
    console.error('no accounts exist — start the API once to create the dev account');
    process.exit(1);
  }
  accountId = row.id;
  console.log(`account: ${row.email} (${accountId.slice(0, 8)}) · ${row.n} memories\n`);
}

const session = orbis.session(accountId);
const started = Date.now();
const report = await dream(orbis, session, { verbose: true });

logToolCall(orbis.db, {
  accountId,
  client: 'dream',
  surface: 'dream',
  tool: 'consolidate',
  latencyMs: Date.now() - started,
  resultCount: report.questionsCreated + report.workspacePages,
});

console.log(`
  profile           ${report.profileWritten ? 'written' : 'skipped'}
  workspace pages   ${report.workspacePages}
  questions raised  ${report.questionsCreated}
  entities merged   ${report.entitiesMerged}
  prefs decayed     ${report.preferencesPromoted}
  took              ${report.tookMs}ms
`);

// The fire-and-forget tool-call insert needs a moment to land before the pool
// closes, otherwise the observability row is silently lost.
await new Promise((r) => setTimeout(r, 250));
await orbis.close();
