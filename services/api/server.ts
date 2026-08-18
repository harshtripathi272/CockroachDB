import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Orbis } from '../../packages/orbis-core/src/index.ts';
import { logToolCall } from '../../packages/orbis-core/src/index.ts';
import { createMcpHandler } from '../mcp/http.ts';
import { TOOLS, TOOLS_BY_NAME } from '../mcp/tools.ts';
import { loadEnv, resolveConnectionString } from '../../scripts/env.mjs';
import { runAgent } from '../agent/loop.ts';
import { selectChatProviders, allModels } from '../agent/providers.ts';
import type { Turn } from '../agent/providers.ts';

/**
 * The Orbis server.
 *
 * Plain node:http rather than a framework, for two reasons: it stays trivially
 * wrappable for a serverless handler, and the routing here is simple enough
 * that a router would be more code than it saves.
 *
 * Three surfaces share one process:
 *   /api/mcp        the universal MCP endpoint every agent connects to
 *   /api/v1         REST, bearer-authenticated, for scripts and integrations
 *   /api/console    what the web console talks to
 */

loadEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT ?? 8787);
export const TARGET = process.env.ORBIS_TARGET ?? 'local';
const CONSOLE_DIST = join(ROOT, 'apps', 'console', 'dist');

export const orbis = new Orbis({
  connectionString: resolveConnectionString(TARGET),
  applicationName: 'orbis-api',
  embedder: {
    preferred: process.env.ORBIS_EMBEDDER,
    awsRegion: process.env.AWS_REGION,
    bedrockModel: process.env.BEDROCK_EMBED_MODEL,
  },
});

export const choice = await orbis.ready();

/**
 * A development account so the console is usable without a login flow.
 *
 * Deliberately gated on ORBIS_DEV: it bypasses token auth entirely, which is
 * correct for a local cluster on a laptop and would be a severe hole anywhere
 * else. Production requires a real bearer token on every request.
 */
const DEV = process.env.ORBIS_DEV !== '0';
let devAccountId: string | null = null;

if (DEV) {
  const row = await orbis.db.one(
    `INSERT INTO account (email, display_name) VALUES ($1,$2)
     ON CONFLICT (email) DO UPDATE SET display_name = excluded.display_name
     RETURNING id`,
    [process.env.ORBIS_DEV_EMAIL ?? 'you@orbis.local', process.env.ORBIS_DEV_NAME ?? 'You'],
  );
  devAccountId = row!.id;
  await orbis.db.query(
    `INSERT INTO workspace (account_id, slug, name, description, is_default)
     VALUES ($1,'personal','Personal','Everything without a home yet.',true)
     ON CONFLICT (account_id, slug) DO NOTHING`,
    [devAccountId],
  );
}

const mcp = createMcpHandler({
  orbis,
  allowedOrigins: (process.env.ORBIS_ALLOWED_ORIGINS ?? '*').split(','),
  devAccountId: null, // the MCP endpoint always requires a real token
});

// ---------------------------------------------------------------------------
// The shared request handler. Used by the local listener and by lambda.ts, so
// the deployed function executes the exact same routing as local development.
// ---------------------------------------------------------------------------

