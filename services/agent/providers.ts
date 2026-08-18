/**
 * Chat model providers.
 *
 * The console's Chat tab is a workspace-scoped agent that holds the same nine
 * tools every connected client gets. Which model drives it is a runtime
 * decision, made the same way the embedding provider is chosen: probe what the
 * environment can actually reach, and be explicit about the answer.
 *
 * Three providers, in preference order:
 *
 *   anthropic   ANTHROPIC_API_KEY  — the official SDK, full tool-calling loop
 *   openai      OPENAI_API_KEY     — chat completions with function calling
 *   grounded    always available   — no language model at all
 *
 * The third one is the interesting one and it is not a stub. `grounded` runs
 * the retrieval half of the agent for real: it embeds the question, searches
 * memory, and answers by quoting what it found, with citations. What it cannot
 * do is compose prose or decide to call `remember` on its own, and the UI says
 * exactly that rather than implying a model is present. A demo with no API key
 * still answers questions from memory correctly; it just doesn't write.
 *
 * Everything here speaks one internal shape (`Turn`, `ToolCall`) so the agent
 * loop in loop.ts never branches on provider.
 */

import type { ToolDef } from '../mcp/tools.ts';

// ---------------------------------------------------------------------------
// Wire types — the lowest common denominator across providers
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolOutcome {
  id: string;
  name: string;
  text: string;
  isError?: boolean;
}

/** One conversational turn, provider-independent. */
export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: ToolOutcome[] };

export interface CompletionRequest {
  model: string;
  system: string;
  turns: Turn[];
  tools: ToolDef[];
  maxTokens?: number;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  /** Provider-native assistant content, replayed verbatim on the next request. */
  raw?: unknown;
  stop: 'end' | 'tools' | 'refusal' | 'length';
  usage: { in: number; out: number };
}

export interface ChatModel {
  id: string;
  label: string;
  note: string;
}

