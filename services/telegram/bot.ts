/**
 * Telegram bot.
 *
 * The point of Orbis is that memory follows you between tools. Telegram is the
 * tool you have when you are not at a computer — so this is the surface for
 * capturing something on a walk and finding it in Claude Code an hour later,
 * without the phone needing an IDE, an MCP client, or a login.
 *
 * Two design decisions worth stating:
 *
 *   Long polling, not webhooks. A webhook needs a public HTTPS endpoint and a
 *   registration step, which makes it impossible to run from a laptop and
 *   awkward to demo. `getUpdates` with a long timeout costs one idle
 *   connection and works identically behind NAT, in Docker, and on Lambda's
 *   sibling process. The trade is that it is one process rather than many.
 *
 *   Pairing by token, not by phone number. A Telegram chat id proves nothing
 *   about who the user is, so a chat is inert until someone pastes an Orbis API
 *   token into it. That maps the chat to an account through the same
 *   `api_token` table every other client authenticates against, gets revocation
 *   for free, and means the bot has no privileged path of its own.
 *
 * Run it with:
 *   TELEGRAM_BOT_TOKEN=... node services/telegram/bot.ts
 */

import { Orbis } from '../../packages/orbis-core/src/index.ts';
import type { Session } from '../../packages/orbis-core/src/index.ts';
import { logToolCall, recordConnection } from '../../packages/orbis-core/src/index.ts';
import { TOOLS_BY_NAME } from '../mcp/tools.ts';
import { loadEnv, resolveConnectionString } from '../../scripts/env.mjs';

loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const TARGET = process.env.ORBIS_TARGET ?? 'local';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/** Telegram caps a message at 4096 characters. */
const MAX_MESSAGE = 4000;

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * Chat id → account, resolved through the same token table as every other
 * client. Held in memory: a restart costs one `/start <token>` and keeping a
 * bearer token in a durable table keyed by an unauthenticated chat id is a
 * worse trade than that.
 */
const paired = new Map<number, { accountId: string; tokenId: string }>();

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface Ctx {
  chatId: number;
  session: Session;
  accountId: string;
  args: string;
}

const HELP = `*Orbis* — one memory, every agent.

/remember <text> — store something. First line becomes the title.
/search <query> — semantic search across everything you have told any agent.
/context — who Orbis thinks you are, as your other agents see it.
/recent — what has been written lately, and by which tool.
/spaces — your workspaces.
/ask <question> — search and quote the closest matches.
/whoami — which account this chat is paired to.
/help — this message.

Any message that is not a command is treated as /ask.`;

const COMMANDS: Record<string, (ctx: Ctx) => Promise<string>> = {
  async help() {
    return HELP;
  },

  async whoami({ session, accountId }) {
    const acc = await session.db.one(
      `SELECT display_name, email FROM account WHERE id = $1`,
      [accountId],
    );
    const n = await session.db.one(
      `SELECT count(*)::INT AS c FROM memory WHERE account_id = $1 AND status = 'active'`,
      [accountId],
    );
    return `Paired to *${acc?.display_name ?? 'unknown'}* (${acc?.email ?? '—'})\n${n?.c ?? 0} active memories.`;
  },

  async remember(ctx) {
    if (!ctx.args) return 'Give me something to remember: `/remember <text>`';
    // First line is the title when the message has more than one; otherwise the
    // text is both, truncated. Asking for a title on a phone would kill the
    // feature — the whole point is that capture is one gesture.
    const lines = ctx.args.split('\n');
    const title = lines.length > 1 ? lines[0].trim() : ctx.args.slice(0, 70);
    const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : ctx.args;
    return run(ctx, 'remember', { title, body, kind: 'fact' });
  },

  async search(ctx) {
    if (!ctx.args) return 'What should I look for? `/search <query>`';
    return run(ctx, 'search_memory', { query: ctx.args, limit: 5, tight: true });
  },

  async ask(ctx) {
    if (!ctx.args) return 'Ask me something about what you have stored.';
    return run(ctx, 'search_memory', { query: ctx.args, limit: 5, tight: true });
  },

  async context(ctx) {
    return run(ctx, 'get_context', {});
  },

  async recent(ctx) {
    return run(ctx, 'timeline', { limit: 12 });
  },

  async spaces(ctx) {
    return run(ctx, 'list_workspaces', {});
  },
};

/**
 * Every command goes through the MCP tool layer rather than the store.
 *
 * That is the whole architecture in one function: the bot gets exactly the
 * capabilities an external agent has, inherits the same refusals, and logs to
 * the same table — so a memory captured from a phone is provably the same kind
 * of object as one written by Claude Code, not a parallel path that happens to
 * write similar rows.
 */
async function run(ctx: Ctx, toolName: string, args: Record<string, unknown>): Promise<string> {
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) return `Internal error: no tool named ${toolName}.`;

  const started = Date.now();
  try {
    const r = await tool.handler(ctx.session, args, { client: 'telegram', surface: 'mcp' });
    logToolCall(ctx.session.db, {
      accountId: ctx.accountId,
      client: 'telegram',
      surface: 'mcp',
      tool: toolName,
      ok: !r.isError,
      latencyMs: Date.now() - started,
      resultCount: r.count,
    });
    return r.text;
  } catch (err) {
    const message = (err as Error).message;
    logToolCall(ctx.session.db, {
      accountId: ctx.accountId,
      client: 'telegram',
      surface: 'mcp',
      tool: toolName,
      ok: false,
      latencyMs: Date.now() - started,
      error: message,
    });
    return `That failed: ${message}`;
  }
}

// ---------------------------------------------------------------------------
// Telegram transport
// ---------------------------------------------------------------------------

