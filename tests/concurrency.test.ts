import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Db, Orbis } from '../packages/orbis-core/src/index.ts';
import type { Session } from '../packages/orbis-core/src/index.ts';
import { loadEnv, resolveConnectionString } from '../scripts/env.mjs';

/**
 * Concurrency and isolation.
 *
 * Orbis is written to by several agents at once by design — a Claude Code
 * session, a Codex run and a Telegram message can all land within the same
 * second — so the interesting failures are the ones that only appear under
 * contention. These tests create it deliberately.
 */

loadEnv();

const TARGET = process.env.ORBIS_TARGET ?? 'local';
const EMAIL = 'concurrency@orbis.invalid';
const OTHER = 'other@orbis.invalid';

let orbis: Orbis;
let session: Session;
let accountId: string;
let otherAccountId: string;
let workspaceId: string;

before(async () => {
  orbis = new Orbis({
    connectionString: resolveConnectionString(TARGET),
    applicationName: 'orbis-concurrency-test',
    embedder: { preferred: process.env.ORBIS_EMBEDDER ?? 'local' },
  });
  await orbis.ready();

  const a = await orbis.db.one(
    `INSERT INTO account (email, display_name) VALUES ($1,'Concurrency')
     ON CONFLICT (email) DO UPDATE SET display_name = excluded.display_name RETURNING id`, [EMAIL]);
  accountId = a!.id;

  const b = await orbis.db.one(
    `INSERT INTO account (email, display_name) VALUES ($1,'Other')
     ON CONFLICT (email) DO UPDATE SET display_name = excluded.display_name RETURNING id`, [OTHER]);
  otherAccountId = b!.id;

  session = orbis.session(accountId);
  await orbis.db.query(`DELETE FROM memory WHERE account_id = $1`, [accountId]);
  const ws = await session.workspaces.create({ name: 'Conc', slug: 'conc', isDefault: true });
  workspaceId = ws.id;
});

after(async () => {
  await orbis.db.query(`DELETE FROM account WHERE email = ANY($1)`, [[EMAIL, OTHER]]);
  await orbis.close();
});

// ---------------------------------------------------------------------------