export interface ChatProvider {
  id: 'anthropic' | 'openai' | 'grounded';
  label: string;
  /** False for `grounded` — the UI must not imply a model is answering. */
  generative: boolean;
  models: ChatModel[];
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/**
 * Claude, via the official SDK.
 *
 * Two things about the current models drive the shape of this call:
 *
 *  - Thinking is on by default on Opus 5, and `max_tokens` caps thinking *plus*
 *    response text together. A budget sized for the answer alone truncates
 *    mid-sentence, so the ceiling here is generous and effort is 'medium' —
 *    a chat turn over an already-retrieved context does not need deep search.
 *  - `temperature` and `top_p` are rejected outright. There is nothing to tune;
 *    steering happens in the system prompt.
 *
 * `stop_reason: 'refusal'` arrives as a normal 200 with empty content, so it is
 * checked before anything reads `content`.
 */
const ANTHROPIC_MODELS: ChatModel[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Most capable — best at multi-step tool use' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'Faster, near-Opus quality' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'Fastest and cheapest' },
];

function anthropicProvider(apiKey: string): ChatProvider {
  let client: any = null;

  return {
    id: 'anthropic',
    label: 'Anthropic',
    generative: true,
    models: ANTHROPIC_MODELS,

    async complete(req) {
      if (!client) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        client = new Anthropic({ apiKey });
      }

      const messages = req.turns.map((t) => {
        if (t.role === 'user') return { role: 'user' as const, content: t.text };
        if (t.role === 'assistant') {
          // Replay the provider's own content blocks. Reconstructing them from
          // text would drop the tool_use blocks the tool_results refer to, and
          // the API rejects a tool_result whose tool_use is missing.
          return { role: 'assistant' as const, content: (t.raw as any) ?? t.text };
        }
        return {
          role: 'user' as const,
          content: t.results.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.id,
            content: r.text,
            ...(r.isError ? { is_error: true } : {}),
          })),
        };
      });

      const res = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens ?? 8000,
        system: req.system,
        output_config: { effort: 'medium' },
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        messages,
      });

      if (res.stop_reason === 'refusal') {
        return {
          text:
            'The model declined to answer this one. ' +
            (res.stop_details?.explanation ?? 'No explanation was given.'),
          toolCalls: [],
          stop: 'refusal',
          usage: { in: res.usage?.input_tokens ?? 0, out: res.usage?.output_tokens ?? 0 },
        };
      }

      const text = res.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');

      const toolCalls: ToolCall[] = res.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => ({ id: b.id, name: b.name, input: b.input ?? {} }));

      return {
        text,
        toolCalls,
        raw: res.content,
        stop:
          res.stop_reason === 'tool_use' ? 'tools'
          : res.stop_reason === 'max_tokens' ? 'length'
          : 'end',
        usage: { in: res.usage?.input_tokens ?? 0, out: res.usage?.output_tokens ?? 0 },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const OPENAI_MODELS: ChatModel[] = [
  { id: 'gpt-4.1', label: 'GPT-4.1', note: 'Strong general tool use' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', note: 'Faster and cheaper' },
  { id: 'gpt-4o', label: 'GPT-4o', note: 'Previous generation' },
];

/**
 * OpenAI chat completions.
 *
 * No SDK dependency: this is one POST to one endpoint, and the deployment
 * package is already close enough to Lambda's limit that a package earning its
 * place matters. Node 22 has global fetch.
 */
function openaiProvider(apiKey: string): ChatProvider {
  return {
    id: 'openai',
    label: 'OpenAI',
    generative: true,
    models: OPENAI_MODELS,

    async complete(req) {
      const messages: any[] = [{ role: 'system', content: req.system }];
      for (const t of req.turns) {
        if (t.role === 'user') messages.push({ role: 'user', content: t.text });
        else if (t.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: t.text || null,
            ...(t.toolCalls?.length
              ? {
                  tool_calls: t.toolCalls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.input) },
                  })),
                }
              : {}),
          });
        } else {
          for (const r of t.results) {
            messages.push({ role: 'tool', tool_call_id: r.id, content: r.text });
          }
        }
      }

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 4000,
          messages,
          tools: req.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          })),
        }),
      });

      if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as any;
      const choice = body.choices?.[0];
      const msg = choice?.message ?? {};

      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
        id: c.id,
        name: c.function.name,
        input: safeJson(c.function.arguments),
      }));

      return {
        text: msg.content ?? '',
        toolCalls,
        stop:
          choice?.finish_reason === 'tool_calls' ? 'tools'
          : choice?.finish_reason === 'length' ? 'length'
          : 'end',
        usage: {
          in: body.usage?.prompt_tokens ?? 0,
          out: body.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s ?? '{}');
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Grounded — no model
// ---------------------------------------------------------------------------

/**
 * Retrieval without generation.
 *
 * This provider never invents a sentence. It answers by running `search_memory`
 * and quoting the matches, and it is honest in the UI about being extractive.
 * That makes the Chat tab useful with zero credentials — you can ask "what do
 * you know about my deploy process" and get the right memories back — while
 * making it obvious that no model wrote the reply.
 *
 * It emits exactly one tool call on the first pass and then formats whatever
 * came back, so the same loop in loop.ts drives it unchanged.
 */
function groundedProvider(): ChatProvider {
  return {
    id: 'grounded',
    label: 'Retrieval only',
    generative: false,
    models: [
      {
        id: 'grounded',
        label: 'Memory search (no model)',
        note: 'Answers by quoting your memories. No language model configured.',
      },
    ],

    async complete(req) {
      const last = [...req.turns].reverse().find((t) => t.role === 'user') as
        | { role: 'user'; text: string }
        | undefined;
      const question = last?.text ?? '';

      // Second pass: the search has run, so format its output.
      const toolTurn = [...req.turns].reverse().find((t) => t.role === 'tool') as
        | { role: 'tool'; results: ToolOutcome[] }
        | undefined;

      if (toolTurn) {
        const found = toolTurn.results.map((r) => r.text).join('\n\n').trim();

        if (!found || /^Nothing in memory matches/i.test(found)) {
          return {
            text:
              'Nothing in memory matches that yet. Add a memory, or connect one of your ' +
              'agents so it can write what it learns.',
            toolCalls: [],
            stop: 'end',
            usage: { in: 0, out: 0 },
          };
        }

        // The search tool flags a weak best match by leading with its own
        // caveat. Repeating "here is what your memory holds" above that would
        // contradict it, so the lead-in is dropped and the tool's wording
        // stands on its own.
        const weak = /^No memory closely matches/i.test(found);
        const lead = weak ? '' : 'Here is what your memory holds on that:\n\n';

        return {
          text:
            `${lead}${found}\n\n` +
            '_Retrieval only — these are your own stored memories, quoted verbatim. ' +
            'Connect a model in Setup for a written answer._',
          toolCalls: [],
          stop: 'end',
          usage: { in: 0, out: 0 },
        };
      }

      return {
        text: '',
        toolCalls: [
          {
            id: `grounded-${Date.now()}`,
            name: 'search_memory',
            // `tight` matters more here than for a model-driven client. A model
            // handed a long ranked list picks the relevant rows out of it; this
            // provider quotes whatever it is given, so the filtering has to
            // happen before the text is assembled.
            input: { query: question, limit: 6, tight: true },
          },
        ],
        stop: 'tools',
        usage: { in: 0, out: 0 },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ProviderChoice {
  providers: ChatProvider[];
  /** Model id chosen when the caller does not name one. */
  defaultModel: string;
  /** Why this is the default — surfaced in the UI, same as the embedder. */
  reason: string;
}

let cached: ProviderChoice | null = null;

export function selectChatProviders(): ProviderChoice {
  if (cached) return cached;

  const providers: ChatProvider[] = [];
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();

  if (anthropicKey) providers.push(anthropicProvider(anthropicKey));
  if (openaiKey) providers.push(openaiProvider(openaiKey));
  providers.push(groundedProvider());

  const generative = providers.find((p) => p.generative);
  cached = {
    providers,
    defaultModel: generative ? generative.models[0].id : 'grounded',
    reason: generative
      ? `${generative.label} key found — the chat agent can use every Orbis tool.`
      : 'No ANTHROPIC_API_KEY or OPENAI_API_KEY set. Chat runs in retrieval-only mode: ' +
        'it searches your memory and quotes what it finds, but writes nothing itself.',
  };
  return cached;
}

/** Reset the cache — used by tests that manipulate env. */
export function resetChatProviders(): void {
  cached = null;
}

export function providerForModel(modelId: string): ChatProvider | null {
  const { providers } = selectChatProviders();
  return providers.find((p) => p.models.some((m) => m.id === modelId)) ?? null;
}

export function allModels(): Array<ChatModel & { provider: string; generative: boolean }> {
  return selectChatProviders().providers.flatMap((p) =>
    p.models.map((m) => ({ ...m, provider: p.label, generative: p.generative })),
  );
}
