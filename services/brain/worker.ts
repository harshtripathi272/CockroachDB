/**
 * The brain — a long-running process that keeps memory organised.
 *
 * This is the piece the architecture was missing, and its absence was the
 * fairest criticism the project has had. Everything else runs on Lambda, which
 * only exists while a request is in flight: a memory arrived, got embedded and
 * stored, and then nothing ever looked at it again. The consolidation pass that
 * promotes preferences, merges duplicate entities, rewrites the profile and
 * works out what it still does not know about you existed the whole time — as
 * a script somebody had to run by hand. A memory system that only thinks while
 * you are watching it is a search index with extra steps.
 *
 * So this process stays up, and it wakes for two different reasons:
 *
 *   A write happened.   A CockroachDB changefeed on `memory` streams every
 *                       insert and update as it commits. That is a rangefeed,
 *                       pushed by the database — not a poll — so the brain
 *                       reacts to a new memory within seconds of it landing.
 *                       Writes are debounced per account, because an agent
 *                       saving six things in a row should cause one pass, not
 *                       six.
 *
 *   Time passed.        A full sweep on a timer, so work that is not triggered
 *                       by any particular write (fading, stale pages) still
 *                       happens, and so a missed changefeed event can never
 *                       leave an account permanently unconsolidated.
 *
 * Why a changefeed rather than polling `updated_at`: it is the difference
 * between the database telling you and you asking it repeatedly. It is also
 * the one thing here that a vector database genuinely cannot do — Pinecone has
 * no equivalent, because it has no transaction log to tail. Verified working on
 * the free tier before this was written: `kv.rangefeed.enabled` is true and
 * `EXPERIMENTAL CHANGEFEED FOR memory` streams.
 *
 * A core changefeed is a query that never returns, which is exactly why this
 * cannot live on Lambda: a 60-second execution ceiling and a frozen process
 * between invocations cannot hold one open. The request path stays serverless;
 * only the thinking moved.
 *
 * If the changefeed is unavailable for any reason, the worker degrades to
 * polling rather than stopping. Losing the elegant path should slow the brain
 * down, not switch it off.
 */

import pg from 'pg';
import { Orbis } from '../../packages/orbis-core/src/index.ts';
import { dream } from '../dream/consolidate.ts';
import { loadEnv, resolveConnectionString } from '../../scripts/env.mjs';

loadEnv();

const TARGET = process.env.ORBIS_TARGET ?? 'local';

/** Quiet period after a write before consolidating that account. */
const DEBOUNCE_MS = Number(process.env.ORBIS_BRAIN_DEBOUNCE_MS ?? 8_000);

/** Full sweep interval, regardless of traffic. */
const SWEEP_MS = Number(process.env.ORBIS_BRAIN_SWEEP_MS ?? 15 * 60_000);

/** Polling interval, used only when the changefeed is unavailable. */
const POLL_MS = Number(process.env.ORBIS_BRAIN_POLL_MS ?? 30_000);

const log = (m: string) => console.log(`[brain ${new Date().toISOString()}] ${m}`);

// ---------------------------------------------------------------------------

const orbis = new Orbis({
  connectionString: resolveConnectionString(TARGET),
  applicationName: 'orbis-brain',
  embedder: {
    preferred: process.env.ORBIS_EMBEDDER,
    awsRegion: process.env.AWS_REGION,
    bedrockModel: process.env.BEDROCK_EMBED_MODEL,
  },
});

const choice = await orbis.ready();
log(`awake · ${TARGET} · ${choice.provider.label}`);
log(`fading is ${process.env.ORBIS_DECAY === '1' ? 'ON' : 'off'}`);

/** Accounts with an unprocessed write, and the timer that will process them. */
const pending = new Map<string, NodeJS.Timeout>();
let running = false;

/**
 * Consolidate one account.
 *
 * Serialised globally: two passes over the same data at once would race on the
 * wiki pages they both rewrite, and consolidation is cheap enough that there is
 * nothing to gain from overlapping them.
 */
async function consolidate(accountId: string, why: string): Promise<void> {
  if (running) {
    // Re-arm rather than drop. The work still needs doing.
    schedule(accountId, 'deferred — another pass was running');
    return;
  }
  running = true;
  const started = Date.now();
  try {
    const session = orbis.session(accountId);
    const report = await dream(orbis, session);

    const changed =
      report.preferencesPromoted + report.entitiesMerged +
      report.workspacePages + report.questionsCreated + report.pagesRefreshed;

    log(
      `${accountId.slice(0, 8)} · ${why} · ${Date.now() - started}ms · ` +
      `${report.preferencesPromoted} promoted, ${report.entitiesMerged} merged, ` +
      `${report.workspacePages} pages, ${report.questionsCreated} questions` +
      (changed === 0 ? ' (nothing to do)' : ''),
    );

    if (process.env.ORBIS_DECAY === '1') {
      const faded = await fade(accountId);
      if (faded) log(`${accountId.slice(0, 8)} · faded ${faded} unused memories`);
    }
  } catch (err) {
    log(`consolidation failed for ${accountId.slice(0, 8)}: ${(err as Error).message}`);
  } finally {
    running = false;
  }
}

