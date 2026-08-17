import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Orbis } from '../../packages/orbis-core/src/index.ts';
import { logToolCall, recordConnection } from '../../packages/orbis-core/src/index.ts';
import { TOOLS, TOOLS_BY_NAME } from './tools.ts';

/**
 * Streamable HTTP transport for MCP, per spec 2025-06-18.
 *
 * The spec permits a POST carrying a JSON-RPC request to be answered either
 * with an SSE stream or with a single `application/json` object, and permits a
 * GET to be answered with `405 Method Not Allowed` when the server offers no
 * server-initiated stream. Taking both of those options removes SSE from the
 * implementation entirely: this is a plain JSON request/response handler.
 *
 * That is not a shortcut. Orbis has no server-initiated messages to push — every
 * interaction is an agent asking a question — so a stream would be an idle
 * connection per client and nothing more. It also means the same handler runs
 * unchanged behind a serverless function, where holding a long-lived SSE
 * connection is the awkward case.
 *
 * Backwards compatibility with the deprecated 2024-11-05 HTTP+SSE transport is
 * handled by version negotiation on `initialize` rather than by hosting the old
 * two-endpoint shape.
 */

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';

const SERVER_INFO = {
  name: 'orbis',
  title: 'Orbis — one memory, every agent',
  version: '1.0.0',
};

const INSTRUCTIONS = `Orbis is the user's persistent memory, shared across every AI tool they use.

Call get_context once at the start of the session before anything else — it tells you who
this person is and how they work, so you do not start cold.

During the session, use search_memory before assuming anything about the user or their
projects. Store durable things with remember. If you discover something stored is wrong,
use correct rather than storing a contradiction — Orbis will tell you what else was built
on it.`;

/** JSON-RPC error codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

export interface McpAuth {
  accountId: string;
  displayName: string;
  scopes: string[];
}

/**
 * Extract a bearer token.
 *
 * Two forms, because not every client can set headers. The header is correct
 * and preferred. The path form (`/api/mcp/u/<token>`) exists for clients whose
 * config accepts only a URL — without it those clients simply cannot connect,
 * and "works everywhere" is the entire proposition.
 */
export function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  const m = url.pathname.match(/\/u\/(orb_live_[A-Za-z0-9_-]+)/);
  if (m) return m[1];

  // Some clients only support query strings. Accepted, but tokens in URLs end
  // up in logs and history, so the console never generates links in this shape.
  const q = url.searchParams.get('token');
  return q?.startsWith('orb_live_') ? q : null;
}

/**
 * Reject cross-origin browser requests.
 *
 * The spec calls this out specifically: without Origin validation a malicious
 * web page can reach an MCP server the user's browser can see, via DNS
 * rebinding. Non-browser clients send no Origin at all, which is why absence is
 * allowed and only a present-and-unrecognised value is refused.
 */
function originAllowed(req: IncomingMessage, allowed: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowed.includes('*')) return true;
  return allowed.some((a) => origin === a);
}

export interface McpHandlerOptions {
  orbis: Orbis;
  allowedOrigins?: string[];
  /** Skip token auth and act as this account. Local development only. */
  devAccountId?: string | null;
}

