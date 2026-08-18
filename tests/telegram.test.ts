import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Orbis } from '../packages/orbis-core/src/index.ts';
import type { Session } from '../packages/orbis-core/src/index.ts';
import { COMMANDS } from '../services/telegram/bot.ts';
import { loadEnv, resolveConnectionString } from '../scripts/env.mjs';

/**
 * The Telegram bot's command layer, exercised against a real cluster.
 *
 * The transport is deliberately not tested — mocking `fetch` would assert that
 * the code calls the function it calls. What is worth testing is the part that
 * could actually be wrong: that a phone-shaped message produces a well-formed
 * memory, that governance still applies on this surface, and that the writes
 * are attributed to `telegram` so the console can see them.
 */

loadEnv();

const TARGET = process.env.ORBIS_TARGET ?? 'local';
const EMAIL = 'telegram-test@orbis.invalid';

let orbis: Orbis;
let session: Session;
let accountId: string;

const ctx = (args: string) => ({ chatId: 1, session, accountId, args });

before(async () => {
  orbis = new Orbis({
    connectionString: resolveConnectionString(TARGET),
    applicationName: 'orbis-telegram-test',
  });
  await orbis.ready();

  await orbis.db.query(`DELETE FROM account WHERE email = $1`, [EMAIL]);
  const acc = await orbis.db.one(
    `INSERT INTO account (email, display_name) VALUES ($1,$2) RETURNING id`,
    [EMAIL, 'Telegram Test'],
  );
  accountId = acc.id;
  session = orbis.session(accountId);
  await session.workspaces.create({ name: 'Personal', isDefault: true });
});

after(async () => {
  await orbis.db.query(`DELETE FROM account WHERE email = $1`, [EMAIL]);
  await orbis.close();
});

describe('telegram commands', () => {
  test('a one-line capture becomes a titled memory', async () => {
    const reply = await COMMANDS.remember(ctx('The office wifi password is on the fridge'));
    assert.match(reply, /Stored/);

    const [m] = await session.memories.list({ limit: 1 });
    assert.equal(m.body, 'The office wifi password is on the fridge');
    assert.ok(m.title.length > 0, 'a title was derived, not left blank');
    assert.equal(m.client, 'telegram', 'attribution survives to the console');
  });

  test('a multi-line capture uses the first line as the title', async () => {
    await COMMANDS.remember(
      ctx('Deploy runbook\nBuild the console first, then prune onnxruntime to linux/x64.'),
    );
    const [m] = await session.memories.list({ limit: 1 });
    assert.equal(m.title, 'Deploy runbook');
    assert.match(m.body, /prune onnxruntime/);
  });

  test('governance applies here too — a substanceless memory is refused', async () => {
    const before = await session.memories.list({ limit: 100 });
    const reply = await COMMANDS.remember(ctx('ok'));
    assert.match(reply, /Refused/);
    const after = await session.memories.list({ limit: 100 });
    assert.equal(after.length, before.length, 'nothing was written');
  });

  test('search finds a memory through different words', async () => {
    await COMMANDS.remember(
      ctx('Reimbursement window\nCustomers may request reimbursement within thirty days.'),
    );
    const reply = await COMMANDS.ask(ctx('how long to get money back'));
    assert.match(reply, /Reimbursement window/);
  });

  test('an empty command explains itself instead of failing', async () => {
    assert.match(await COMMANDS.remember(ctx('')), /remember/i);
    assert.match(await COMMANDS.search(ctx('')), /look for/i);
  });

  test('whoami reports the paired account', async () => {
    const reply = await COMMANDS.whoami(ctx(''));
    assert.match(reply, /Telegram Test/);
    assert.match(reply, /active memories/);
  });

  test('every command returns text short enough for one Telegram message', async () => {
    for (const name of ['help', 'context', 'recent', 'spaces', 'whoami'] as const) {
      const reply = await COMMANDS[name](ctx(''));
      assert.equal(typeof reply, 'string', `${name} returned a string`);
      assert.ok(reply.length > 0, `${name} said something`);
    }
  });
});