/**
 * Fading — opt-in, and deliberately gentle.
 *
 * A memory nobody has reinforced or read in a long time loses a little
 * confidence. Below a floor it stops appearing in ordinary recall, but it is
 * never deleted and an explicit search still finds it: forgetting where you put
 * something is human, having it destroyed is not. Off unless ORBIS_DECAY=1,
 * because a memory system that quietly discards things has to be asked for.
 */
async function fade(accountId: string): Promise<number> {
  const rows = await orbis.db.query(
    `UPDATE memory
        SET confidence = GREATEST(confidence - 0.02, 0.05),
            updated_at = updated_at
      WHERE account_id = $1
        AND status = 'active'
        AND kind <> 'preference'
        AND updated_at < now() - INTERVAL '30 days'
        AND confidence > 0.05
      RETURNING id`,
    [accountId],
  );
  return rows.length;
}

function schedule(accountId: string, why: string): void {
  const existing = pending.get(accountId);
  if (existing) clearTimeout(existing);
  pending.set(
    accountId,
    setTimeout(() => {
      pending.delete(accountId);
      void consolidate(accountId, why);
    }, DEBOUNCE_MS),
  );
}

/** Every account that has anything worth consolidating. */
async function allAccounts(): Promise<string[]> {
  const rows = await orbis.db.query(
    `SELECT DISTINCT account_id FROM memory WHERE status = 'active'`,
  );
  return rows.map((r) => String(r.account_id));
}

// ---------------------------------------------------------------------------
// The changefeed
// ---------------------------------------------------------------------------

/**
 * Tail `memory` and schedule the accounts that change.
 *
 * Two things about this were wrong on the first attempt and are worth keeping
 * written down, because both fail silently:
 *
 *   1. It used `pg-query-stream`, which implements streaming by declaring a
 *      cursor and FETCHing from it. A changefeed is not a cursor — it is a
 *      statement that never completes — so the feed opened, reported itself
 *      healthy, and delivered exactly zero rows. Measured: 0 in 20s with a
 *      cursor, 39 in 22s with `pg.Query`'s row events, which stream straight
 *      off the wire without buffering or declaring anything.
 *
 *   2. `key` and `value` arrive as Buffers, not strings, because the changefeed
 *      emits BYTES. `JSON.parse` on a Buffer coerces it to "[object Object]"
 *      and throws, which the catch below would have swallowed forever.
 *
 * Resolves when the feed dies so the caller can back off and reopen.
 */
function tailChangefeed(client: pg.Client): Promise<void> {
  return new Promise((resolve, reject) => {
    const q = new pg.Query(`EXPERIMENTAL CHANGEFEED FOR memory WITH resolved = '30s', initial_scan = 'no'`);
    let seen = 0;

    q.on('row', (row: { value?: Buffer | string | null }) => {
      const raw = row?.value;
      if (!raw) return; // a resolved-timestamp heartbeat carries no value
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        const after = JSON.parse(text)?.after;
        if (!after?.account_id) return; // a delete
        seen += 1;
        schedule(String(after.account_id), 'a memory changed');
      } catch { /* one unparseable row is not worth killing the feed over */ }
    });

    q.on('error', (err: Error) => reject(err));
    q.on('end', () => {
      log(`changefeed ended after ${seen} events`);
      resolve();
    });

    client.query(q);
  });
}

async function runChangefeed(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: resolveConnectionString(TARGET),
    application_name: 'orbis-brain-feed',
  });
  try {
    await client.connect();
    log('changefeed open — reacting to writes as they commit');
    await tailChangefeed(client);
    return true;
  } catch (err) {
    log(`changefeed unavailable: ${(err as Error).message.slice(0, 160)}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Polling fallback
// ---------------------------------------------------------------------------

const lastSeen = new Map<string, string>();

async function poll(): Promise<void> {
  const rows = await orbis.db.query(
    `SELECT account_id, max(updated_at) AS latest
       FROM memory WHERE status = 'active' GROUP BY account_id`,
  );
  for (const r of rows) {
    const id = String(r.account_id);
    const latest = String(r.latest);
    if (lastSeen.get(id) !== latest) {
      if (lastSeen.has(id)) schedule(id, 'a memory changed (polled)');
      lastSeen.set(id, latest);
    }
  }
}

// ---------------------------------------------------------------------------

async function sweep(): Promise<void> {
  for (const id of await allAccounts()) {
    await consolidate(id, 'scheduled sweep');
  }
}

// One pass at boot so a restart never leaves things stale, then the timer.
await sweep();
setInterval(() => void sweep().catch((e) => log(`sweep failed: ${e.message}`)), SWEEP_MS);

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    log('shutting down');
    void orbis.close().finally(() => process.exit(0));
  });
}

// The changefeed, with backoff, and polling if it will not open.
let backoff = 2_000;
let usePolling = false;

while (!shuttingDown) {
  if (!usePolling) {
    const opened = await runChangefeed();
    if (!opened) {
      log(`falling back to polling every ${POLL_MS / 1000}s`);
      usePolling = true;
      continue;
    }
    // Opened and then ended: reconnect, backing off so a flapping connection
    // does not become a hot loop.
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 60_000);
  } else {
    await poll().catch((e) => log(`poll failed: ${e.message}`));
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