export function createMcpHandler(opts: McpHandlerOptions) {
  const { orbis } = opts;
  const allowedOrigins = opts.allowedOrigins ?? ['*'];

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!originAllowed(req, allowedOrigins)) {
      return send(res, 403, { error: 'origin not allowed' });
    }

    // CORS preflight, so a browser-based client can connect.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return void res.end();
    }

    // Spec-legal: no server-initiated stream is offered, so GET is 405.
    if (req.method === 'GET') {
      res.writeHead(405, { ...corsHeaders(req), Allow: 'POST, DELETE, OPTIONS' });
      return void res.end();
    }

    // Sessions are not used — every request carries its own bearer token and
    // the server holds no per-connection state — so there is nothing to tear
    // down and DELETE is simply acknowledged.
    if (req.method === 'DELETE') {
      res.writeHead(204, corsHeaders(req));
      return void res.end();
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { ...corsHeaders(req), Allow: 'POST, DELETE, OPTIONS' });
      return void res.end();
    }

    const clientProtocol = String(req.headers['mcp-protocol-version'] ?? '');
    if (clientProtocol && !SUPPORTED_PROTOCOLS.includes(clientProtocol)) {
      return send(res, 400, {
        error: `unsupported MCP-Protocol-Version: ${clientProtocol}`,
        supported: SUPPORTED_PROTOCOLS,
      }, req);
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendRpc(res, req, rpcError(null, PARSE_ERROR, 'invalid JSON'));
    }

    // Authenticate. A 401 carries WWW-Authenticate so an OAuth-capable client
    // knows to begin a flow rather than simply reporting a failure.
    const token = extractToken(req, url);
    let auth: McpAuth | null = null;

    if (opts.devAccountId) {
      auth = { accountId: opts.devAccountId, displayName: 'dev', scopes: ['read', 'write'] };
    } else if (token) {
      const identity = await orbis.tokens.resolve(token);
      if (identity) {
        auth = {
          accountId: identity.accountId,
          displayName: identity.displayName,
          scopes: identity.scopes,
        };
      }
    }

    if (!auth) {
      res.writeHead(401, {
        ...corsHeaders(req),
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="orbis", error="invalid_token"`,
      });
      return void res.end(
        JSON.stringify({
          error: 'missing or invalid bearer token',
          hint: 'Create one in the Orbis console under Setup, then pass it as Authorization: Bearer orb_live_…',
        }),
      );
    }

    const messages: RpcMessage[] = Array.isArray(body) ? body : [body as RpcMessage];
    const responses: unknown[] = [];

    for (const msg of messages) {
      const out = await dispatch(msg, auth, req);
      if (out) responses.push(out);
    }

    // A batch or notification with nothing to return is a 202 with no body,
    // which is what the spec requires for accepted-but-answerless input.
    if (responses.length === 0) {
      res.writeHead(202, corsHeaders(req));
      return void res.end();
    }

    return sendRpc(res, req, Array.isArray(body) ? responses : responses[0]);
  };

  // -------------------------------------------------------------------------

  async function dispatch(
    msg: RpcMessage,
    auth: McpAuth,
    req: IncomingMessage,
  ): Promise<unknown | null> {
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined || msg.id === null;

    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return isNotification ? null : rpcError(id, INVALID_REQUEST, 'not a JSON-RPC 2.0 request');
    }

    try {
      switch (msg.method) {
        case 'initialize': {
          const requested = String(msg.params?.protocolVersion ?? DEFAULT_PROTOCOL);
          const agreed = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
          const info = msg.params?.clientInfo ?? {};

          // The handshake is what turns the Setup tab's indicator green. It is
          // recorded because a client genuinely connected, not because someone
          // said they had configured one.
          void recordConnection(orbis.db, auth.accountId, {
            name: String(info.name ?? 'unknown'),
            version: String(info.version ?? ''),
            protocol: agreed,
            transport: 'streamable-http',
          }).catch(() => {});

          return rpcOk(id, {
            protocolVersion: agreed,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          });
        }

        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;

        case 'ping':
          return rpcOk(id, {});

        case 'tools/list':
          return rpcOk(id, {
            tools: TOOLS.filter((t) => !t.hidden).map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { readOnlyHint: Boolean(t.readOnly) },
            })),
          });

        // Declared as unsupported rather than left to fall through to
        // METHOD_NOT_FOUND: some clients probe these on connect and a clean
        // empty list is a tidier answer than an error in their logs.
        case 'resources/list':
          return rpcOk(id, { resources: [] });
        case 'prompts/list':
          return rpcOk(id, { prompts: [] });

        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          const tool = TOOLS_BY_NAME.get(name);
          if (!tool) return rpcError(id, INVALID_PARAMS, `no such tool: ${name}`);

          if (!tool.readOnly && !auth.scopes.includes('write')) {
            return rpcOk(id, {
              content: [{ type: 'text', text: 'This token is read-only.' }],
              isError: true,
            });
          }

          const clientName = String(req.headers['x-orbis-client'] ?? '') || (await lastClient(auth.accountId));
          const session = orbis.session(auth.accountId);
          const started = Date.now();

          try {
            const result = await tool.handler(session, msg.params?.arguments ?? {}, {
              client: clientName,
              surface: 'mcp',
            });
            logToolCall(orbis.db, {
              accountId: auth.accountId,
              client: clientName,
              surface: 'mcp',
              tool: name,
              ok: !result.isError,
              latencyMs: Date.now() - started,
              resultCount: result.count ?? 0,
            });
            return rpcOk(id, {
              content: [{ type: 'text', text: result.text }],
              ...(result.structured ? { structuredContent: result.structured } : {}),
              isError: Boolean(result.isError),
            });
          } catch (err) {
            const message = (err as Error).message;
            logToolCall(orbis.db, {
              accountId: auth.accountId,
              client: clientName,
              surface: 'mcp',
              tool: name,
              ok: false,
              latencyMs: Date.now() - started,
              error: message.slice(0, 300),
            });
            // Returned as a tool result rather than a protocol error: the model
            // should see what went wrong and be able to adapt, whereas a
            // JSON-RPC error is a transport failure it cannot reason about.
            return rpcOk(id, {
              content: [{ type: 'text', text: `Tool failed: ${message}` }],
              isError: true,
            });
          }
        }

        default:
          return isNotification ? null : rpcError(id, METHOD_NOT_FOUND, `unknown method: ${msg.method}`);
      }
    } catch (err) {
      return rpcError(id, INTERNAL_ERROR, (err as Error).message);
    }
  }

  /**
   * Which client is calling.
   *
   * The transport is stateless, so `initialize` and a later `tools/call` are
   * unrelated requests and the client name from the handshake is not carried
   * forward. Falling back to the most recently seen connection for this account
   * attributes calls correctly in the overwhelmingly common case of one client
   * at a time, and clients that set `X-Orbis-Client` are exact regardless.
   */
  async function lastClient(accountId: string): Promise<string> {
    const row = await orbis.db.one(
      `SELECT client_name FROM client_connection
        WHERE account_id = $1 ORDER BY last_seen DESC LIMIT 1`,
      [accountId],
    );
    return row?.client_name ?? 'unknown';
  }
}

// ---------------------------------------------------------------------------

function rpcOk(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-Orbis-Client',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
}

function sendRpc(res: ServerResponse, req: IncomingMessage, payload: unknown): void {
  res.writeHead(200, {
    ...corsHeaders(req),
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': DEFAULT_PROTOCOL,
    'Mcp-Session-Id': randomUUID(),
  });
  res.end(JSON.stringify(payload));
}

function send(res: ServerResponse, status: number, payload: unknown, req?: IncomingMessage): void {
  res.writeHead(status, {
    ...(req ? corsHeaders(req) : {}),
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
