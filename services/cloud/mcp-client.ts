/**
 * A Model Context Protocol *client*, over Streamable HTTP.
 *
 * Orbis has been an MCP server since the first commit. This is the other half:
 * the code that lets Orbis connect out to somebody else's MCP server and use
 * its tools. It exists so the console — and the chat agent — can reach
 * CockroachDB Cloud's managed MCP server at https://cockroachlabs.cloud/mcp
 * rather than only ever being the thing that gets connected to.
 *
 * Written by hand rather than pulled from `@modelcontextprotocol/sdk`, for a
 * reason specific to this project: the deployment bundle already carries a
 * quantized MiniLM and the ONNX runtime, and it sits close enough to Lambda's
 * ceiling that a dependency has to earn its place. A client that speaks three
 * methods over one transport is about two hundred lines. The server side of the
 * same protocol (services/mcp/http.ts) was written the same way and for the
 * same reason, so the two halves stay symmetrical.
 *
 * What the transport actually requires, per spec 2025-06-18:
 *
 *  - POST JSON-RPC to a single endpoint, with `Accept` listing *both*
 *    `application/json` and `text/event-stream`. The server picks. Orbis's own
 *    server always picks JSON; CockroachDB Cloud's answers with SSE. A client
 *    that handles only one of them works against exactly one of those two
 *    servers, so both are parsed here.
 *  - `Mcp-Session-Id` may come back on the initialize response. If it does,
 *    every later request must carry it, and DELETE ends the session.
 *  - `MCP-Protocol-Version` must be sent on every request after initialize,
 *    carrying the version that was actually negotiated — not the one asked for.
 *  - `notifications/initialized` is a notification: no id, and the server
 *    answers 202 with no body. Sending it is not optional; servers are
 *    permitted to reject real calls until they have seen it.
 *
 * Failures are modelled as three distinct error types rather than flattened
 * into strings, because the caller has to tell "your key is wrong" from "the
 * network is down" — those produce completely different advice in the UI.
 */

/** Protocol versions this client can speak, most preferred first. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26'];

export interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** From `annotations.readOnlyHint`. Absent means the server did not say. */
  readOnly?: boolean;
}

export interface RemoteToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface ServerHandshake {
  protocolVersion: string;
  serverInfo: { name?: string; title?: string; version?: string };
  capabilities: Record<string, unknown>;
  instructions?: string;
}

/**
 * The server refused our credentials.
 *
 * Carries the `WWW-Authenticate` challenge, because that is where an
 * OAuth-based server publishes its metadata URL, and because the difference
 * between "no token sent" and "token rejected" is the whole diagnosis.
 */
export class McpAuthError extends Error {
  readonly status: number;
  readonly challenge: string | null;
  readonly resourceMetadata: string | null;

  constructor(status: number, challenge: string | null, detail: string) {
    super(detail);
    this.name = 'McpAuthError';
    this.status = status;
    this.challenge = challenge;
    const m = challenge?.match(/resource_metadata="([^"]+)"/);
    this.resourceMetadata = m ? m[1] : null;
  }
}

/** The server answered, but with a JSON-RPC error object. */
export class McpRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'McpRpcError';
    this.code = code;
  }
}

/** The transport failed: DNS, TLS, timeout, a 5xx, an unparseable body. */
export class McpTransportError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'McpTransportError';
    this.status = status;
  }
}

export interface McpClientOptions {
  url: string;
  /** Extra headers — this is where `Authorization` and `mcp-cluster-id` go. */
  headers?: Record<string, string>;
  clientName?: string;
  clientVersion?: string;
  timeoutMs?: number;
  /** Injectable, so tests can drive the parser without a network. */
  fetchImpl?: typeof fetch;
}

export class McpClient {
  readonly url: string;

  #headers: Record<string, string>;
  #clientName: string;
  #clientVersion: string;
  #timeoutMs: number;
  #fetch: typeof fetch;

  #sessionId: string | null = null;
  #protocol: string | null = null;
  #handshake: ServerHandshake | null = null;
  #nextId = 1;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.#headers = opts.headers ?? {};
    this.#clientName = opts.clientName ?? 'orbis';
    this.#clientVersion = opts.clientVersion ?? '1.0.0';
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  get sessionId(): string | null { return this.#sessionId; }
  get protocolVersion(): string | null { return this.#protocol; }
  get serverInfo(): ServerHandshake | null { return this.#handshake; }

  /**
   * Handshake.
   *
   * Idempotent: calling it twice returns the first result rather than opening a
   * second session. Callers reach for it defensively before every operation,
   * and a fresh session per tool call would be both wasteful and wrong.
   */
  async initialize(): Promise<ServerHandshake> {
    if (this.#handshake) return this.#handshake;

    const { body, headers } = await this.#post({
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'initialize',
      params: {
        protocolVersion: SUPPORTED_PROTOCOLS[0],
        capabilities: {},
        clientInfo: { name: this.#clientName, version: this.#clientVersion },
      },
    });

    const result = this.#unwrap(body);
    const session = headers.get('mcp-session-id');
    if (session) this.#sessionId = session;

    // Trust the server's answer over our own preference: it may negotiate
    // downward, and every later request has to echo what it actually chose.
    this.#protocol = String(result?.protocolVersion ?? SUPPORTED_PROTOCOLS[0]);

    this.#handshake = {
      protocolVersion: this.#protocol,
      serverInfo: (result?.serverInfo ?? {}) as ServerHandshake['serverInfo'],
      capabilities: (result?.capabilities ?? {}) as Record<string, unknown>,
      instructions: result?.instructions ? String(result.instructions) : undefined,
    };

    // Required by the spec, and some servers gate tool calls on it. It is a
    // notification, so there is nothing to wait on beyond the 202.
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});

    return this.#handshake;
  }

