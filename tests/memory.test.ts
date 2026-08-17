import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Orbis } from '../packages/orbis-core/src/index.ts';
import type { Session } from '../packages/orbis-core/src/index.ts';
import { loadEnv, resolveConnectionString } from '../scripts/env.mjs';

/**
 * Tests run against a real CockroachDB cluster, never a mock.
 *
 * Every interesting property here — that a retracted memory disappears from
 * recall, that the vector index is actually chosen, that a correction
 * propagates through a recursive walk — is a property of the database, not of
 * the TypeScript. A mock would assert that the code calls the functions it
 * calls, which is not the thing that has ever broken.
 *
 *   npm test                       against the local Docker cluster
 *   ORBIS_TARGET=cloud npm test    against CockroachDB Cloud
 *
 * The suite honours ORBIS_TARGET because a bug found late in the last build
 * only appeared at Cloud latency: a retry budget tuned against a 1ms localhost
 * round trip exhausted itself at 40ms and surfaced an error to the caller.
 * Testing only against localhost hid a production bug.
 */

loadEnv();

const TARGET = process.env.ORBIS_TARGET ?? 'local';
const EMAIL = 'test@orbis.invalid';

let orbis: Orbis;
let session: Session;
let accountId: string;
let workspaceId: string;

before(async () => {
  orbis = new Orbis({
    connectionString: resolveConnectionString(TARGET),
    applicationName: 'orbis-test',
    embedder: { preferred: process.env.ORBIS_EMBEDDER ?? 'local' },
  });
  await orbis.ready();

  const acct = await orbis.db.one(
    `INSERT INTO account (email, display_name) VALUES ($1,'Test')
     ON CONFLICT (email) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
    [EMAIL],
  );
  accountId = acct!.id;
  session = orbis.session(accountId);

  // Start from a clean slate so a previous run cannot make a test pass.
  await orbis.db.query(`DELETE FROM memory WHERE account_id = $1`, [accountId]);

  const ws = await session.workspaces.create({ name: 'Test', slug: 'test', isDefault: true });
  workspaceId = ws.id;
});

after(async () => {
  await orbis.db.query(`DELETE FROM account WHERE email = $1`, [EMAIL]);
  await orbis.close();
});

// ---------------------------------------------------------------------------

describe('storing and recalling', () => {
  test('a memory can be stored and found by meaning rather than by words', async () => {
    await session.memories.remember({
      title: 'Refund window',
      body: 'Customers may request reimbursement within thirty days of purchase.',
      kind: 'fact',
      workspaceId,
      client: 'test',
    }, { dedupe: false });

    // Deliberately shares no significant vocabulary with the stored text.
    const hits = await session.memories.search({
      query: 'how long do people have to get their money back',
      workspaceId,
      limit: 5,
    });

    assert.ok(hits.length > 0, 'expected at least one hit');
    assert.equal(hits[0].title, 'Refund window');
  });

  test('a restated memory reinforces rather than duplicating', async () => {
    const first = await session.memories.remember({
      title: 'Indentation', body: 'Two-space indentation everywhere. Tabs are a hard no.',
      kind: 'preference', workspaceId, client: 'test',
    });
    const second = await session.memories.remember({
      title: 'Whitespace', body: 'Always two spaces for indentation, never tab characters.',
      kind: 'preference', workspaceId, client: 'test',
    });

    assert.equal(second.reinforced, true, 'a restatement should merge');
    assert.equal(second.memory.id, first.memory.id, 'should be the same row');
    assert.ok(second.memory.evidenceCount > first.memory.evidenceCount);
    assert.ok(
      second.memory.confidence > first.memory.confidence,
      'a second observation should raise confidence',
    );
  });

  test('a genuinely different memory is not merged', async () => {
    const r = await session.memories.remember({
      title: 'Editor', body: 'Uses Neovim with a tmux split for the test runner.',
      kind: 'preference', workspaceId, client: 'test',
    });
    assert.equal(r.reinforced, false, 'distinct memories must stay distinct');
  });

  test('confidence approaches 1 without ever reaching it', async () => {
    const r = await session.memories.remember({
      title: 'Repeated', body: 'A thing observed over and over again in many sessions.',
      kind: 'fact', workspaceId, client: 'test',
    }, { dedupe: false });

    let m = r.memory;
    for (let i = 0; i < 25; i++) m = await session.memories.reinforce(m.id);

    assert.ok(m.confidence < 1, 'confidence must never reach certainty');
    assert.ok(m.confidence > 0.95, 'but should be high after 25 observations');
  });
});

// ---------------------------------------------------------------------------

describe('correction', () => {
  test('a retracted memory never surfaces in recall again', async () => {
    const r = await session.memories.remember({
      title: 'Deploy target', body: 'The service is deployed to Heroku every Friday.',
      kind: 'fact', workspaceId, client: 'test',
    }, { dedupe: false });

    const before = await session.memories.search({ query: 'where is the service deployed', workspaceId, limit: 5 });
    assert.ok(before.some((h) => h.id === r.memory.id), 'should be findable first');

    await session.memories.correct(r.memory.id, { reason: 'moved to AWS' });

    const after = await session.memories.search({ query: 'where is the service deployed', workspaceId, limit: 10 });
    assert.ok(!after.some((h) => h.id === r.memory.id), 'must not resurface after retraction');
  });

  test('retraction preserves history rather than deleting', async () => {
    const r = await session.memories.remember({
      title: 'Old policy', body: 'Support tickets were routed through Zendesk until last year.',
      kind: 'fact', workspaceId, client: 'test',
    }, { dedupe: false });

    await session.memories.correct(r.memory.id, { reason: 'superseded' });
    const fetched = await session.memories.get(r.memory.id);

    assert.ok(fetched, 'the row must still exist');
    assert.equal(fetched!.status, 'retracted');
    assert.ok(fetched!.validTo, 'valid_to should be stamped');
  });

  test('a replacement is linked to what it replaced', async () => {
    const r = await session.memories.remember({
      title: 'Language', body: 'All new services are written in Go.',
      kind: 'decision', workspaceId, client: 'test',
    }, { dedupe: false });

    const result = await session.memories.correct(r.memory.id, {
      reason: 'changed',
      replacement: {
        title: 'Language', body: 'All new services are written in Rust as of this quarter.',
        kind: 'decision', workspaceId, client: 'test',
      },
    });

    assert.ok(result.replacement, 'a replacement should be created');
    assert.equal(result.retracted.supersededBy, result.replacement!.id);
  });
});

// ---------------------------------------------------------------------------

describe('correction propagation', () => {
  test('finds everything derived from a memory, transitively', async () => {
    const root = await session.memories.remember({
      title: 'Base fact', body: 'The billing service owns all invoice generation logic.',
      kind: 'fact', workspaceId, client: 'test',
    }, { dedupe: false });

    const one = await session.memories.remember({
      title: 'First inference', body: 'Because billing owns invoices, invoice bugs are a billing team concern.',
      kind: 'insight', workspaceId, client: 'test', derivedFrom: [root.memory.id],
    }, { dedupe: false });

    const two = await session.memories.remember({
      title: 'Second inference', body: 'Since invoice bugs belong to billing, route invoice escalations there.',
      kind: 'insight', workspaceId, client: 'test', derivedFrom: [one.memory.id],
    }, { dedupe: false });

    const fallout = await session.memories.fallout(root.memory.id);
    const ids = fallout.memories.map((m) => m.id);

    assert.ok(ids.includes(one.memory.id), 'one hop should be found');
    assert.ok(ids.includes(two.memory.id), 'two hops should be found');
    assert.equal(fallout.memories.find((m) => m.id === one.memory.id)!.hops, 1);
    assert.equal(fallout.memories.find((m) => m.id === two.memory.id)!.hops, 2);
  });

  test('a memory reachable by two paths is reported once, at its shortest depth', async () => {
    const root = await session.memories.remember({
      title: 'Shared root', body: 'Deployments happen on Tuesday afternoons in the release window.',
      kind: 'fact', workspaceId, client: 'test',
    }, { dedupe: false });

    const mid = await session.memories.remember({
      title: 'Middle', body: 'Tuesday deploys mean Monday is the last day to merge anything risky.',
      kind: 'insight', workspaceId, client: 'test', derivedFrom: [root.memory.id],
    }, { dedupe: false });

    // Derived from BOTH the root and the intermediate, so it is reachable at
    // depth 1 and depth 2. Without min(hops) grouping it appears twice.
    const both = await session.memories.remember({
      title: 'Reachable twice', body: 'Freeze risky merges on Monday and keep Tuesday for the release itself.',
      kind: 'insight', workspaceId, client: 'test',
      derivedFrom: [root.memory.id, mid.memory.id],
    }, { dedupe: false });

    const fallout = await session.memories.fallout(root.memory.id);
    const appearances = fallout.memories.filter((m) => m.id === both.memory.id);

    assert.equal(appearances.length, 1, 'must not be double-counted');
    assert.equal(appearances[0].hops, 1, 'should report the shortest path');
  });

  test('a cycle terminates instead of recursing forever', async () => {
    const a = await session.memories.remember({
      title: 'Cycle A', body: 'The scheduler depends on the queue service being healthy.',
      kind: 'fact', workspaceId, client: 'test',
    }, { dedupe: false });
    const b = await session.memories.remember({
      title: 'Cycle B', body: 'The queue service depends on the scheduler to drain backlogs.',
      kind: 'fact', workspaceId, client: 'test', derivedFrom: [a.memory.id],
    }, { dedupe: false });

    // Close the loop by hand — nothing in the API creates a cycle, but a graph
    // that cannot survive one is a graph waiting to hang a request thread.
    await orbis.db.query(
      `INSERT INTO memory_source (memory_id, source_id, account_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [a.memory.id, b.memory.id, accountId],
    );

    const fallout = await session.memories.fallout(a.memory.id);
    assert.ok(fallout.tookMs < 5000, 'must terminate promptly');
    assert.ok(fallout.memories.length >= 1);
  });
});