async function call(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  return json.result;
}

/**
 * Telegram's MarkdownV2 escapes eighteen characters and rejects the whole
 * message on one mistake, which turns every memory containing an underscore
 * into a delivery failure. Legacy `Markdown` understands the `*bold*` and
 * `_italic_` the tool layer already emits and is far more forgiving, so the
 * only real hazard left is an unbalanced marker — hence the balance check.
 */
function send(chatId: number, text: string): Promise<unknown> {
  const body = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}\n\n…truncated.` : text;
  const balanced = (c: string) => (body.split(c).length - 1) % 2 === 0;
  const safe = balanced('*') && balanced('_') && balanced('`');

  return call('sendMessage', {
    chat_id: chatId,
    text: body,
    ...(safe ? { parse_mode: 'Markdown' } : {}),
    disable_web_page_preview: true,
  }).catch(() =>
    // One retry as plain text. A formatting rejection must never cost the user
    // their answer.
    call('sendMessage', { chat_id: chatId, text: body, disable_web_page_preview: true }),
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function handle(orbis: Orbis, update: any): Promise<void> {
  const message = update.message ?? update.edited_message;
  const text: string | undefined = message?.text;
  if (!message?.chat?.id || !text) return;

  const chatId: number = message.chat.id;
  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  // Group chats address commands as /search@OrbisBot.
  const command = rawCommand.startsWith('/')
    ? rawCommand.slice(1).split('@')[0].toLowerCase()
    : null;
  const args = rest.join(' ').trim();

  // ---- pairing -----------------------------------------------------------
  if (command === 'start') {
    if (!args) {
      await send(
        chatId,
        'Welcome to *Orbis*.\n\nTo link this chat to your memory, create a token in the ' +
          'console (Setup → Access tokens) and send:\n\n`/start <your token>`\n\n' +
          'Nothing is readable or writable until you do.',
      );
      return;
    }
    const resolved = await orbis.tokens.resolve(args);
    if (!resolved) {
      await send(chatId, 'That token is not valid or has been revoked. Try another.');
      return;
    }
    paired.set(chatId, { accountId: resolved.accountId, tokenId: resolved.tokenId });
    // Register through the same helper every MCP client uses, so the bot shows
    // up in the Setup tab's connected-clients list alongside Claude Code and
    // Codex rather than being invisible to the console.
    await recordConnection(orbis.db, resolved.accountId, {
      name: 'telegram',
      version: '1.0',
      protocol: 'mcp-tools',
      transport: 'long-poll',
    }).catch(() => {});
    await send(chatId, `Linked. ${HELP}`);
    return;
  }

  const link = paired.get(chatId);
  if (!link) {
    await send(
      chatId,
      'This chat is not linked to an Orbis account yet. Send `/start <token>` — ' +
        'you can make a token in the console under Setup → Access tokens.',
    );
    return;
  }

  const ctx: Ctx = {
    chatId,
    session: orbis.session(link.accountId),
    accountId: link.accountId,
    args: command ? args : text.trim(),
  };

  // Typing indicator: a semantic search plus an embed is a second or two, and
  // silence for that long reads as a dead bot.
  void call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  const handler = command ? COMMANDS[command] : COMMANDS.ask;
  if (!handler) {
    await send(chatId, `No such command: /${command}\n\n${HELP}`);
    return;
  }

  try {
    await send(chatId, await handler(ctx));
  } catch (err) {
    await send(chatId, `Something went wrong: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Long-poll loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!BOT_TOKEN) {
    console.error(
      'TELEGRAM_BOT_TOKEN is not set.\n\n' +
        'Get one from @BotFather on Telegram, then:\n' +
        '  TELEGRAM_BOT_TOKEN=... npm run telegram',
    );
    process.exit(1);
  }

  const orbis = new Orbis({
    connectionString: resolveConnectionString(TARGET),
    applicationName: 'orbis-telegram',
    embedder: {
      preferred: process.env.ORBIS_EMBEDDER,
      awsRegion: process.env.AWS_REGION,
      bedrockModel: process.env.BEDROCK_EMBED_MODEL,
    },
  });

  const choice = await orbis.ready();
  const me = await call('getMe', {});

  console.log(`[telegram] @${me.username} connected`);
  console.log(`[telegram] target=${TARGET} embedder=${choice.provider.id}`);

  // Register the command list so Telegram shows a menu instead of making the
  // user remember the verbs.
  await call('setMyCommands', {
    commands: [
      { command: 'remember', description: 'Store something worth keeping' },
      { command: 'ask', description: 'Ask about anything you have stored' },
      { command: 'search', description: 'Semantic search across your memory' },
      { command: 'context', description: 'What your agents know about you' },
      { command: 'recent', description: 'What was written lately' },
      { command: 'spaces', description: 'List your workspaces' },
      { command: 'help', description: 'Show all commands' },
    ],
  }).catch(() => {});

  let offset = 0;
  let backoff = 1000;

  for (;;) {
    try {
      const updates = await call('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'edited_message'],
      });
      backoff = 1000;
      for (const u of updates) {
        offset = u.update_id + 1;
        // One slow handler must not stall the queue behind it.
        void handle(orbis, u).catch((err) =>
          console.error('[telegram] handler failed:', (err as Error).message),
        );
      }
    } catch (err) {
      // A network blip or a Telegram 5xx should not end the process. Back off
      // to a minute so an outage does not become a request flood.
      console.error(`[telegram] poll failed: ${(err as Error).message}; retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isEntry) {
  main().catch((err) => {
    console.error('[telegram] fatal:', err);
    process.exit(1);
  });
}

export { handle, COMMANDS, HELP };
