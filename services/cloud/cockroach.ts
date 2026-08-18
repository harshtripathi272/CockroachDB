/**
 * CockroachDB Cloud's managed MCP server, consumed as a client.
 *
 * Cockroach Labs hosts an MCP server at https://cockroachlabs.cloud/mcp that
 * exposes the clusters in an organisation to any MCP-speaking agent: schemas,
 * node liveness, running queries, read-only SQL, and `EXPLAIN`. This module
 * points the generic client in ./mcp-client.ts at it and gives the rest of
 * Orbis three things:
 *
 *   status()      — what the connection is, honestly, including "not configured"
 *   call()        — one allowlisted read-only tool call, for the console
 *   chatTools()   — the same tools, shaped as Orbis tool definitions, so the
 *                   chat agent can reach the cluster mid-conversation
 *
 * Why this is worth wiring at all, given Orbis already holds a direct SQL
 * connection to the same cluster: the two answer different questions. The pg
 * pool is a data path — it reads and writes rows on behalf of a user. The MCP
 * server is an operational path, authenticated by a Cloud service account and
 * checked against Cloud RBAC on every call, which means it can answer questions
 * about the *cluster* (nodes, version, live statements, plans) that a SQL user
 * connected to one database has no standing to ask. The console's proof that
 * the vector index is used gets stronger for the same reason: an `EXPLAIN` run
 * through CockroachDB's own tooling is harder to dismiss than one Orbis ran
 * against itself and then reported on.
 *
 * Two authentication methods exist; only one of them can work unattended.
 * OAuth 2.1 with PKCE is what an interactive editor uses, and it needs a
 * browser. A service-account API key is a bearer token, which is what a server
 * process can hold — so that is what this reads. There is no fallback and no
 * pretending: with no key, `status()` says so and the console shows the exact
 * steps to create one.
 *
 * Safety: the allowlist below is read-only, and enumerated rather than derived.
 * The Cloud server will happily register `insert_rows`, `update_rows`, and
 * `delete_rows` for a service account with the roles to use them, and a chat
 * agent that can be talked into `delete_rows` on a production cluster is not a
 * feature. Filtering by the server's own `readOnlyHint` would be the elegant
 * version and is deliberately not what happens here, because it makes the blast
 * radius depend on a remote server's metadata being right.
 */

import { McpClient, McpAuthError, McpTransportError } from './mcp-client.ts';
import type { RemoteTool } from './mcp-client.ts';
import type { ToolDef } from '../mcp/tools.ts';

export const CLOUD_MCP_URL = 'https://cockroachlabs.cloud/mcp';

/**
 * Tools this integration will call, and nothing else.
 *
 * Every one is read-only. `select_query` reads user data and is included
 * because schema-aware questions are the point of the integration; it is also
 * the one to remove first if that trade ever stops looking right.
 *
 * `list_clusters` is here for diagnosis as much as for use. A service account
 * authenticates fine with no role on any cluster, and every other tool then
 * fails with "cluster not found" — which reads like a wrong id and is actually
 * a missing role grant. Asking what the account can see turns that into a
 * sentence somebody can act on.
 */
export const ALLOWED_TOOLS = [
  'list_clusters',
  'get_cluster',
  'list_cluster_nodes',
  'list_databases',
  'list_tables',
  'get_table_schema',
  'list_sql_users',
  'show_running_queries',
  'show_statement',
  'select_query',
  'explain_query',
] as const;

/** Prefix for the chat agent, so provenance is obvious in a trace and in Signals. */
const CHAT_PREFIX = 'crdb_';

export interface CloudConfig {
  url: string;
  configured: boolean;
  /** Present only so the UI can say "…ending in xxxx". Never the whole key. */
  keyHint: string | null;
  clusterId: string | null;
  reason: string;
}

export interface CloudStatus extends CloudConfig {
  /** Did a live handshake succeed? `null` means it was never attempted. */
  reachable: boolean | null;
  server: { name?: string; title?: string; version?: string } | null;
  protocolVersion: string | null;
  /** Every tool the server advertised, whether or not Orbis will call it. */
  tools: RemoteTool[];
  /** The subset Orbis is willing to call. */
  allowed: string[];
  /**
   * Clusters this service account can actually see, as names.
   *
   * `null` when the question was not asked or could not be answered. An empty
   * array is the interesting case and is not the same as null: it means the key
   * is valid and the account has been granted nothing.
   */
  clusters: string[] | null;
  /** Does `clusters` contain the cluster this deployment is pinned to? */
  clusterVisible: boolean | null;
  error: string | null;
  /** How to fix it, when there is something to fix. */
  hint: string | null;
  checkedAt: string;
}

// ---------------------------------------------------------------------------