// ---------------------------------------------------------------------------

describe('the vector index', () => {
  /**
   * Plan tests need volume.
   *
   * CockroachDB correctly prefers a scan on a table of twenty rows — reading
   * them all is cheaper than descending an index — so a plan captured against
   * the handful of rows the other tests create proves nothing either way. This
   * pads the table past the point where the vector index wins and runs ANALYZE,
   * because without statistics the optimizer has no basis to choose it.
   *
   * The padding rows share one embedding. Vector diversity would matter for
   * recall quality; it does not affect which access path gets planned, and
   * generating 600 distinct embeddings would add ten seconds to every run.
   */
  before(async () => {
    const [vec] = await orbis.embedder.embed(['padding row for plan tests']);
    const literal = `[${vec.join(',')}]`;
    const rows: string[] = [];
    const params: unknown[] = [accountId, workspaceId, literal];
    for (let i = 0; i < 600; i++) {
      params.push(`Padding ${i}`);
      rows.push(`($1,$2,'fact',$${params.length},'volume for plan tests',$3::VECTOR,'test','import')`);
    }
    await orbis.db.query(
      `INSERT INTO memory (account_id, workspace_id, kind, title, body, embedding, client, source)
       VALUES ${rows.join(',')}`,
      params,
    );
    await orbis.db.query('ANALYZE memory');
  });

  test('is chosen for a workspace-scoped search', async () => {
    const [vec] = await orbis.embedder.embed(['a representative query']);
    const plan = await orbis.db.query(
      `EXPLAIN SELECT m.id FROM memory m
        WHERE m.account_id = $2 AND m.status = 'active' AND m.workspace_id = $3
        ORDER BY m.embedding <=> $1::VECTOR LIMIT 10`,
      [`[${vec.join(',')}]`, accountId, workspaceId],
    );
    const text = plan.map((r) => String(Object.values(r)[0])).join('\n');
    assert.match(text, /vector search/i, `expected a vector search in:\n${text}`);
  });

  test('is chosen for a global search too', async () => {
    const [vec] = await orbis.embedder.embed(['a representative query']);
    const plan = await orbis.db.query(
      `EXPLAIN SELECT m.id FROM memory m
        WHERE m.account_id = $2 AND m.status = 'active'
        ORDER BY m.embedding <=> $1::VECTOR LIMIT 10`,
      [`[${vec.join(',')}]`, accountId],
    );
    const text = plan.map((r) => String(Object.values(r)[0])).join('\n');
    assert.match(text, /vector search/i, `expected a vector search in:\n${text}`);
  });

  test('an IS NOT NULL predicate disqualifies it — the regression this guards', async () => {
    const [vec] = await orbis.embedder.embed(['a representative query']);
    const plan = await orbis.db.query(
      `EXPLAIN SELECT m.id FROM memory m
        WHERE m.account_id = $2 AND m.status = 'active' AND m.workspace_id = $3
          AND m.embedding IS NOT NULL
        ORDER BY m.embedding <=> $1::VECTOR LIMIT 10`,
      [`[${vec.join(',')}]`, accountId, workspaceId],
    );
    const text = plan.map((r) => String(Object.values(r)[0])).join('\n');
    // Asserting the *failure* documents why the production query omits the
    // filter. If CockroachDB ever fixes this, the test fails and tells us.
    assert.doesNotMatch(
      text, /vector search/i,
      'CockroachDB now handles IS NOT NULL with vector indexes — the workaround can be removed',
    );
  });
});