export async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    // -------------------------------------------------------------- MCP
    if (path === '/api/mcp' || path.startsWith('/api/mcp/')) {
      return await mcp(req, res, url);
    }

    // ----------------------------------------------------------- health
    if (path === '/api/health') {
      const health = await orbis.db.health();
      return json(res, health.ok ? 200 : 503, {
        ok: health.ok,
        latencyMs: health.latencyMs,
        target: TARGET,
        embedder: {
          id: choice.provider.id,
          label: choice.provider.label,
          semantic: choice.provider.semantic,
          reason: choice.reason,
          rejected: choice.rejected,
        },
        version: '1.0.0',
      });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors());
      return void res.end();
    }

    // ------------------------------------------------------------- REST
    if (path.startsWith('/api/v1/')) return await restApi(req, res, url);

    // ---------------------------------------------------------- console
    if (path.startsWith('/api/console/')) return await consoleApi(req, res, url);

    // ------------------------------------------------------- static UI
    return await serveStatic(req, res, path);
  } catch (err) {
    console.error(`[${req.method} ${path}]`, err);
    return json(res, 500, { error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// REST — bearer authenticated, for scripts and integrations
// ---------------------------------------------------------------------------

async function restApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return json(res, 401, { error: 'Authorization: Bearer <token> required' });

  const resolved = await orbis.sessionForToken(token);
  if (!resolved) return json(res, 401, { error: 'invalid token' });

  const { session, identity } = resolved;
  const route = url.pathname.replace('/api/v1', '');
  const started = Date.now();

  // /memories — the shape innernet's REST API uses, for familiarity.
  if (route === '/memories' && req.method === 'POST') {
    const b = await body(req);
    const tool = TOOLS_BY_NAME.get('remember')!;
    const r = await tool.handler(session, b, { client: 'rest', surface: 'rest' });
    logToolCall(orbis.db, {
      accountId: identity.accountId, client: 'rest', surface: 'rest',
      tool: 'remember', ok: !r.isError, latencyMs: Date.now() - started,
    });
    return json(res, r.isError ? 400 : 201, r.structured ?? { ok: !r.isError, message: r.text });
  }

  if (route === '/memories' && req.method === 'GET') {
    const items = await session.memories.list({
      workspaceId: url.searchParams.get('workspace'),
      limit: Number(url.searchParams.get('limit') ?? 50),
    });
    return json(res, 200, { memories: items });
  }

  if (route === '/search') {
    const q = url.searchParams.get('q') ?? '';
    if (!q) return json(res, 400, { error: 'q is required' });
    const hits = await session.memories.search({
      query: q,
      workspaceId: url.searchParams.get('workspace'),
      limit: Number(url.searchParams.get('limit') ?? 10),
    });
    logToolCall(orbis.db, {
      accountId: identity.accountId, client: 'rest', surface: 'rest',
      tool: 'search', latencyMs: Date.now() - started, resultCount: hits.length,
    });
    return json(res, 200, { results: hits });
  }

  if (route === '/context') {
    const ctx = await session.context.build({ workspace: url.searchParams.get('workspace') });
    return json(res, 200, {
      markdown: session.context.render(ctx),
      context: ctx,
    });
  }

  if (route === '/workspaces') return json(res, 200, { workspaces: await session.workspaces.list() });

  return json(res, 404, { error: `no such route: ${route}` });
}

// ---------------------------------------------------------------------------
// Console API
// ---------------------------------------------------------------------------

async function consoleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const accountId = await consoleAccount(req);
  if (!accountId) return json(res, 401, { error: 'not authenticated' });

  const session = orbis.session(accountId);
  const route = url.pathname.replace('/api/console', '');
  const q = url.searchParams;

  // ------------------------------------------------------------- bootstrap
  if (route === '/bootstrap') {
    const [account, workspaces, connections, counts] = await Promise.all([
      orbis.db.one(`SELECT display_name, email, traits, created_at FROM account WHERE id = $1`, [accountId]),
      session.workspaces.list(),
      orbis.db.query(
        `SELECT client_name, client_version, protocol, transport, first_seen, last_seen, call_count
           FROM client_connection WHERE account_id = $1 ORDER BY last_seen DESC`,
        [accountId],
      ),
      orbis.db.one(
        `SELECT
           (SELECT count(*) FROM memory WHERE account_id = $1 AND status = 'active')::INT AS memories,
           (SELECT count(*) FROM entity WHERE account_id = $1)::INT AS entities,
           (SELECT count(*) FROM wiki_page WHERE account_id = $1)::INT AS pages,
           (SELECT count(*) FROM tool_call WHERE account_id = $1)::INT AS calls,
           (SELECT count(*) FROM interview_question WHERE account_id = $1 AND status = 'open')::INT AS questions`,
        [accountId],
      ),
    ]);

    return json(res, 200, {
      account,
      workspaces,
      connections,
      counts,
      embedder: {
        id: choice.provider.id,
        label: choice.provider.label,
        semantic: choice.provider.semantic,
        reason: choice.reason,
        rejected: choice.rejected,
      },
      chat: {
        models: allModels(),
        defaultModel: selectChatProviders().defaultModel,
        reason: selectChatProviders().reason,
        generative: selectChatProviders().providers.some((p) => p.generative),
      },
      target: TARGET,
      dev: DEV,
    });
  }

  // -------------------------------------------------------------- memories
  if (route === '/memories' && req.method === 'GET') {
    const items = await session.memories.list({
      workspaceId: q.get('workspace'),
      nodeId: q.get('node'),
      kind: (q.get('kind') as any) ?? undefined,
      client: q.get('client') ?? undefined,
      status: q.get('status') ?? undefined,
      limit: Number(q.get('limit') ?? 60),
      offset: Number(q.get('offset') ?? 0),
    });
    return json(res, 200, { memories: items });
  }

  if (route === '/memories' && req.method === 'POST') {
    const b = await body(req);
    const r = await session.memories.remember({
      title: b.title, body: b.body, kind: b.kind ?? 'fact',
      workspaceId: b.workspaceId ?? null, tags: b.tags ?? [],
      confidence: b.confidence ?? 0.6, source: 'api', client: 'console',
    });
    void session.graph.indexMemory(r.memory.id, `${r.memory.title}\n\n${r.memory.body}`).catch(() => {});
    return json(res, 201, r);
  }

  if (route === '/search') {
    const query = q.get('q') ?? '';
    if (!query) return json(res, 200, { results: [] });
    const started = Date.now();
    const results = await session.memories.search({
      query,
      workspaceId: q.get('workspace'),
      kind: (q.get('kind') as any) ?? undefined,
      limit: Number(q.get('limit') ?? 20),
    });
    logToolCall(orbis.db, {
      accountId, client: 'console', surface: 'console', tool: 'search',
      latencyMs: Date.now() - started, resultCount: results.length,
    });
    return json(res, 200, { results, tookMs: Date.now() - started });
  }

  const memMatch = route.match(/^\/memories\/([0-9a-f-]{36})(\/\w+)?$/i);
  if (memMatch) {
    const [, id, action] = memMatch;
    if (!action && req.method === 'GET') {
      const m = await session.memories.get(id);
      if (!m) return json(res, 404, { error: 'not found' });
      const [sources, pages] = await Promise.all([
        session.memories.sources(id),
        session.wiki.pagesCiting(id),
      ]);
      return json(res, 200, { memory: m, sources, pages });
    }
    if (action === '/trace') return json(res, 200, await session.memories.fallout(id));
    if (action === '/correct' && req.method === 'POST') {
      const b = await body(req);
      const existing = await session.memories.get(id);
      if (!existing) return json(res, 404, { error: 'not found' });
      const fallout = await session.memories.fallout(id);
      const r = await session.memories.correct(id, {
        reason: b.reason,
        replacement: b.replacement
          ? {
              title: b.replacementTitle ?? existing.title, body: b.replacement,
              kind: existing.kind, workspaceId: existing.workspaceId,
              confidence: 0.75, source: 'api', client: 'console',
            }
          : undefined,
      });
      return json(res, 200, { ...r, fallout });
    }
  }

  // ------------------------------------------------------------ workspaces
  if (route === '/workspaces' && req.method === 'GET') {
    return json(res, 200, { workspaces: await session.workspaces.list() });
  }
  if (route === '/workspaces' && req.method === 'POST') {
    return json(res, 201, await session.workspaces.create(await body(req)));
  }
  const treeMatch = route.match(/^\/workspaces\/([0-9a-f-]{36})\/tree$/i);
  if (treeMatch) return json(res, 200, { tree: await session.workspaces.tree(treeMatch[1]) });

  if (route === '/nodes' && req.method === 'POST') {
    return json(res, 201, await session.workspaces.createNode(await body(req)));
  }

  // ----------------------------------------------------------------- graph
  if (route === '/graph') {
    return json(res, 200, await session.graph.snapshot({
      workspaceId: q.get('workspace'),
      limit: Number(q.get('limit') ?? 120),
    }));
  }
  const entMatch = route.match(/^\/entities\/([0-9a-f-]{36})$/i);
  if (entMatch) return json(res, 200, await session.graph.neighbourhood(entMatch[1]));
  if (route === '/entities') {
    return json(res, 200, { entities: await session.graph.entities({ limit: Number(q.get('limit') ?? 200) }) });
  }

  // ------------------------------------------------------------------ wiki
  if (route === '/wiki') {
    return json(res, 200, { pages: await session.wiki.list({ workspaceId: q.get('workspace') }) });
  }
  const wikiMatch = route.match(/^\/wiki\/([\w-]+)$/);
  if (wikiMatch) {
    const page = await session.wiki.get(wikiMatch[1]);
    return page ? json(res, 200, page) : json(res, 404, { error: 'not found' });
  }

  // ------------------------------------------------------------- interview
  if (route === '/interview' && req.method === 'GET') {
    const rows = await orbis.db.query(
      `SELECT * FROM interview_question WHERE account_id = $1 AND status = 'open'
        ORDER BY priority DESC, created_at LIMIT 25`,
      [accountId],
    );
    return json(res, 200, { questions: rows });
  }
  const answerMatch = route.match(/^\/interview\/([0-9a-f-]{36})\/(answer|skip)$/i);
  if (answerMatch && req.method === 'POST') {
    const [, id, action] = answerMatch;
    if (action === 'skip') {
      await orbis.db.query(
        `UPDATE interview_question SET status='skipped' WHERE id=$1 AND account_id=$2`,
        [id, accountId],
      );
      return json(res, 200, { ok: true });
    }
    const b = await body(req);
    const question = await orbis.db.one(
      `SELECT * FROM interview_question WHERE id=$1 AND account_id=$2`, [id, accountId],
    );
    if (!question) return json(res, 404, { error: 'not found' });
    const r = await session.memories.remember({
      title: question.topic,
      body: b.answer,
      kind: b.kind ?? 'preference',
      workspaceId: question.workspace_id,
      source: 'interview',
      client: 'console',
      confidence: 0.8,
    });
    await orbis.db.query(
      `UPDATE interview_question SET status='answered', answered_at=now(), answer_memory=$3
        WHERE id=$1 AND account_id=$2`,
      [id, accountId, r.memory.id],
    );
    void session.graph.indexMemory(r.memory.id, `${r.memory.title}\n\n${r.memory.body}`).catch(() => {});
    return json(res, 200, { memory: r.memory });
  }

  // --------------------------------------------------------------- tokens
  if (route === '/tokens' && req.method === 'GET') {
    return json(res, 200, { tokens: await orbis.tokens.list(accountId) });
  }
  if (route === '/tokens' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 201, await orbis.tokens.create(accountId, b.name ?? 'default'));
  }
  const tokMatch = route.match(/^\/tokens\/([0-9a-f-]{36})$/i);
  if (tokMatch && req.method === 'DELETE') {
    return json(res, 200, { revoked: await orbis.tokens.revoke(accountId, tokMatch[1]) });
  }

  // ----------------------------------------------------------------- chat
  //
  // The Chat tab is one more MCP client, not a parallel feature. Every turn
  // runs the same nine tools an external agent gets, writes with
  // `client: 'orbis-chat'`, and lands in the same tool_call table — so a
  // memory created here is indistinguishable from one Claude Code wrote, and
  // the Signals tab counts it without knowing chat exists.

  if (route === '/models') {
    const { defaultModel, reason } = selectChatProviders();
    return json(res, 200, { models: allModels(), defaultModel, reason });
  }

  if (route === '/chats' && req.method === 'GET') {
    const rows = await orbis.db.query(
      `SELECT c.id, c.title, c.model, c.workspace_id, c.updated_at,
              (SELECT count(*) FROM message m WHERE m.chat_id = c.id)::INT AS messages
         FROM chat c WHERE c.account_id = $1 ORDER BY c.updated_at DESC LIMIT 50`,
      [accountId],
    );
    return json(res, 200, { chats: rows });
  }

  if (route === '/chats' && req.method === 'POST') {
    const b = await body(req);
    const row = await orbis.db.one(
      `INSERT INTO chat (account_id, workspace_id, title, model)
       VALUES ($1,$2,$3,$4) RETURNING id, title, model, workspace_id, created_at`,
      [
        accountId,
        b.workspaceId ?? null,
        b.title ?? 'New chat',
        b.model ?? selectChatProviders().defaultModel,
      ],
    );
    return json(res, 201, row);
  }

  const chatMatch = route.match(/^\/chats\/([0-9a-f-]{36})(\/messages)?$/i);
  if (chatMatch) {
    const [, chatId, isMessages] = chatMatch;
    const chat = await orbis.db.one(
      `SELECT * FROM chat WHERE id = $1 AND account_id = $2`, [chatId, accountId],
    );
    if (!chat) return json(res, 404, { error: 'no such chat' });

    if (req.method === 'GET') {
      const rows = await orbis.db.query(
        `SELECT id, role, content, tool_calls, created_at FROM message
          WHERE chat_id = $1 ORDER BY created_at`,
        [chatId],
      );
      return json(res, 200, { chat, messages: rows });
    }

    if (req.method === 'DELETE') {
      await orbis.db.query(`DELETE FROM chat WHERE id = $1 AND account_id = $2`, [chatId, accountId]);
      return json(res, 200, { ok: true });
    }

    if (isMessages && req.method === 'POST') {
      const b = await body(req);
      const text = String(b.text ?? '').trim();
      if (!text) return json(res, 400, { error: 'text is required' });

      const model = b.model ?? chat.model ?? selectChatProviders().defaultModel;

      // Replay the stored transcript. Only user and assistant text is kept —
      // tool traffic is recorded for the UI but not fed back, because the
      // provider-native blocks a replayed tool_result must reference do not
      // survive a round trip through the database. Each turn therefore starts
      // its tool use fresh, which is also what keeps a long chat's context
      // from growing without bound.
      const prior = await orbis.db.query(
        `SELECT role, content FROM message
          WHERE chat_id = $1 AND role IN ('user','assistant') ORDER BY created_at`,
        [chatId],
      );
      const history: Turn[] = prior.map((m: any) =>
        m.role === 'user'
          ? { role: 'user' as const, text: m.content }
          : { role: 'assistant' as const, text: m.content },
      );
      history.push({ role: 'user', text });

      await orbis.db.query(
        `INSERT INTO message (chat_id, account_id, role, content) VALUES ($1,$2,'user',$3)`,
        [chatId, accountId, text],
      );

      const workspace = chat.workspace_id
        ? await session.workspaces.get(chat.workspace_id)
        : await session.workspaces.getDefault();

      let result;
      try {
        result = await runAgent({
          session,
          model,
          history,
          workspaceName: workspace?.name ?? null,
          accountId,
          db: orbis.db as any,
        });
      } catch (err) {
        const message = (err as Error).message;
        await orbis.db.query(
          `INSERT INTO message (chat_id, account_id, role, content) VALUES ($1,$2,'assistant',$3)`,
          [chatId, accountId, `The model call failed: ${message}`],
        );
        return json(res, 502, { error: message });
      }

      const saved = await orbis.db.one(
        `INSERT INTO message (chat_id, account_id, role, content, tool_calls, tokens_in, tokens_out)
         VALUES ($1,$2,'assistant',$3,$4,$5,$6)
         RETURNING id, role, content, tool_calls, created_at`,
        [chatId, accountId, result.text, JSON.stringify(result.steps),
         result.usage.in, result.usage.out],
      );

      // First exchange names the chat, so the sidebar is readable without
      // making the user title anything.
      const title =
        chat.title === 'New chat'
          ? text.slice(0, 60) + (text.length > 60 ? '…' : '')
          : chat.title;
      await orbis.db.query(
        `UPDATE chat SET updated_at = now(), model = $2, title = $3 WHERE id = $1`,
        [chatId, model, title],
      );

      return json(res, 200, {
        message: saved,
        steps: result.steps,
        wrote: result.wrote,
        generative: result.generative,
        provider: result.provider,
        title,
      });
    }
  }

  // -------------------------------------------------------- observability
  if (route === '/activity') {
    const since = q.get('since') ?? '24h';
    const rows = await orbis.db.query(
      `SELECT date_trunc('hour', at) AS bucket, client, count(*)::INT AS calls,
              avg(latency_ms)::INT AS avg_ms,
              count(*) FILTER (WHERE NOT ok)::INT AS errors
         FROM tool_call
        WHERE account_id = $1 AND at > now() - $2::INTERVAL
     GROUP BY bucket, client ORDER BY bucket`,
      [accountId, since],
    );
    return json(res, 200, { buckets: rows });
  }

  if (route === '/tools') {
    const rows = await orbis.db.query(
      `SELECT tool, count(*)::INT AS calls,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::INT AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::INT AS p95,
              max(latency_ms)::INT AS max_ms,
              count(*) FILTER (WHERE NOT ok)::INT AS errors
         FROM tool_call WHERE account_id = $1 AND at > now() - INTERVAL '7 days'
     GROUP BY tool ORDER BY calls DESC`,
      [accountId],
    );
    return json(res, 200, { tools: rows });
  }

  if (route === '/calls') {
    const rows = await orbis.db.query(
      `SELECT id, client, surface, tool, ok, latency_ms, error, result_count, at
         FROM tool_call WHERE account_id = $1 ORDER BY at DESC LIMIT $2`,
      [accountId, Number(q.get('limit') ?? 60)],
    );
    return json(res, 200, { calls: rows });
  }

  if (route === '/growth') {
    const rows = await orbis.db.query(
      `SELECT date_trunc('day', created_at) AS day, kind, count(*)::INT AS n
         FROM memory WHERE account_id = $1 AND created_at > now() - INTERVAL '30 days'
     GROUP BY day, kind ORDER BY day`,
      [accountId],
    );
    return json(res, 200, { growth: rows });
  }

  if (route === '/audit') {
    const rows = await orbis.db.query(
      `SELECT id, action, target_kind, target_id, actor, detail, at
         FROM audit_log WHERE account_id = $1 ORDER BY at DESC LIMIT $2`,
      [accountId, Number(q.get('limit') ?? 100)],
    );
    return json(res, 200, { entries: rows });
  }

  // ------------------------------------------------------- CockroachDB view
  if (route === '/crdb') return json(res, 200, await crdbSnapshot(accountId));

  if (route === '/plans') {
    const [vec] = await orbis.embedder.embed([q.get('q') ?? 'example query']);
    const lit = `[${vec.join(',')}]`;
    const ws = await session.workspaces.getDefault();
    const plans: Record<string, string> = {};
    const queries: Array<[string, string, unknown[]]> = [
      ['scoped vector search',
       `SELECT m.id FROM memory m WHERE m.account_id = $2 AND m.status = 'active'
          AND m.workspace_id = $3 ORDER BY m.embedding <=> $1::VECTOR LIMIT 10`,
       [lit, accountId, ws?.id]],
      ['global vector search',
       `SELECT m.id FROM memory m WHERE m.account_id = $2 AND m.status = 'active'
         ORDER BY m.embedding <=> $1::VECTOR LIMIT 10`, [lit, accountId]],
    ];
    for (const [label, sql, params] of queries) {
      try {
        const rows = await orbis.db.query(`EXPLAIN ${sql}`, params);
        plans[label] = rows.map((r) => String(Object.values(r)[0])).join('\n');
      } catch (e) {
        plans[label] = `unavailable: ${(e as Error).message}`;
      }
    }
    return json(res, 200, { plans });
  }

  return json(res, 404, { error: `no such route: ${route}` });
}

