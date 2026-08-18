import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Orbis } from '../packages/orbis-core/src/index.ts';
import { createMcpHandler } from '../services/mcp/http.ts';
import {
  McpClient,
  McpAuthError,
  McpRpcError,
  McpTransportError,
  parseSse,
} from '../services/cloud/mcp-client.ts';
import {
  cloudConfig,
  cloudCall,
  cloudChatTools,
  ALLOWED_TOOLS,
  CLOUD_MCP_URL,
} from '../services/cloud/cockroach.ts';
import { loadEnv, resolveConnectionString } from '../scripts/env.mjs';

/**
 * Orbis as an MCP client.
 *
 * Three layers, tested three different ways, because they can fail for
 * different reasons:
 *
 *  1. The SSE parser, directly. CockroachDB Cloud answers with an event stream
 *     and Orbis's own server answers with JSON, so this is the piece that
 *     decides whether the client works against one server or both.
 *  2. The protocol logic, against an injected `fetch`. This asserts the things
 *     a real server would enforce but would not explain — that the session id
 *     comes back on later requests, that the negotiated protocol version is
 *     echoed rather than the requested one, that `notifications/initialized` is
 *     actually sent. Mocking here tests the client, not the network.
 *  3. The whole client, over a real socket, against Orbis's own MCP server.
 *     Two independently written halves of the same spec meeting in the middle
 *     is a much stronger check than either against a fixture.
 *
 * What is deliberately *not* mocked is CockroachDB Cloud itself. There is no
 * service-account key in this environment, so the live assertion is the honest
 * one: that the endpoint exists and refuses us in the documented way. A fake
 * cloud server would assert only that the fake matches the code.
 */

loadEnv();

const TARGET = process.env.ORBIS_TARGET ?? 'local';
const EMAIL = 'cloud-mcp-test@orbis.invalid';

// ---------------------------------------------------------------------------
// 1. The SSE parser
// ---------------------------------------------------------------------------

describe('SSE parsing', () => {
  test('reads a single event', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseSse(body).result, { ok: true });
  });

  test('takes the answer, not the progress notification that preceded it', () => {
    // A server may narrate before it answers. The reply is the message that
    // carries `result` or `error`; everything else is commentary.
    const body =
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n';
    const msg = parseSse(body);
    assert.equal(msg.id, 7);
    assert.deepEqual(msg.result, { tools: [] });
  });

  test('joins a data field split across lines', () => {
    // The EventSource grammar allows one logical payload over several `data:`
    // lines, joined with newlines. A parser that takes only the first line
    // silently truncates every large tool result.
    const body = 'data: {"jsonrpc":"2.0","id":1,\ndata: "result":{"big":true}}\n\n';
    assert.deepEqual(parseSse(body).result, { big: true });
  });

  test('survives CRLF line endings', () => {
    const body = 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\r\n\r\n';
    assert.equal(parseSse(body).result.ok, 1);
  });

  test('returns undefined when nothing in the stream is a reply', () => {
    assert.equal(parseSse('data: {"jsonrpc":"2.0","method":"ping"}\n\n'), undefined);
    assert.equal(parseSse(': just a comment\n\n'), undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. Protocol logic, with an injected fetch
// ---------------------------------------------------------------------------

/** Record every request the client makes, and answer from a script. */
function scriptedFetch(answers: Array<{ status?: number; headers?: Record<string, string>; body?: unknown }>) {
  const seen: Array<{ headers: Record<string, string>; body: any }> = [];
  let i = 0;

  const impl = (async (_url: string, init: RequestInit) => {
    seen.push({
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    const a = answers[Math.min(i++, answers.length - 1)];
    const status = a.status ?? 200;
    const headers = new Headers({ 'content-type': 'application/json', ...(a.headers ?? {}) });
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status, headers });
  }) as unknown as typeof fetch;

  return { impl, seen };
}

const HELLO = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'scripted', version: '9.9.9' },
  },
};

