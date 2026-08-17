import type { Session } from '../../packages/orbis-core/src/index.ts';

/**
 * The tool surface every connected agent sees.
 *
 * Two design rules run through all of it:
 *
 *   Governance lives here, not in the console. Ten agents from four vendors
 *   write to the same memory, so a rule enforced in one application is not a
 *   rule at all. `remember` refuses a memory with no substance; `search` can
 *   never return a retracted memory; `correct` propagates. An agent cannot opt
 *   out of any of it.
 *
 *   Results are prose, not payloads. Everything returned lands in a model's
 *   context window, so a compact readable rendering beats a faithful JSON dump
 *   of every column. Ids are included where the agent will need them for a
 *   follow-up call, and omitted where it will not.
 */

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Hidden from tools/list but still callable — the ChatGPT aliases. */
  hidden?: boolean;
  readOnly?: boolean;
  handler: (session: Session, args: Record<string, any>, ctx: CallContext) => Promise<ToolResult>;
}

export interface CallContext {
  client: string;
  /** Where the call came from, for provenance on anything written. */
  surface: 'mcp' | 'rest';
}

export interface ToolResult {
  text: string;
  /** Machine-readable mirror, for clients that use structured output. */
  structured?: Record<string, unknown>;
  isError?: boolean;
  count?: number;
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({
  type: 'string',
  description,
  ...extra,
});

// ---------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  // -------------------------------------------------------------- get_context
  {
    name: 'get_context',
    title: 'Load who you are working with',
    readOnly: true,
    description:
      'Call this ONCE at the start of a session, before doing anything else. Returns who the ' +
      'user is, how they prefer to work, what project is active, and relevant background. ' +
      'This is what makes you continuous across tools rather than starting cold every time.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: str('Workspace slug or id. Omit for the default workspace.'),
        about: str(
          'What this session is about, if known. Makes the returned context relevant ' +
            'to the task rather than merely recent.',
        ),
      },
    },
    async handler(session, args) {
      const ctx = await session.context.build({
        workspace: args.workspace ?? null,
        query: args.about,
      });
      return {
        text: session.context.render(ctx),
        structured: {
          workspace: ctx.workspace?.slug ?? null,
          preferences: ctx.preferences.length,
          recent: ctx.recent.length,
          openQuestions: ctx.openQuestions.length,
        },
        count: ctx.recent.length,
      };
    },
  },

  // ------------------------------------------------------------ search_memory
  {
    name: 'search_memory',
    title: 'Search memory',
    readOnly: true,
    description:
      'Semantic search across everything the user has ever told any of their agents. ' +
      'Use it whenever you are about to assume something about the user, their projects, ' +
      'or their preferences. Retracted memories are never returned.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('What you want to know, in natural language.'),
        workspace: str('Restrict to one workspace. Omit to search everything.'),
        kind: str('Restrict to one kind of memory.', {
          enum: ['fact', 'preference', 'decision', 'event', 'insight', 'doc', 'task', 'question'],
        }),
        limit: { type: 'integer', description: 'Max results (default 8).', minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
    async handler(session, args) {
      const wsId = await resolveWorkspace(session, args.workspace);
      const hits = await session.memories.search({
        query: args.query,
        workspaceId: wsId,
        kind: args.kind,
        limit: args.limit ?? 8,
      });

      if (hits.length === 0) {
        return { text: `Nothing in memory matches "${args.query}".`, count: 0 };
      }

      const lines = hits.map((h) => {
        const meta = [
          h.kind,
          h.workspaceName,
          h.evidenceCount > 1 ? `seen ${h.evidenceCount}×` : null,
          `via ${h.client}`,
        ]
          .filter(Boolean)
          .join(' · ');
        return `**${h.title}** [${meta}]\n${h.body}\n_id: ${h.id}_`;
      });

      return {
        text: `${hits.length} result${hits.length === 1 ? '' : 's'} for "${args.query}":\n\n${lines.join('\n\n')}`,
        structured: { results: hits.map((h) => ({ id: h.id, title: h.title, score: h.score })) },
        count: hits.length,
      };
    },
  },

  // ----------------------------------------------------------------- remember
  {
    name: 'remember',
    title: 'Store something durable',
    description:
      'Record something worth knowing in a future session, in any tool. Good candidates: a ' +
      'stated preference, a decision and its reasoning, a fact about a project, something ' +
      'that would cost time to rediscover. Do NOT record transient chatter, or anything the ' +
      'user could trivially re-derive. If this contradicts something already stored, use ' +
      '`correct` instead so the history stays honest.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('A short label. One line.'),
        body: str('The memory itself, written so it makes sense with no surrounding conversation.'),
        kind: str('What sort of memory this is.', {
          enum: ['fact', 'preference', 'decision', 'event', 'insight', 'doc', 'task', 'question'],
        }),
        workspace: str('Workspace slug or id. Omit for the default.'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        confidence: {
          type: 'number',
          description: 'How sure you are, 0 to 1. Default 0.6.',
          minimum: 0,
          maximum: 1,
        },
        derived_from: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Memory ids this was inferred from. Supply these whenever you are generalising ' +
            'rather than recording something stated directly — it is what allows a later ' +
            'correction to find and unwind this.',
        },
      },
      required: ['title', 'body'],
    },
    async handler(session, args, ctx) {
      // Governance at the protocol boundary. A memory with no substance is
      // noise that degrades every future recall, and refusing it here means it
      // is refused for every client rather than for whichever ones remembered
      // to check.
      const body = String(args.body ?? '').trim();
      if (body.length < 8) {
        return {
          text: 'Refused: a memory needs an actual body. Store something a future session could use without this conversation.',
          isError: true,
        };
      }
      if (!String(args.title ?? '').trim()) {
        return { text: 'Refused: a memory needs a title.', isError: true };
      }

      const wsId = (await resolveWorkspace(session, args.workspace)) ?? (await defaultWorkspace(session));

      const { memory, reinforced } = await session.memories.remember({
        title: String(args.title).trim(),
        body,
        kind: args.kind ?? 'fact',
        workspaceId: wsId,
        tags: args.tags ?? [],
        confidence: args.confidence ?? 0.6,
        source: ctx.surface === 'rest' ? 'api' : 'mcp',
        client: ctx.client,
        derivedFrom: args.derived_from ?? [],
      });

      // Entity extraction is deliberately not awaited into the response path.
      // It is enrichment; a slow graph write must not make the memory write
      // feel slow, and if it fails the memory is still safely stored.
      void session.graph
        .indexMemory(memory.id, `${memory.title}\n\n${memory.body}`)
        .catch(() => {});

      return {
        text: reinforced
          ? `Already knew this — reinforced instead of duplicating. Now observed ${memory.evidenceCount}× (confidence ${memory.confidence.toFixed(2)}).\nid: ${memory.id}`
          : `Stored.\nid: ${memory.id}`,
        structured: { id: memory.id, reinforced, evidenceCount: memory.evidenceCount },
      };
    },
  },

  // ------------------------------------------------------------------ correct
  {
    name: 'correct',
    title: 'Mark a memory wrong',
    description:
      'Use when something stored turns out to be false or out of date. The old memory is ' +
      'retracted rather than deleted, so the record of what was believed and when survives. ' +
      'Everything derived from it is reported back to you, and any wiki page citing it is ' +
      'flagged for regeneration.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: str('The id of the memory that is wrong.'),
        reason: str('Why it is wrong.'),
        replacement: str('The corrected version, if there is one.'),
      },
      required: ['memory_id'],
    },
    async handler(session, args, ctx) {
      const existing = await session.memories.get(args.memory_id);
      if (!existing) {
        return { text: `No memory with id ${args.memory_id}.`, isError: true };
      }

      // Compute fallout before retracting: afterwards the derived memories are
      // still reachable, but reporting the blast radius as it stood at the
      // moment of correction is the more useful answer.
      const fallout = await session.memories.fallout(args.memory_id);

      const result = await session.memories.correct(args.memory_id, {
        reason: args.reason,
        replacement: args.replacement
          ? {
              title: existing.title,
              body: args.replacement,
              kind: existing.kind,
              workspaceId: existing.workspaceId,
              confidence: 0.75,
              source: 'mcp',
              client: ctx.client,
            }
          : undefined,
      });

      const parts = [`Retracted "${existing.title}".`];
      if (result.replacement) parts.push(`Replaced with a corrected version (${result.replacement.id}).`);

      if (fallout.memories.length) {
        parts.push(
          '',
          `${fallout.memories.length} memor${fallout.memories.length === 1 ? 'y was' : 'ies were'} derived from it and may now be wrong:`,
          ...fallout.memories.map((m) => `  - ${m.title} (${m.hops} hop${m.hops === 1 ? '' : 's'}) — id ${m.id}`),
        );
      }
      if (result.pagesMarkedStale > 0) {
        parts.push('', `${result.pagesMarkedStale} wiki page(s) marked stale.`);
      }
      if (!fallout.memories.length && !result.pagesMarkedStale) {
        parts.push('Nothing else depended on it.');
      }

      return {
        text: parts.join('\n'),
        structured: {
          retracted: args.memory_id,
          replacement: result.replacement?.id ?? null,
          affected: fallout.memories.length,
          pagesStale: result.pagesMarkedStale,
        },
      };
    },
  },

  // ------------------------------------------------------------- trace_impact
  {
    name: 'trace_impact',
    title: 'What was built on this?',
    readOnly: true,
    description:
      'Given a memory, everything that was derived from it, transitively. Use before ' +
      'correcting something to understand the consequences, or to answer "why does Orbis ' +
      'believe that about me?".',
    inputSchema: {
      type: 'object',
      properties: { memory_id: str('The memory to trace from.') },
      required: ['memory_id'],
    },
    async handler(session, args) {
      const root = await session.memories.get(args.memory_id);
      if (!root) return { text: `No memory with id ${args.memory_id}.`, isError: true };

      const f = await session.memories.fallout(args.memory_id);
      const sources = await session.memories.sources(args.memory_id);

      const parts = [`**${root.title}**`, root.body, ''];

      if (sources.length) {
        parts.push('Derived from:', ...sources.map((s) => `  ← ${s.title} (${s.id})`), '');
      }
      if (f.memories.length) {
        parts.push(`${f.memories.length} thing(s) built on top of it:`);
        for (const m of f.memories) parts.push(`  ${'  '.repeat(m.hops - 1)}→ ${m.title} (${m.id})`);
      } else {
        parts.push('Nothing has been derived from it yet.');
      }
      if (f.pages.length) {
        parts.push('', 'Wiki pages citing it:', ...f.pages.map((p) => `  - ${p.title}`));
      }
      parts.push('', `_traced in ${f.tookMs}ms_`);

      return { text: parts.join('\n'), count: f.memories.length };
    },
  },

  // ---------------------------------------------------------- list_workspaces
  {
    name: 'list_workspaces',
    title: 'List workspaces',
    readOnly: true,
    description:
      'The user\'s workspaces. Use this to pick the right one before storing something, ' +
      'rather than dropping everything into the default.',
    inputSchema: { type: 'object', properties: {} },
    async handler(session) {
      const list = await session.workspaces.list();
      if (!list.length) return { text: 'No workspaces yet.', count: 0 };
      return {
        text: list
          .map(
            (w) =>
              `- **${w.name}** (\`${w.slug}\`)${w.isDefault ? ' — default' : ''} — ${w.memoryCount ?? 0} memories${w.description ? `\n  ${w.description}` : ''}`,
          )
          .join('\n'),
        structured: { workspaces: list.map((w) => ({ slug: w.slug, name: w.name })) },
        count: list.length,
      };
    },
  },

  // ---------------------------------------------------------------- wiki_read
  {
    name: 'wiki_read',
    title: 'Read an organised page',
    readOnly: true,
    description:
      'Read a generated page — the profile, a project overview, a topic. These are ' +
      'consolidated from many memories and are the fastest way to get oriented. Omit the ' +
      'slug to list what exists.',
    inputSchema: {
      type: 'object',
      properties: { slug: str('Page slug. Omit to list all pages.') },
    },
    async handler(session, args) {
      if (!args.slug) {
        const pages = await session.wiki.list();
        if (!pages.length) {
          return { text: 'No pages yet — memory has not been consolidated.', count: 0 };
        }
        return {
          text: pages
            .map((p) => `- \`${p.slug}\` — ${p.title}${p.stale ? ' _(stale)_' : ''} (${p.sourceCount} sources)`)
            .join('\n'),
          count: pages.length,
        };
      }

      const page = await session.wiki.get(args.slug);
      if (!page) return { text: `No page \`${args.slug}\`.`, isError: true };

      const parts = [`# ${page.title}`, page.bodyMd];
      if (page.stale) {
        parts.push('', '> This page is stale: a memory it cites was corrected after it was written.');
      }
      if (page.citations?.length) {
        parts.push('', `_Built from ${page.citations.length} memories._`);
      }
      return { text: parts.join('\n'), count: page.citations?.length ?? 0 };
    },
  },

  // ----------------------------------------------------------- interview_next
  {
    name: 'interview_next',
    title: 'Ask what Orbis is missing',
    readOnly: true,
    description:
      'Returns the highest-value question Orbis has about the user. Ask it only if it fits ' +
      'the conversation naturally, then store the answer with `remember`. Never fire these ' +
      'as a questionnaire.',
    inputSchema: {
      type: 'object',
      properties: { workspace: str('Scope to a workspace.') },
    },
    async handler(session, args) {
      const wsId = await resolveWorkspace(session, args.workspace);
      const rows = await session.db.query(
        `SELECT id, question, why, topic FROM interview_question
          WHERE account_id = $1 AND status = 'open'
            AND ($2::UUID IS NULL OR workspace_id = $2 OR workspace_id IS NULL)
          ORDER BY priority DESC, created_at LIMIT 3`,
        [session.accountId, wsId],
      );
      if (!rows.length) return { text: 'Nothing outstanding.', count: 0 };
      return {
        text: rows
          .map((r) => `- ${r.question}${r.why ? `\n  _(${r.why})_` : ''}`)
          .join('\n'),
        count: rows.length,
      };
    },
  },

  // ----------------------------------------------------------------- timeline
  {
    name: 'timeline',
    title: 'Recent activity',
    readOnly: true,
    description:
      'What has been written to memory recently, and by which tool. Useful for "what was I ' +
      'doing yesterday" and for seeing what another agent contributed.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: str('Scope to a workspace.'),
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    async handler(session, args) {
      const wsId = await resolveWorkspace(session, args.workspace);
      const items = await session.memories.list({
        workspaceId: wsId,
        limit: args.limit ?? 15,
      });
      if (!items.length) return { text: 'Nothing recorded yet.', count: 0 };
      return {
        text: items
          .map((m) => `${m.createdAt.slice(0, 16).replace('T', ' ')}  [${m.client}]  ${m.title}`)
          .join('\n'),
        count: items.length,
      };
    },
  },

  // ------------------------------------------------- ChatGPT compatibility
  //
  // ChatGPT's deep-research and company-knowledge paths only ever call two
  // tools, named exactly `search` and `fetch`, with a fixed result shape. These
  // are thin aliases over the real tools so that one endpoint serves ChatGPT as
  // well as every MCP-native client, rather than needing a second deployment.
  {
    name: 'search',
    title: 'Search',
    readOnly: true,
    hidden: true,
    description: 'Search the user’s memory. Returns matching records with ids for `fetch`.',
    inputSchema: {
      type: 'object',
      properties: { query: str('Search query.') },
      required: ['query'],
    },
    async handler(session, args) {
      const hits = await session.memories.search({ query: args.query, limit: 10 });
      const results = hits.map((h) => ({
        id: h.id,
        title: h.title,
        text: h.body.slice(0, 400),
        url: `orbis://memory/${h.id}`,
      }));
      return { text: JSON.stringify({ results }), structured: { results }, count: results.length };
    },
  },
  {
    name: 'fetch',
    title: 'Fetch',
    readOnly: true,
    hidden: true,
    description: 'Retrieve one memory in full by id.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Record id returned by search.') },
      required: ['id'],
    },
    async handler(session, args) {
      const m = await session.memories.get(args.id);
      if (!m) return { text: JSON.stringify({ error: 'not found' }), isError: true };
      const doc = {
        id: m.id,
        title: m.title,
        text: m.body,
        url: `orbis://memory/${m.id}`,
        metadata: {
          kind: m.kind,
          status: m.status,
          confidence: String(m.confidence),
          client: m.client,
          created: m.createdAt,
        },
      };
      return { text: JSON.stringify(doc), structured: doc };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------

async function resolveWorkspace(session: Session, ref?: string | null): Promise<string | null> {
  if (!ref) return null;
  const ws = await session.workspaces.get(ref);
  return ws?.id ?? null;
}

async function defaultWorkspace(session: Session): Promise<string | null> {
  const ws = await session.workspaces.getDefault();
  return ws?.id ?? null;
}