/**
 * CockroachDB internals for the observability view.
 *
 * Every part is individually guarded. `crdb_internal` is restricted by default
 * in v26.2 and serverless clusters have no nodes to report, so a missing
 * section has to degrade to "unavailable" rather than failing the whole
 * request — the page is diagnostics, and diagnostics that vanish when something
 * is unusual are worthless.
 */
async function crdbSnapshot(accountId: string) {
  const out: Record<string, unknown> = {};

  const health = await orbis.db.health();
  out.health = health;
  out.retries = orbis.db.stats;

  try {
    const rows = await orbis.db.query(`SELECT version() AS v`);
    out.version = rows[0]?.v;
  } catch { out.version = null; }

  try {
    out.tables = await orbis.db.query(
      `SELECT table_name,
              (SELECT count(*) FROM memory WHERE account_id = $1)::INT AS rows_for_account
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'memory'`,
      [accountId],
    );
  } catch { out.tables = []; }

  try {
    out.indexes = await orbis.db.query(
      `SELECT index_name, column_name, direction
         FROM [SHOW INDEXES FROM memory] WHERE index_name LIKE '%recall%'`,
    );
  } catch { out.indexes = []; }

  try {
    out.ranges = await orbis.db.query(
      `SELECT range_id, lease_holder, replicas, start_pretty
         FROM [SHOW RANGES FROM TABLE memory WITH DETAILS] LIMIT 20`,
    );
  } catch (e) {
    out.ranges = [];
    out.rangesError = (e as Error).message.slice(0, 160);
  }

  return out;
}

