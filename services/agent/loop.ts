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
 */

import type { Session } from '../../packages/orbis-core/src/index.ts';
import { logToolCall } from '../../packages/orbis-core/src/index.ts';
import { TOOLS, TOOLS_BY_NAME } from '../mcp/tools.ts';
import type { ToolDef } from '../mcp/tools.ts';
import { providerForModel } from './providers.ts';
import type { Turn, ToolCall, ToolOutcome } from './providers.ts';

/** Hidden ChatGPT aliases are noise here — the model gets the real nine. */
const CHAT_TOOLS: ToolDef[] = TOOLS.filter((t) => !t.hidden);

/**
 * The system prompt.
 *
 * Deliberately short. The tools carry their own descriptions, and the workspace
 * context is loaded by calling `get_context` rather than pasted in here — that
 * way the chat agent discovers the user the same way an external agent does,
 * and a bug in context assembly shows up in both places at once instead of
 * hiding behind a special case.
 */
function systemPrompt(workspaceName: string | null): string {
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
    'Answer in plain prose. Cite what you retrieved rather than restating it at length.',
  ].join('\n');
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

  const turns: Turn[] = [...opts.history];
  const steps: AgentStep[] = [];
  const wrote: string[] = [];
  const usage = { in: 0, out: 0 };
  let text = '';

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await provider.complete({
      model: opts.model,
      system: systemPrompt(opts.workspaceName ?? null),
      turns,
      tools: CHAT_TOOLS,
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
      res.toolCalls.map((call) => execute(call, opts, steps, wrote)),
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
  opts: Parameters<typeof runAgent>[0],
  steps: AgentStep[],
  wrote: string[],
): Promise<ToolOutcome> {
  const tool = TOOLS_BY_NAME.get(call.name);
  const started = Date.now();

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
      surface: 'console',
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
      surface: 'console',
      tool: call.name,
      ok: false,
      latencyMs,
      error: message,
    });
    steps.push({ kind: 'tool', tool: call.name, input: call.input, ok: false, output: message, latencyMs });
    return { id: call.id, name: call.name, text: `Tool failed: ${message}`, isError: true };
  }
}