// ---------------------------------------------------------------------------

describe('entity extraction', () => {
  test('pulls entities out of a memory and links them', async () => {
    const r = await session.memories.remember({
      title: 'Stack note',
      body: 'The console is React and Vite, talking to CockroachDB through `pg`, deployed on AWS.',
      kind: 'fact', workspaceId, client: 'test',
    }, { dedupe: false });

    const entities = await session.graph.indexMemory(
      r.memory.id, `${r.memory.title}\n\n${r.memory.body}`,
    );
    const names = entities.map((e) => e.canonical);

    assert.ok(names.includes('cockroachdb'), `expected cockroachdb in ${names.join(', ')}`);
    assert.ok(names.includes('react'), `expected react in ${names.join(', ')}`);
  });

  test('does not treat a sentence-initial word as a proper noun', async () => {
    const r = await session.memories.remember({
      title: 'Prose', body: 'The service restarts nightly. This keeps memory usage predictable.',
      kind: 'fact', workspaceId, client: 'test',
    }, { dedupe: false });

    const entities = await session.graph.indexMemory(r.memory.id, r.memory.body);
    const names = entities.map((e) => e.canonical);

    assert.ok(!names.includes('the'), 'The should not become an entity');
    assert.ok(!names.includes('this'), 'This should not become an entity');
  });
});

// ---------------------------------------------------------------------------

describe('context assembly', () => {
  test('renders preferences and background for a model', async () => {
    await session.memories.remember({
      title: 'Review style', body: 'Prefers small pull requests under four hundred lines.',
      kind: 'preference', workspaceId, client: 'test', confidence: 0.9,
    }, { dedupe: false });

    const ctx = await session.context.build({ workspace: 'test' });
    const rendered = session.context.render(ctx);

    assert.match(rendered, /How they like to work/);
    assert.match(rendered, /pull requests/i);
    assert.ok(rendered.length > 200, 'context should be substantial');
  });

  test('never includes a retracted memory', async () => {
    const r = await session.memories.remember({
      title: 'Wrong preference', body: 'Wants every function documented with a full JSDoc block.',
      kind: 'preference', workspaceId, client: 'test', confidence: 0.9,
    }, { dedupe: false });

    await session.memories.correct(r.memory.id, { reason: 'never true' });

    const ctx = await session.context.build({ workspace: 'test' });
    const rendered = session.context.render(ctx);
    assert.doesNotMatch(rendered, /full JSDoc block/);
  });
});