export function cloudConfig(): CloudConfig {
  const key = (process.env.CRDB_CLOUD_API_KEY ?? '').trim();
  const clusterId = (process.env.CRDB_CLUSTER_ID ?? '').trim() || null;
  const url = (process.env.CRDB_CLOUD_MCP_URL ?? '').trim() || CLOUD_MCP_URL;

  if (!key) {
    return {
      url,
      configured: false,
      keyHint: null,
      clusterId,
      reason:
        'CRDB_CLOUD_API_KEY is not set. The managed MCP server accepts OAuth or a ' +
        'service-account API key; only the key works without a browser.',
    };
  }

  return {
    url,
    configured: true,
    keyHint: `…${key.slice(-4)}`,
    clusterId,
    reason: clusterId
      ? `Service-account key, scoped to cluster ${clusterId} by the mcp-cluster-id header.`
      : 'Service-account key, unscoped — every cluster the service account can reach.',
  };
}

/**
 * Build a client, or null if there is no key to build one with.
 *
 * `mcp-cluster-id` is sent whenever a cluster is configured. That header is not
 * a convenience: with it set, the server refuses any tool call naming a
 * different cluster, so a scoped connection cannot be talked into wandering
 * across an organisation. Orbis has exactly one cluster, so there is no reason
 * to leave that door open.
 */