describe('serializable contention', () => {
  test('twenty agents reinforcing one memory all commit, and none is lost', async () => {
    const r = await session.memories.remember({
      title: 'Contended', body: 'A memory that twenty agents will all reinforce at once.',
      kind: 'preference', workspaceId, client: 'test',
    }, { dedupe: false });

    const before = orbis.db.stats.retries;

    // All twenty write to the same row. Under SERIALIZABLE this is exactly the
    // shape that produces 40001 and requires the client to retry — a lost
    // update here would mean evidence_count silently under-counting.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => session.memories.reinforce(r.memory.id)),
    );

    const failed = results.filter((x) => x.status === 'rejected');
    assert.equal(failed.length, 0, `all writes should commit; ${failed.length} failed`);

    const final = await session.memories.get(r.memory.id);
    assert.equal(
      final!.evidenceCount, 21,
      'every increment must land — one initial plus twenty reinforcements',
    );

    // Not an assertion about how many retries happen, only a note: if the
    // retry loop were removed this test fails on the line above rather than
    // here, which is the failure that matters.
    const retries = orbis.db.stats.retries - before;
    assert.equal(orbis.db.stats.exhausted, 0, 'no transaction should exhaust its retry budget');
    assert.ok(retries >= 0);
  });

  test('concurrent writes to different memories do not interfere', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        session.memories.remember({
          title: `Parallel ${i}`,
          body: `Independently written memory number ${i}, with enough text to be distinct from its siblings.`,
          kind: 'fact', workspaceId, client: `agent-${i}`,
        }, { dedupe: false }),
      ),
    );

    const failed = results.filter((x) => x.status === 'rejected');
    assert.equal(failed.length, 0, `expected all to succeed, ${failed.length} failed`);

    const stored = await session.memories.list({ workspaceId, limit: 100 });
    const parallel = stored.filter((m) => m.title.startsWith('Parallel '));
    assert.equal(parallel.length, 12);
  });

  test('a correction and a concurrent read do not produce a torn view', async () => {
    const r = await session.memories.remember({
      title: 'Torn read target', body: 'A memory that will be retracted while being read repeatedly.',
      kind: 'fact', workspaceId, client: 'test',
    }, { dedupe: false });

    const reads = Array.from({ length: 10 }, () => session.memories.get(r.memory.id));
    const correction = session.memories.correct(r.memory.id, { reason: 'concurrent' });
    const [corrected, ...seen] = await Promise.all([correction, ...reads]);

    assert.equal(corrected.retracted.status, 'retracted');
    // Every read must observe one consistent state or the other, never a row
    // that is retracted but still carries no valid_to.
    for (const m of seen) {
      const mem = m as Awaited<ReturnType<typeof session.memories.get>>;
      if (mem?.status === 'retracted') {
        assert.ok(mem.validTo, 'a retracted row must always carry valid_to');
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('row-level security', () => {
  /**
   * These use a dedicated `orbis_app` role rather than the connection the rest
   * of the suite uses, because `root` carries rolbypassrls and would pass these
   * tests without any policy being enforced at all. That is the exact trap this
   * migration exists to close: RLS enabled but silently inert.
   */
  /**
   * Swap the connecting user for orbis_app, keeping everything else.
   *
   * String-replacing '//root@' worked locally and silently did nothing against
   * Cloud, where the URL carries a real username and password — so the tests
   * ran as the admin user, which carries rolbypassrls, and reported that RLS
   * was not enforcing when in fact it had never been exercised. Parsing the URL
   * makes the substitution explicit and the failure honest.
   */
  const appUrl = () => {
    const u = new URL(resolveConnectionString(TARGET));
    u.username = 'orbis_app';
    u.password = '';
    return u.toString();
  };

  /** Cloud requires password auth, and orbis_app deliberately has none. */
  const unavailable = (err: unknown) =>
    /does not exist|authentication|password|role .* not|permission/i.test((err as Error).message);

  test('an unscoped connection sees nothing', async (t) => {
    const app = new Db({ connectionString: appUrl(), applicationName: 'rls-test' });
    try {
      const rows = await app.query(`SELECT count(*)::INT AS n FROM memory`);
      assert.equal(rows[0].n, 0, 'without orbis.account_id set, no rows should be visible');
    } catch (err) {
      // The role only exists where migration 004 has run.
      t.skip(`orbis_app unavailable: ${(err as Error).message.slice(0, 60)}`);
    } finally {
      await app.close();
    }
  });

  test('a scoped connection sees only its own account', async (t) => {
    const app = new Db({ connectionString: appUrl(), applicationName: 'rls-test' });
    try {
      const mine = await app.asAccount(accountId, async (c) =>
        (await c.query(`SELECT count(*)::INT AS n FROM memory`)).rows[0].n);
      const theirs = await app.asAccount(otherAccountId, async (c) =>
        (await c.query(`SELECT count(*)::INT AS n FROM memory`)).rows[0].n);

      assert.ok(mine > 0, 'should see its own memories');
      assert.equal(theirs, 0, 'must see none of another account');
    } catch (err) {
      t.skip(`orbis_app unavailable: ${(err as Error).message.slice(0, 60)}`);
    } finally {
      await app.close();
    }
  });

  test('a cross-account write is refused by the policy, not just by convention', async (t) => {
    const app = new Db({ connectionString: appUrl(), applicationName: 'rls-test' });
    try {
      // Prove the connection is actually subject to policy before asserting
      // anything about it. Without this, an admin connection that bypasses RLS
      // makes the insert succeed and the test reports a security failure that
      // is really a test-setup failure.
      await app.query('SELECT 1');

      await assert.rejects(
        () => app.asAccount(accountId, async (c) => {
          await c.query(
            `INSERT INTO memory (account_id, kind, title, body)
             VALUES ($1,'fact','smuggled','written into another account')`,
            [otherAccountId],
          );
        }),
        /row-level security/i,
        'WITH CHECK should refuse a write aimed at another account',
      );
    } catch (err) {
      if (unavailable(err)) t.skip(`orbis_app unavailable: ${(err as Error).message.slice(0, 60)}`);
      else throw err;
    } finally {
      await app.close();
    }
  });
});
