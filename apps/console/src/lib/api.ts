/**
 * Typed client for the console API.
 *
 * One place that knows about URLs and error handling, so no component ever
 * writes a fetch by hand and every failure surfaces the same way.
 */

export interface Memory {
  id: string;
  workspaceId: string | null;
  workspaceName?: string;
  nodeId: string | null;
  nodePath?: string;
  kind: string;
  title: string;
  body: string;
  source: string;
  client: string;
  confidence: number;
  evidenceCount: number;
  status: 'active' | 'superseded' | 'retracted';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  supersededBy: string | null;
  distance?: number;
  score?: number;
  hops?: number;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  isDefault: boolean;
  memoryCount?: number;
  createdAt: string;
}

export interface TreeNode {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: string;
  name: string;
  slug: string;
  path: string;
  summary: string;
  memoryCount?: number;
  children?: TreeNode[];
}

export interface Entity {
  id: string;
  kind: string;
  name: string;
  canonical: string;
  summary: string;
  mentionCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface WikiPage {
  id: string;
  workspaceId: string | null;
  slug: string;
  title: string;
  kind: string;
  bodyMd: string;
  summary: string;
  generator: string;
  sourceCount: number;
  stale: boolean;
  generatedAt: string;
  citations?: Array<{
    memoryId: string;
    claim: string;
    memoryTitle?: string;
    memoryStatus?: string;
  }>;
}

export interface Connection {
  client_name: string;
  client_version: string;
  protocol: string;
  transport: string;
  first_seen: string;
  last_seen: string;
  call_count: number;
}

export interface Bootstrap {
  account: { display_name: string; email: string; traits: Record<string, unknown>; created_at: string };
  workspaces: Workspace[];
  connections: Connection[];
  counts: { memories: number; entities: number; pages: number; calls: number; questions: number };
  embedder: {
    id: string;
    label: string;
    semantic: boolean;
    reason: string;
    rejected: Array<{ id: string; error: string }>;
  };
  chat: {
    models: ChatModelInfo[];
    defaultModel: string;
    reason: string;
    generative: boolean;
  };
  /** Configuration only. `/cloud` performs the live probe. */
  cloud: {
    url: string;
    configured: boolean;
    keyHint: string | null;
    clusterId: string | null;
    reason: string;
  };
  target: string;
  dev: boolean;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface InterviewQ {
  id: string;
  topic: string;
  question: string;
  why: string;
  priority: number;
  workspace_id: string | null;
}

export interface ToolCall {
  id: string;
  client: string;
  surface: string;
  tool: string;
  ok: boolean;
  latency_ms: number;
  error: string | null;
  result_count: number;
  at: string;
}

export interface Fallout {
  memories: Memory[];
  pages: Array<{ id: string; slug: string; title: string; via: string }>;
  entities: Array<{ id: string; name: string; kind: string }>;
  tookMs: number;
}

export interface GraphSnapshot {
  entities: Entity[];
  memories: Array<{ id: string; title: string; kind: string; status: string; workspaceId: string | null }>;
  edges: Array<{
    srcKind: string; srcId: string;
    dstKind: string; dstId: string;
    rel: string; weight: number;
  }>;
}


export interface ChatModelInfo {
  id: string;
  label: string;
  note: string;
  provider: string;
  generative: boolean;
}

export interface ChatSummary {
  id: string;
  title: string;
  model: string;
  workspace_id: string | null;
  updated_at: string;
  messages: number;
}

export interface AgentStep {
  kind: 'tool' | 'text';
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  latencyMs?: number;
  ok?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: AgentStep[] | null;
  created_at: string;
}

/** A tool advertised by a remote MCP server Orbis connects out to. */
export interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
}

export interface CloudStatus {
  url: string;
  configured: boolean;
  keyHint: string | null;
  clusterId: string | null;
  reason: string;
  /** null when no handshake was attempted, because there was no key to try. */
  reachable: boolean | null;
  server: { name?: string; title?: string; version?: string } | null;
  protocolVersion: string | null;
  tools: RemoteTool[];
  allowed: string[];
  error: string | null;
  hint: string | null;
  checkedAt: string;
  /** Static: what Orbis is willing to call, sent even when unconfigured. */
  allowlist: string[];
}

export interface CloudCallResult {
  ok: boolean;
  tool: string;
  text: string;
  structured?: Record<string, unknown>;
  latencyMs: number;
}

const BASE = '/api/console';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, detail.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const qs = (params: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  bootstrap: () => req<Bootstrap>('/bootstrap'),

  health: () => fetch('/api/health').then((r) => r.json()),

  memories: (o: {
    workspace?: string | null; node?: string | null; kind?: string;
    client?: string; status?: string; limit?: number; offset?: number;
  } = {}) => req<{ memories: Memory[] }>(`/memories${qs(o)}`).then((r) => r.memories),

  memory: (id: string) =>
    req<{ memory: Memory; sources: Memory[]; pages: WikiPage[] }>(`/memories/${id}`),

  createMemory: (m: {
    title: string; body: string; kind?: string;
    workspaceId?: string | null; tags?: string[]; confidence?: number;
  }) => req<{ memory: Memory; reinforced: boolean }>('/memories', {
    method: 'POST', body: JSON.stringify(m),
  }),

  search: (q: string, o: { workspace?: string | null; kind?: string; limit?: number } = {}) =>
    req<{ results: Memory[]; tookMs: number }>(`/search${qs({ q, ...o })}`),

  trace: (id: string) => req<Fallout>(`/memories/${id}/trace`),

  correct: (id: string, b: { reason?: string; replacement?: string; replacementTitle?: string }) =>
    req<{ retracted: Memory; replacement: Memory | null; pagesMarkedStale: number; fallout: Fallout }>(
      `/memories/${id}/correct`,
      { method: 'POST', body: JSON.stringify(b) },
    ),

  workspaces: () => req<{ workspaces: Workspace[] }>('/workspaces').then((r) => r.workspaces),

  createWorkspace: (w: { name: string; slug?: string; description?: string; color?: string; icon?: string }) =>
    req<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify(w) }),

  tree: (workspaceId: string) =>
    req<{ tree: TreeNode[] }>(`/workspaces/${workspaceId}/tree`).then((r) => r.tree),

  createNode: (n: { workspaceId: string; parentId?: string | null; name: string; kind?: string }) =>
    req<TreeNode>('/nodes', { method: 'POST', body: JSON.stringify(n) }),

  graph: (o: { workspace?: string | null; limit?: number } = {}) =>
    req<GraphSnapshot>(`/graph${qs(o)}`),

  entity: (id: string) =>
    req<{ memories: any[]; related: any[] }>(`/entities/${id}`),

  wiki: (o: { workspace?: string | null } = {}) =>
    req<{ pages: WikiPage[] }>(`/wiki${qs(o)}`).then((r) => r.pages),

  wikiPage: (slug: string) => req<WikiPage>(`/wiki/${slug}`),

  interview: () => req<{ questions: InterviewQ[] }>('/interview').then((r) => r.questions),

  answer: (id: string, answer: string, kind?: string) =>
    req<{ memory: Memory }>(`/interview/${id}/answer`, {
      method: 'POST', body: JSON.stringify({ answer, kind }),
    }),

  skipQuestion: (id: string) =>
    req<{ ok: boolean }>(`/interview/${id}/skip`, { method: 'POST' }),

  tokens: () => req<{ tokens: ApiToken[] }>('/tokens').then((r) => r.tokens),

  createToken: (name: string) =>
    req<{ id: string; token: string; prefix: string; name: string; scopes: string[] }>('/tokens', {
      method: 'POST', body: JSON.stringify({ name }),
    }),

  revokeToken: (id: string) => req<{ revoked: boolean }>(`/tokens/${id}`, { method: 'DELETE' }),

  activity: (since = '24h') =>
    req<{ buckets: Array<{ bucket: string; client: string; calls: number; avg_ms: number; errors: number }> }>(
      `/activity${qs({ since })}`,
    ),

  toolStats: () =>
    req<{ tools: Array<{ tool: string; calls: number; p50: number; p95: number; max_ms: number; errors: number }> }>(
      '/tools',
    ),

  calls: (limit = 60) => req<{ calls: ToolCall[] }>(`/calls${qs({ limit })}`).then((r) => r.calls),

  growth: () =>
    req<{ growth: Array<{ day: string; kind: string; n: number }> }>('/growth').then((r) => r.growth),

  audit: (limit = 100) =>
    req<{ entries: any[] }>(`/audit${qs({ limit })}`).then((r) => r.entries),

  models: () =>
    req<{ models: ChatModelInfo[]; defaultModel: string; reason: string }>('/models'),

  chats: () => req<{ chats: ChatSummary[] }>('/chats').then((r) => r.chats),

  createChat: (b: { title?: string; model?: string; workspaceId?: string | null } = {}) =>
    req<ChatSummary>('/chats', { method: 'POST', body: JSON.stringify(b) }),

  chat: (id: string) =>
    req<{ chat: ChatSummary; messages: ChatMessage[] }>(`/chats/${id}`),

  deleteChat: (id: string) => req<{ ok: boolean }>(`/chats/${id}`, { method: 'DELETE' }),

  send: (id: string, text: string, model?: string) =>
    req<{
      message: ChatMessage; steps: AgentStep[]; wrote: string[];
      generative: boolean; provider: string; title: string;
    }>(`/chats/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, model }) }),

  crdb: () => req<any>('/crdb'),

  plans: (q?: string) => req<{ plans: Record<string, string> }>(`/plans${qs({ q })}`),

  cloud: (force = false) => req<CloudStatus>(`/cloud${qs({ force: force ? 1 : null })}`),

  cloudCall: (tool: string, args: Record<string, unknown> = {}) =>
    req<CloudCallResult>('/cloud/call', {
      method: 'POST', body: JSON.stringify({ tool, args }),
    }),
};
