/**
 * The chat agent loop.
 *
 * This is the same nine tools every connected client sees, driven by a model
 * Orbis hosts rather than one the user brought. That symmetry is the point: the
 * Chat tab is not a separate feature with its own data path, it is one more MCP
 * client that happens to live inside the console. A memory written here is
 * indistinguishable from one written by Claude Code, and shows up in the same
 * timeline with `client: 'orbis-chat'`.
 *
 * Governance therefore comes for free. `remember` still refuses an empty
 * memory, `search_memory` still cannot return a retracted one, and every call
 * lands in `tool_call` so the Signals tab counts chat traffic alongside
 * everything else.
 *
 * When a CockroachDB Cloud service-account key is configured, the agent also
 * holds that cluster's own MCP tools, discovered at runtime and prefixed
 * `crdb_`. At that point a single turn can cross two MCP servers — Orbis's, for
 * what the user knows, and CockroachDB's, for what the cluster is doing — which
 * is the entire argument for the protocol being worth having.
 */

import type { Session } from '../../packages/orbis-core/src/index.ts';
import { logToolCall } from '../../packages/orbis-core/src/index.ts';
import { TOOLS, TOOLS_BY_NAME } from '../mcp/tools.ts';
import type { ToolDef } from '../mcp/tools.ts';
import { providerForModel } from './providers.ts';
import type { Turn, ToolCall, ToolOutcome } from './providers.ts';
import { cloudChatTools, isCloudTool } from '../cloud/cockroach.ts';

/** Hidden ChatGPT aliases are noise here — the model gets the real nine. */
const CHAT_TOOLS: ToolDef[] = TOOLS.filter((t) => !t.hidden);

/**
 * The nine memory tools, plus CockroachDB Cloud's if a service-account key is
 * present.
 *
 * Assembled per turn rather than at module load because the Cloud tools are
 * discovered over the network — `cloudChatTools` performs a `tools/list`
 * against the managed MCP server (cached) and returns what that server actually
 * advertises, filtered to the read-only allowlist. If no key is configured, or
 * the endpoint is unreachable, the list is empty and the model never learns
 * those tools existed. That is deliberately quieter than handing it tools that
 * are going to fail.
 */
async function toolsForTurn(): Promise<ToolDef[]> {
  const cloud = await cloudChatTools().catch(() => [] as ToolDef[]);
  return cloud.length ? [...CHAT_TOOLS, ...cloud] : CHAT_TOOLS;
}

/**
 * The system prompt.
 *
 * Deliberately short. The tools carry their own descriptions, and the workspace
 * context is loaded by calling `get_context` rather than pasted in here — that
 * way the chat agent discovers the user the same way an external agent does,
 * and a bug in context assembly shows up in both places at once instead of
 * hiding behind a special case.
 */