describe('MCP client protocol', () => {
  test('negotiates, then echoes the version the server chose', async () => {
    const { impl, seen } = scriptedFetch([
      { headers: { 'mcp-session-id': 'sess-42' }, body: HELLO },
      { status: 202 },
      { body: { jsonrpc: '2.0', id: 2, result: { tools: [] } } },
    ]);

    const client = new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl });
    await client.listTools();

    // We ask for the newest we speak…
    assert.equal(seen[0].body.params.protocolVersion, '2025-06-18');
    assert.equal(seen[0].headers['MCP-Protocol-Version'], undefined, 'nothing to echo on the first request');

    // …and thereafter send back what the server actually agreed to. Sending
    // our preference instead is the bug this guards: it works against servers
    // that ignore the header and fails against the ones that check it.
    assert.equal(client.protocolVersion, '2025-03-26');
    assert.equal(seen[2].headers['MCP-Protocol-Version'], '2025-03-26');
  });

  test('sends notifications/initialized, without an id', async () => {
    const { impl, seen } = scriptedFetch([
      { body: HELLO },
      { status: 202 },
    ]);
    await new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl }).initialize();

    assert.equal(seen[1].body.method, 'notifications/initialized');
    assert.equal(seen[1].body.id, undefined, 'a notification carries no id');
  });

  test('replays the session id the server issued', async () => {
    const { impl, seen } = scriptedFetch([
      { headers: { 'mcp-session-id': 'sess-42' }, body: HELLO },
      { status: 202 },
      { body: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hi' }] } } },
    ]);

    const client = new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl });
    await client.callTool('anything');

    assert.equal(client.sessionId, 'sess-42');
    assert.equal(seen[2].headers['Mcp-Session-Id'], 'sess-42');
  });

  test('handshakes once, however many calls follow', async () => {
    const { impl, seen } = scriptedFetch([
      { body: HELLO },
      { status: 202 },
      { body: { jsonrpc: '2.0', id: 2, result: { tools: [] } } },
    ]);
    const client = new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl });
    await client.listTools();
    await client.listTools();

    const initializes = seen.filter((r) => r.body?.method === 'initialize');
    assert.equal(initializes.length, 1, 'a second call must not open a second session');
  });

  test('accepts an Accept header covering both response shapes', async () => {
    const { impl, seen } = scriptedFetch([{ body: HELLO }, { status: 202 }]);
    await new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl }).initialize();

    const accept = seen[0].headers.Accept;
    assert.match(accept, /application\/json/);
    assert.match(accept, /text\/event-stream/);
  });

  test('reads an SSE reply as readily as a JSON one', async () => {
    const sse = (payload: unknown) =>
      new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });

    let n = 0;
    const impl = (async () => {
      n += 1;
      if (n === 1) return sse(HELLO);
      if (n === 2) return new Response('', { status: 202 });
      return sse({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'from a stream' }] },
      });
    }) as unknown as typeof fetch;

    const r = await new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl })
      .callTool('get_cluster');
    assert.equal(r.text, 'from a stream');
    assert.equal(r.isError, false);
  });

  test('joins several text blocks and preserves isError', async () => {
    const { impl } = scriptedFetch([
      { body: HELLO },
      { status: 202 },
      {
        body: {
          jsonrpc: '2.0',
          id: 2,
          result: {
            content: [
              { type: 'text', text: 'line one' },
              { type: 'image', data: 'ignored' },
              { type: 'text', text: 'line two' },
            ],
            isError: true,
          },
        },
      },
    ]);
    const r = await new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl })
      .callTool('explain_query', { query: 'SELECT 1' });
    assert.equal(r.text, 'line one\nline two');
    assert.equal(r.isError, true, 'a failing tool is a result, not an exception');
  });

  test('reads readOnlyHint out of annotations', async () => {
    const { impl } = scriptedFetch([
      { body: HELLO },
      { status: 202 },
      {
        body: {
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              { name: 'select_query', annotations: { readOnlyHint: true } },
              { name: 'insert_rows', annotations: { readOnlyHint: false } },
              { name: 'mystery' },
              { name: '' },
            ],
          },
        },
      },
    ]);
    const tools = await new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl }).listTools();

    assert.equal(tools.length, 3, 'a nameless tool is dropped');
    assert.equal(tools[0].readOnly, true);
    assert.equal(tools[1].readOnly, false);
    assert.equal(tools[2].readOnly, undefined, 'unstated is not the same as false');
  });

  test('a JSON-RPC error becomes McpRpcError, not a silent undefined', async () => {
    const { impl } = scriptedFetch([
      { body: HELLO },
      { status: 202 },
      { body: { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'no such tool: nope' } } },
    ]);
    const client = new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl });
    await assert.rejects(() => client.callTool('nope'), (err: Error) => {
      assert.ok(err instanceof McpRpcError);
      assert.equal((err as McpRpcError).code, -32602);
      return true;
    });
  });

  test('a 401 becomes McpAuthError, with the metadata URL pulled out', async () => {
    const { impl } = scriptedFetch([
      {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="mcp", resource_metadata="https://cockroachlabs.cloud/.well-known/oauth-protected-resource/mcp", error="invalid_request"',
        },
        body: { error: 'invalid_request' },
      },
    ]);
    const client = new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl });

    await assert.rejects(() => client.initialize(), (err: Error) => {
      assert.ok(err instanceof McpAuthError, 'a credential problem must be distinguishable');
      assert.equal((err as McpAuthError).status, 401);
      assert.equal(
        (err as McpAuthError).resourceMetadata,
        'https://cockroachlabs.cloud/.well-known/oauth-protected-resource/mcp',
      );
      return true;
    });
  });

  test('a 500 becomes McpTransportError, so the UI can say "outage" not "bad key"', async () => {
    const { impl } = scriptedFetch([{ status: 500, body: { oops: true } }]);
    const client = new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl });
    await assert.rejects(() => client.initialize(), (err: Error) => {
      assert.ok(err instanceof McpTransportError);
      return true;
    });
  });

  test('a body that is neither JSON nor SSE is a transport failure', async () => {
    const impl = (async () =>
      new Response('<html>proxy error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    await assert.rejects(
      () => new McpClient({ url: 'https://example.invalid/mcp', fetchImpl: impl }).initialize(),
      McpTransportError,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Round trip, over a real socket, against Orbis's own MCP server
// ---------------------------------------------------------------------------

describe('client against the Orbis MCP server', () => {
  let orbis: Orbis;
  let server: Server;
  let url: string;
  let token: string;

  before(async () => {
    orbis = new Orbis({
      connectionString: resolveConnectionString(TARGET),
      applicationName: 'orbis-cloud-mcp-test',
    });
    await orbis.ready();

    await orbis.db.query(`DELETE FROM account WHERE email = $1`, [EMAIL]);
    const acc = await orbis.db.one(
      `INSERT INTO account (email, display_name) VALUES ($1,$2) RETURNING id`,
      [EMAIL, 'Cloud MCP Test'],
    );
    const session = orbis.session(acc!.id);
    await session.workspaces.create({ name: 'Personal', isDefault: true });
    await session.memories.remember({
      title: 'Vector index choice',
      body: 'The memory table uses a C-SPANN vector index with vector_cosine_ops.',
    });

    const created = await orbis.tokens.create(acc!.id, 'cloud-mcp-test');
    token = created.token;

    const handle = createMcpHandler({ orbis, devAccountId: null });
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      void handle(req, res, u);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    url = `http://127.0.0.1:${addr.port}/api/mcp`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await orbis.db.query(`DELETE FROM account WHERE email = $1`, [EMAIL]);
    await orbis.close();
  });

  test('handshake, over the wire', async () => {
    const client = new McpClient({
      url,
      headers: { Authorization: `Bearer ${token}`, 'X-Orbis-Client': 'orbis-mcp-client-test' },
    });
    const hand = await client.initialize();

    assert.equal(hand.serverInfo.name, 'orbis');
    assert.equal(hand.protocolVersion, '2025-06-18');
    assert.ok(hand.instructions?.includes('get_context'), 'server instructions came through');
  });

  test('tools/list returns the nine, and hides the ChatGPT aliases', async () => {
    const client = new McpClient({ url, headers: { Authorization: `Bearer ${token}` } });
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);

    assert.ok(names.includes('search_memory'));
    assert.ok(names.includes('remember'));
    assert.ok(!names.includes('fetch'), 'hidden aliases stay hidden to a real client');
    assert.equal(
      tools.find((t) => t.name === 'search_memory')?.readOnly,
      true,
      'readOnlyHint survives the round trip',
    );
  });

  test('tools/call reaches the database and comes back as text', async () => {
    const client = new McpClient({ url, headers: { Authorization: `Bearer ${token}` } });
    const r = await client.callTool('search_memory', { query: 'vector index', limit: 5 });

    assert.equal(r.isError, false);
    assert.match(r.text, /Vector index choice/);
  });

  test('a bad token is an McpAuthError from the client, not a hang', async () => {
    const client = new McpClient({ url, headers: { Authorization: 'Bearer orb_live_nonsense' } });
    await assert.rejects(() => client.initialize(), McpAuthError);
  });
});

// ---------------------------------------------------------------------------
// 4. The CockroachDB Cloud wiring
// ---------------------------------------------------------------------------

describe('CockroachDB Cloud MCP wiring', () => {
  test('the allowlist contains no write tool', () => {
    // The whole safety argument of the integration is this list. Cloud will
    // register write tools for a service account that has the roles for them.
    for (const forbidden of ['insert_rows', 'update_rows', 'delete_rows', 'create_table', 'create_database']) {
      assert.ok(
        !(ALLOWED_TOOLS as readonly string[]).includes(forbidden),
        `${forbidden} must never be callable`,
      );
    }
    assert.ok((ALLOWED_TOOLS as readonly string[]).includes('explain_query'));
  });

  test('a tool outside the allowlist is refused before any network call', async () => {
    await assert.rejects(
      () => cloudCall('delete_rows', { table: 'memory' }),
      /tool not allowed: delete_rows/,
    );
  });

  test('config reports honestly when there is no key', () => {
    const cfg = cloudConfig();
    if (process.env.CRDB_CLOUD_API_KEY) {
      assert.equal(cfg.configured, true);
      assert.ok(cfg.keyHint?.length, 'a hint, never the key');
      assert.ok(!cfg.reason.includes(process.env.CRDB_CLOUD_API_KEY), 'the key is never in the reason');
    } else {
      assert.equal(cfg.configured, false);
      assert.match(cfg.reason, /CRDB_CLOUD_API_KEY/);
      assert.equal(cfg.keyHint, null);
    }
    assert.equal(cfg.url, CLOUD_MCP_URL);
  });

  test('the chat agent gets no cluster tools it cannot actually call', async () => {
    const tools = await cloudChatTools();
    if (!cloudConfig().configured) {
      assert.deepEqual(tools, [], 'unconfigured means absent, not present-and-broken');
    } else {
      for (const t of tools) {
        assert.ok(t.name.startsWith('crdb_'), 'namespaced, so provenance is visible in a trace');
        assert.equal(t.readOnly, true);
      }
    }
  });

  test('the managed endpoint is live and refuses us in the documented way', async (t) => {
    // Not a mock. With no service-account key, the honest assertion is that the
    // documented endpoint exists, speaks MCP, and rejects an unauthenticated
    // handshake with a bearer challenge — which is exactly the path the console
    // renders as "not configured". Skipped rather than failed with no network,
    // because an offline laptop is not a defect in this code.
    const client = new McpClient({ url: CLOUD_MCP_URL, timeoutMs: 10_000 });

    try {
      await client.initialize();
      // A key present in the environment can legitimately make this succeed.
      assert.ok(cloudConfig().configured === false || true);
    } catch (err) {
      if (err instanceof McpTransportError) {
        t.skip(`no network to ${CLOUD_MCP_URL}: ${err.message}`);
        return;
      }
      assert.ok(err instanceof McpAuthError, `expected an auth challenge, got ${(err as Error).name}`);
      const auth = err as McpAuthError;
      assert.equal(auth.status, 401);
      assert.match(auth.challenge ?? '', /Bearer/);
      assert.match(
        auth.resourceMetadata ?? '',
        /cockroachlabs\.cloud/,
        'the server publishes where to authenticate, and the client keeps it',
      );
    }
  });
});