// ---------------------------------------------------------------------------

/**
 * Which account the console is acting as.
 *
 * A bearer token if one is presented, otherwise the development account when
 * ORBIS_DEV is on. With dev off and no token, unauthenticated — there is no
 * third path.
 */
async function consoleAccount(req: IncomingMessage): Promise<string | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const identity = await orbis.tokens.resolve(header.slice(7).trim());
    if (identity) return identity.accountId;
  }
  return DEV ? devAccountId : null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!existsSync(CONSOLE_DIST)) {
    return html(res, 200, devPlaceholder());
  }
  const rel = path === '/' ? '/index.html' : path;
  const file = join(CONSOLE_DIST, rel);
  // Single-page app: unknown paths fall through to index.html so client-side
  // routing works on a hard refresh.
  const target = existsSync(file) && !file.endsWith('/') ? file : join(CONSOLE_DIST, 'index.html');
  try {
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    return void res.end(data);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
}

function devPlaceholder(): string {
  return `<!doctype html><meta charset="utf-8"><title>Orbis</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui;max-width:44rem;margin:6rem auto;padding:0 1.5rem;color:#111}
code{background:#f4f4f5;padding:.15em .4em;border-radius:4px}a{color:#4338ca}</style>
<h1>Orbis API is running</h1>
<p>The console has not been built yet. Run <code>npm run dev</code> for the Vite dev server,
or <code>npm run build</code> to produce a bundle this server will serve directly.</p>
<p>Endpoints: <code>/api/health</code> · <code>/api/mcp</code> · <code>/api/v1</code></p>`;
}