function systemPrompt(workspaceName: string | null, hasCloud: boolean): string {
  return [
    'You are the memory agent for Orbis, a persistent memory shared across all of the',
    "user's AI tools. You are talking to the person that memory belongs to.",
    '',
    'Call `get_context` once at the start of a conversation to learn who they are and',
    'how they prefer to work. Search memory before answering anything about their',
    'projects, preferences, or history — do not answer from what you can infer.',
    '',
    'When they tell you something durable about themselves, their work, or their',
    'decisions, call `remember` so their other tools inherit it. Do not record',
    'passing conversational detail. When something they told you before turns out to',
    'be wrong, call `correct` rather than writing a second contradictory memory.',
    '',
    workspaceName
      ? `The active workspace is "${workspaceName}". Scope writes to it unless told otherwise.`
      : 'No workspace is selected; writes go to the default workspace.',
    '',
    // Only mentioned when the tools are actually present. Describing tools the
    // model does not have is how you teach it to hallucinate having used them.
    hasCloud
      ? [
          'Tools named `crdb_*` reach CockroachDB Cloud through its own managed MCP server.',
          'They report live cluster state — nodes, version, schemas, running statements, and',
          'query plans — for the cluster this memory is stored in. They are read-only. Use',
          'them for questions about the database itself, and say which tool you used, because',
          'the answer came from CockroachDB rather than from memory.',
          '',
        ].join('\n')
      : '',
    'Answer in plain prose. Cite what you retrieved rather than restating it at length.',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

export interface AgentStep {
  kind: 'tool' | 'text';
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  latencyMs?: number;
  ok?: boolean;
}

export interface AgentResult {
  text: string;
  steps: AgentStep[];
  model: string;
  provider: string;
  generative: boolean;
  usage: { in: number; out: number };
  /** Ids of memories written during this turn, so the UI can link them. */
  wrote: string[];
}

/** Hard ceiling on model round-trips. A chat turn that needs more has gone wrong. */
const MAX_ITERATIONS = 8;

export async function runAgent(opts: {
  session: Session;
  model: string;
  history: Turn[];
  workspaceName?: string | null;
  accountId: string;
  db: { query: (sql: string, params?: unknown[]) => Promise<any[]> };
}): Promise<AgentResult> {
  const provider = providerForModel(opts.model);
  if (!provider) throw new Error(`unknown model: ${opts.model}`);

  const tools = await toolsForTurn();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const hasCloud = tools.length > CHAT_TOOLS.length;

  const turns: Turn[] = [...opts.history];
  const steps: AgentStep[] = [];
  const wrote: string[] = [];
  const usage = { in: 0, out: 0 };
  let text = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await provider.complete({
      model: opts.model,
      system: systemPrompt(opts.workspaceName ?? null, hasCloud),
      turns,
      tools,
    });

    usage.in += res.usage.in;
    usage.out += res.usage.out;
    if (res.text) text = res.text;

    if (res.stop !== 'tools' || !res.toolCalls.length) {
      if (res.text) steps.push({ kind: 'text', output: res.text });
      break;
    }

    turns.push({
      role: 'assistant',
      text: res.text,
      toolCalls: res.toolCalls,
      raw: res.raw,
    });

    // Tool calls in one assistant message are independent by construction, and
    // every result must come back in a single turn — splitting them teaches the
    // model to stop batching.
    const results = await Promise.all(
      res.toolCalls.map((call) => execute(call, byName, opts, steps, wrote)),
    );
    turns.push({ role: 'tool', results });
  }

  return {
    text: text || '(no reply)',
    steps,
    model: opts.model,
    provider: provider.label,
    generative: provider.generative,
    usage,
    wrote,
  };
}

async function execute(
  call: ToolCall,
  byName: Map<string, ToolDef>,
  opts: Parameters<typeof runAgent>[0],
  steps: AgentStep[],
  wrote: string[],
): Promise<ToolOutcome> {
  // The per-turn map, not the module-level TOOLS_BY_NAME, because the Cloud
  // tools are discovered at runtime and only exist in the former.
  const tool = byName.get(call.name) ?? TOOLS_BY_NAME.get(call.name);
  const started = Date.now();

  // A call that left the building is recorded as such, so Signals can tell
  // memory traffic from cluster traffic without parsing tool names.
  const surface = isCloudTool(call.name) ? 'cloud-mcp' : 'console';

  if (!tool) {
    steps.push({ kind: 'tool', tool: call.name, input: call.input, ok: false, output: 'no such tool' });
    return { id: call.id, name: call.name, text: `No tool named ${call.name}.`, isError: true };
  }

  try {
    const r = await tool.handler(opts.session, call.input, {
      client: 'orbis-chat',
      surface: 'mcp',
    });
    const latencyMs = Date.now() - started;

    logToolCall(opts.db as any, {
      accountId: opts.accountId,
      client: 'orbis-chat',
      surface,
      tool: call.name,
      ok: !r.isError,
      latencyMs,
      resultCount: r.count,
    });

    const id = (r.structured as any)?.id;
    if (typeof id === 'string' && (call.name === 'remember' || call.name === 'correct')) {
      wrote.push(id);
    }

    steps.push({
      kind: 'tool',
      tool: call.name,
      input: call.input,
      output: r.text.slice(0, 2000),
      latencyMs,
      ok: !r.isError,
    });
    return { id: call.id, name: call.name, text: r.text, isError: r.isError };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = (err as Error).message;
    logToolCall(opts.db as any, {
      accountId: opts.accountId,
      client: 'orbis-chat',
      surface,
      tool: call.name,
      ok: false,
      latencyMs,
      error: message,
    });
    steps.push({ kind: 'tool', tool: call.name, input: call.input, ok: false, output: message, latencyMs });
    return { id: call.id, name: call.name, text: `Tool failed: ${message}`, isError: true };
  }
}