  async listTools(): Promise<RemoteTool[]> {
    await this.initialize();
    const { body } = await this.#post({
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'tools/list',
      params: {},
    });
    const result = this.#unwrap(body);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools
      .map((t: any): RemoteTool => ({
        name: String(t?.name ?? ''),
        title: t?.title ? String(t.title) : undefined,
        description: t?.description ? String(t.description) : undefined,
        inputSchema: (t?.inputSchema ?? undefined) as Record<string, unknown> | undefined,
        readOnly:
          typeof t?.annotations?.readOnlyHint === 'boolean'
            ? Boolean(t.annotations.readOnlyHint)
            : undefined,
      }))
      .filter((t: RemoteTool) => t.name);
  }

  /**
   * Call a tool.
   *
   * A tool that fails returns `isError: true` with the failure as text — that is
   * the protocol's own convention, and it matters: a model can read a tool error
   * and adapt, whereas a thrown exception is invisible to it. Only protocol- and
   * transport-level failures throw.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<RemoteToolResult> {
    await this.initialize();
    const { body } = await this.#post({
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const result = this.#unwrap(body);

    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n')
      .trim();

    return {
      text: text || '(no textual content)',
      structured: (result?.structuredContent ?? undefined) as Record<string, unknown> | undefined,
      isError: Boolean(result?.isError),
    };
  }

  /** End the session if the server issued one. Best effort by design. */
  async close(): Promise<void> {
    if (!this.#sessionId) return;
    try {
      await this.#fetch(this.url, { method: 'DELETE', headers: this.#requestHeaders() });
    } catch { /* the session expires on its own */ }
    this.#sessionId = null;
    this.#handshake = null;
  }

  // -------------------------------------------------------------------------

  #requestHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      // Both, because the server chooses. Offering only one narrows which
      // servers this client can talk to, for no benefit.
      Accept: 'application/json, text/event-stream',
      ...this.#headers,
    };
    if (this.#sessionId) h['Mcp-Session-Id'] = this.#sessionId;
    if (this.#protocol) h['MCP-Protocol-Version'] = this.#protocol;
    return h;
  }

  async #post(payload: unknown): Promise<{ body: any; headers: Headers }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let res: Response;
    try {
      res = await this.#fetch(this.url, {
        method: 'POST',
        headers: this.#requestHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const e = err as Error;
      throw new McpTransportError(
        e.name === 'AbortError'
          ? `no response from ${this.url} within ${this.#timeoutMs}ms`
          : `cannot reach ${this.url}: ${e.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new McpAuthError(
        res.status,
        res.headers.get('www-authenticate'),
        detail || `${res.status} from ${this.url}`,
      );
    }

    // A notification is answered with 202 and no body. Nothing to parse.
    if (res.status === 202 || res.status === 204) return { body: null, headers: res.headers };

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new McpTransportError(`HTTP ${res.status} from ${this.url}: ${detail}`, res.status);
    }

    const raw = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('text/event-stream') ? parseSse(raw) : safeJson(raw);

    if (body === undefined) {
      throw new McpTransportError(`unparseable response from ${this.url}: ${raw.slice(0, 200)}`);
    }
    return { body, headers: res.headers };
  }

  /** Pull `result` out of a JSON-RPC envelope, turning `error` into a throw. */
  #unwrap(body: any): any {
    if (body === null || body === undefined) {
      throw new McpTransportError(`empty response from ${this.url}`);
    }
    // Batched responses are legal; ours are single requests, so take the first.
    const msg = Array.isArray(body) ? body[0] : body;
    if (msg?.error) {
      throw new McpRpcError(Number(msg.error.code ?? -32603), String(msg.error.message ?? 'error'));
    }
    return msg?.result;
  }
}

// ---------------------------------------------------------------------------

function safeJson(raw: string): any {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/**
 * Pull the JSON-RPC message out of an SSE body.
 *
 * A server may send several events on one response — progress notifications
 * ahead of the answer, for instance. The reply we want is the last `data:`
 * payload that parses as JSON and carries `result` or `error`; anything else is
 * commentary. Multi-line `data:` fields are joined with newlines, per the
 * EventSource grammar.
 */
export function parseSse(raw: string): any {
  const events = raw.split(/\r?\n\r?\n/);
  let answer: any;

  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;

    const parsed = safeJson(data);
    if (parsed === undefined) continue;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first && (first.result !== undefined || first.error !== undefined)) answer = parsed;
  }

  return answer;
}