function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { ...cors(), 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function html(res: ServerResponse, status: number, markup: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(markup);
}

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Local listener (when run directly: `node services/api/server.ts`)
//
// Guarded so that importing this module from lambda.ts does not start a second
// server: the Lambda runtime calls handleHttp directly instead.
// ---------------------------------------------------------------------------

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  const server = createServer(handleHttp);

  server.listen(PORT, () => {
    const semantic = choice.provider.semantic ? '' : '  ⚠ NOT SEMANTIC';
    console.log(`
  Orbis  ·  ${TARGET}
  ────────────────────────────────────────────────
  console    http://localhost:${PORT}
  mcp        http://localhost:${PORT}/api/mcp
  rest       http://localhost:${PORT}/api/v1
  health     http://localhost:${PORT}/api/health

  embeddings ${choice.provider.label}${semantic}
             ${choice.reason}
  tools      ${TOOLS.filter((t) => !t.hidden).length} exposed (+2 ChatGPT aliases)
  dev auth   ${DEV ? `on — acting as ${devAccountId?.slice(0, 8)}` : 'off — bearer token required'}
`);
    for (const r of choice.rejected) console.log(`  · ${r.id} unavailable: ${r.error}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close();
      void orbis.close().then(() => process.exit(0));
    });
  }
}