export function cloudClient(): McpClient | null {
  const cfg = cloudConfig();
  if (!cfg.configured) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${(process.env.CRDB_CLOUD_API_KEY ?? '').trim()}`,
  };
  if (cfg.clusterId) headers['mcp-cluster-id'] = cfg.clusterId;

  return new McpClient({
    url: cfg.url,
    headers,
    clientName: 'orbis',
    clientVersion: '1.0.0',
    timeoutMs: 20_000,
  });
}

// ---------------------------------------------------------------------------
// Status, with a cache
// ---------------------------------------------------------------------------

/**
 * A successful probe is three round trips to a server on the other side of the
 * internet. The console polls, and Lambda invocations are short and frequent,
 * so the answer is held briefly. Failures are cached for much less time, so
 * that fixing a key shows up quickly rather than after a stale five minutes.
 */
const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 20_000;

let cached: { at: number; ttl: number; value: CloudStatus } | null = null;

export function invalidateCloudStatus(): void { cached = null; }

export async function cloudStatus(force = false): Promise<CloudStatus> {
  if (!force && cached && Date.now() - cached.at < cached.ttl) return cached.value;

  const cfg = cloudConfig();
  const base: CloudStatus = {
    ...cfg,
    reachable: null,
    server: null,
    protocolVersion: null,
    tools: [],
    allowed: [],
    clusters: null,
    clusterVisible: null,
    error: null,
    hint: null,
    checkedAt: new Date().toISOString(),
  };

  if (!cfg.configured) {
    const value: CloudStatus = {
      ...base,
      hint:
        'In the CockroachDB Cloud Console: Access Management → Service Accounts → ' +
        'create one with the Cluster Operator role, create an API key, then set ' +
        'CRDB_CLOUD_API_KEY to the secret key it shows you once.',
    };
    cached = { at: Date.now(), ttl: FAIL_TTL_MS, value };
    return value;
  }

  const client = cloudClient()!;
  try {
    const hand = await client.initialize();
    const tools = await client.listTools();
    const allowed = tools
      .map((t) => t.name)
      .filter((n) => (ALLOWED_TOOLS as readonly string[]).includes(n));

    // A handshake proves the key is real. It does not prove the service
    // account has been granted anything, and those are different problems with
    // different fixes, so ask before reporting success.
    const { clusters, clusterVisible } = await visibleClusters(client, cfg.clusterId);

    const value: CloudStatus = {
      ...base,
      reachable: true,
      server: hand.serverInfo,
      protocolVersion: hand.protocolVersion,
      tools,
      allowed,
      clusters,
      clusterVisible,
      hint: describeReach(allowed.length, clusters, clusterVisible, cfg.clusterId),
    };
    cached = { at: Date.now(), ttl: OK_TTL_MS, value };
    return value;
  } catch (err) {
    const value: CloudStatus = { ...base, reachable: false, ...describeFailure(err) };
    cached = { at: Date.now(), ttl: FAIL_TTL_MS, value };
    return value;
  } finally {
    void client.close().catch(() => {});
  }
}

/**
 * Ask the server which clusters this key can reach.
 *
 * Deliberately non-fatal: if `list_clusters` is unavailable or errors, the
 * connection is still good and the answer is simply unknown, which the `null`
 * says. A diagnostic that can take down the thing it diagnoses is worse than no
 * diagnostic.
 */
async function visibleClusters(
  client: McpClient,
  pinned: string | null,
): Promise<{ clusters: string[] | null; clusterVisible: boolean | null }> {
  try {
    const r = await client.callTool('list_clusters', {});
    const rows = (r.structured?.rows ?? JSON.parse(r.text || '{}').rows) as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(rows)) return { clusters: null, clusterVisible: null };

    const names = rows.map((row) =>
      String(row.name ?? row.cluster_name ?? row.id ?? 'unnamed'),
    );
    const ids = rows.map((row) => String(row.id ?? row.cluster_id ?? ''));
    return {
      clusters: names,
      clusterVisible: pinned ? ids.includes(pinned) : names.length > 0,
    };
  } catch {
    return { clusters: null, clusterVisible: null };
  }
}

/** The one sentence worth showing, given what the probe found. */
function describeReach(
  allowedCount: number,
  clusters: string[] | null,
  clusterVisible: boolean | null,
  pinned: string | null,
): string | null {
  if (clusters !== null && clusters.length === 0) {
    return (
      'The key is valid and the handshake succeeded, but this service account can ' +
      'see no clusters, so every tool call will fail with "cluster not found". In ' +
      'the Cloud Console: Access Management → Service Accounts → this account → ' +
      'Assign roles → Cluster Operator on your cluster (or Cluster Admin at the ' +
      'organisation level). Nothing else needs changing.'
    );
  }
  if (pinned && clusterVisible === false) {
    return (
      `Connected, but cluster ${pinned} is not one this service account can see` +
      (clusters?.length ? ` — it can see: ${clusters.join(', ')}. ` : '. ') +
      'Either CRDB_CLUSTER_ID is the wrong id, or the role was granted on a ' +
      'different cluster.'
    );
  }
  if (!allowedCount) {
    return (
      'Connected, but the service account can see none of the read-only tools ' +
      'Orbis uses. Check that it holds the Cluster Operator or Cluster Admin role.'
    );
  }
  return null;
}

function describeFailure(err: unknown): { error: string; hint: string | null } {
  if (err instanceof McpAuthError) {
    return {
      error: `${err.status} — the key was rejected: ${err.message}`,
      hint:
        'The API key is wrong, revoked, or belongs to a service account without a ' +
        'role on this cluster. Cloud RBAC is checked on every tool call, so a key ' +
        'that authenticates can still be refused the tools.',
    };
  }
  if (err instanceof McpTransportError) {
    return {
      error: err.message,
      hint: 'The endpoint answered nothing usable. This is a network or outage problem, not a credential one.',
    };
  }
  return { error: (err as Error).message, hint: null };
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

export interface CloudCallResult {
  ok: boolean;
  tool: string;
  text: string;
  structured?: Record<string, unknown>;
  latencyMs: number;
}

/**
 * One tool call, allowlist-enforced.
 *
 * The allowlist check happens here rather than at the route, so every caller —
 * the console, the chat agent, a future one — inherits it. A refusal is a
 * thrown error and not a soft result, because a caller asking for a tool that
 * is not on the list has a bug, not a bad day.
 */
export async function cloudCall(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<CloudCallResult> {
  if (!(ALLOWED_TOOLS as readonly string[]).includes(tool)) {
    throw new Error(`tool not allowed: ${tool}`);
  }
  const client = cloudClient();
  if (!client) throw new Error('CockroachDB Cloud MCP is not configured (no CRDB_CLOUD_API_KEY)');

  const started = Date.now();
  try {
    const r = await client.callTool(tool, args);
    return {
      ok: !r.isError,
      tool,
      text: r.text,
      structured: r.structured,
      latencyMs: Date.now() - started,
    };
  } finally {
    void client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The same tools, for the chat agent
// ---------------------------------------------------------------------------

/**
 * Adapt the remote tools into Orbis `ToolDef`s.
 *
 * The chat agent already drives a list of `ToolDef`s and knows nothing about
 * where any of them run. Wrapping the remote ones in the same shape means the
 * agent loop needs no branch for "this one is over the network": it calls the
 * handler, gets text back, and shows it in the trace like every other step.
 *
 * Names are prefixed `crdb_` so a trace, and the Signals tab, distinguish a
 * call that left the building from one that hit Orbis's own memory.
 *
 * Returns an empty list when unconfigured or unreachable, which is the right
 * failure: the model simply never learns those tools exist, rather than being
 * handed tools that will fail and then apologising for them.
 */
export async function cloudChatTools(): Promise<ToolDef[]> {
  const status = await cloudStatus();
  if (!status.configured || !status.reachable) return [];

  const usable = status.tools.filter((t) =>
    (ALLOWED_TOOLS as readonly string[]).includes(t.name),
  );

  return usable.map((t): ToolDef => ({
    name: `${CHAT_PREFIX}${t.name}`,
    title: t.title ?? t.name,
    description:
      `${t.description ?? t.name} ` +
      `(CockroachDB Cloud, over its managed MCP server — read-only, live cluster state)`,
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    readOnly: true,
    handler: async (_session, args) => {
      try {
        const r = await cloudCall(t.name, args ?? {});
        return { text: r.text, structured: r.structured, isError: !r.ok };
      } catch (err) {
        // Surfaced as a tool result, not a throw: the model can read this and
        // try something else, which is exactly what it should do when the
        // cluster is unreachable mid-conversation.
        return { text: `CockroachDB Cloud MCP failed: ${(err as Error).message}`, isError: true };
      }
    },
  }));
}

/** True when a tool name came from the Cloud MCP server rather than from Orbis. */
export function isCloudTool(name: string): boolean {
  return name.startsWith(CHAT_PREFIX);
}
