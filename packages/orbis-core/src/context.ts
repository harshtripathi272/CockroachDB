import type { Db } from './db.ts';
import type { MemoryStore } from './memory.ts';
import type { WorkspaceStore } from './workspace.ts';
import type { Context, InterviewQuestion, Memory } from './types.ts';

/**
 * `get_context` — the call that makes a fresh agent session feel like it
 * already knows you.
 *
 * Every other tool here is a query. This one is the product: an agent calls it
 * once at the start of a session and receives who you are, how you like to
 * work, what the current project is, and what Orbis still does not know about
 * you. Without it, cross-tool memory is just a search box that several
 * applications happen to share.
 *
 * The output is deliberately shaped for a language model rather than for a UI —
 * compact prose and short lists, not a deep object graph. Everything returned
 * lands in the agent's context window, so an extra thousand tokens of
 * scaffolding is a thousand tokens not spent on the user's actual problem.
 */

const MAX_PREFERENCES = 12;
const MAX_RECENT = 10;
const MAX_QUESTIONS = 3;

export class ContextBuilder {
  #db: Db;
  #memories: MemoryStore;
  #workspaces: WorkspaceStore;
  #accountId: string;

  constructor(db: Db, memories: MemoryStore, workspaces: WorkspaceStore, accountId: string) {
    this.#db = db;
    this.#memories = memories;
    this.#workspaces = workspaces;
    this.#accountId = accountId;
  }

  async build(opts: { workspace?: string | null; query?: string } = {}): Promise<Context> {
    const account = await this.#db.one(
      `SELECT display_name, email, traits FROM account WHERE id = $1`,
      [this.#accountId],
    );

    const workspace = opts.workspace
      ? await this.#workspaces.get(opts.workspace)
      : await this.#workspaces.getDefault();

    // Preferences are global rather than per-workspace. How someone likes their
    // code formatted does not change because they switched projects, and
    // scoping them would mean re-learning the same thing in every workspace.
    const preferences = await this.#topPreferences();

    // When the agent supplies what it is about to work on, recall is relevant
    // to that. Without it, fall back to recency — the best available proxy.
    //
    // `status: 'active'` is not optional here. MemoryStore.list defaults to
    // excluding only superseded rows, which is right for the Memories view —
    // seeing a retracted memory struck through is useful there. It is exactly
    // wrong for this path: a retracted memory rendered into session context is
    // handed to the model as current truth, with nothing to signal otherwise.
    const recent = opts.query
      ? await this.#memories.search({
          query: opts.query,
          workspaceId: workspace?.id ?? null,
          limit: MAX_RECENT,
        })
      : await this.#memories.list({
          workspaceId: workspace?.id ?? null,
          status: 'active',
          limit: MAX_RECENT,
        });

    const openQuestions = await this.#openQuestions(workspace?.id ?? null);
    const profile = await this.#profileText();
    const workspaceSummary = workspace ? await this.#workspaceSummary(workspace.id) : '';

    return {
      account: {
        displayName: account?.display_name ?? 'Unknown',
        email: account?.email ?? '',
        traits: account?.traits ?? {},
      },
      profile,
      workspace,
      workspaceSummary,
      preferences,
      recent,
      openQuestions,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Render the context as text for an agent.
   *
   * Ordered most-binding-first. A model that truncates or skims should hit the
   * behavioural instructions before the background reading, because getting the
   * preferences wrong is what a user actually notices.
   */
  render(ctx: Context): string {
    const lines: string[] = [];

    lines.push(`# Who you are working with`);
    lines.push(`${ctx.account.displayName}${ctx.account.email ? ` <${ctx.account.email}>` : ''}`);
    if (ctx.profile) lines.push('', ctx.profile);

    if (ctx.preferences.length) {
      lines.push('', '# How they like to work');
      lines.push('Follow these unless told otherwise in this conversation.');
      for (const p of ctx.preferences) {
        const strength =
          p.evidenceCount > 1 ? ` (observed ${p.evidenceCount}×)` : ' (stated once)';
        lines.push(`- ${p.body}${strength}`);
      }
    }

    if (ctx.workspace) {
      lines.push('', `# Current workspace: ${ctx.workspace.name}`);
      if (ctx.workspace.description) lines.push(ctx.workspace.description);
      if (ctx.workspaceSummary) lines.push(ctx.workspaceSummary);
    }

    if (ctx.recent.length) {
      lines.push('', '# Relevant context');
      for (const m of ctx.recent) {
        lines.push(`- **${m.title}** — ${truncate(m.body, 220)}`);
      }
    }

    if (ctx.openQuestions.length) {
      lines.push('', '# Gaps Orbis has not filled in');
      lines.push(
        'If any of these come up naturally, ask — then record the answer with `remember`. Do not interrogate the user.',
      );
      for (const q of ctx.openQuestions) lines.push(`- ${q.question}`);
    }

    lines.push(
      '',
      '---',
      'Anything durable you learn during this session should be written back with `remember`.',
      'Correct something you find to be wrong with `correct` rather than storing a contradiction.',
    );

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------

  /**
   * Preferences ranked by confidence, but only ones with real support.
   *
   * The 0.4 floor keeps a single offhand remark from being handed to every
   * future agent as a rule. Something said once sits at 0.5 by default and only
   * clears the bar once; twice observed, it is at 0.68 and clearly earned.
   */
  async #topPreferences(): Promise<Memory[]> {
    return this.#memories.list({ kind: 'preference', status: 'active', limit: MAX_PREFERENCES });
  }

  async #openQuestions(workspaceId: string | null): Promise<InterviewQuestion[]> {
    const rows = await this.#db.query(
      `SELECT * FROM interview_question
        WHERE account_id = $1 AND status = 'open'
          AND ($2::UUID IS NULL OR workspace_id = $2 OR workspace_id IS NULL)
        ORDER BY priority DESC, created_at
        LIMIT ${MAX_QUESTIONS}`,
      [this.#accountId, workspaceId],
    );
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      topic: r.topic,
      question: r.question,
      why: r.why ?? '',
      priority: Number(r.priority),
      status: r.status,
      createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    }));
  }

  /** The generated profile page, if the dream pass has produced one. */
  async #profileText(): Promise<string> {
    const row = await this.#db.one(
      `SELECT summary, body_md FROM wiki_page
        WHERE account_id = $1 AND kind = 'profile' ORDER BY generated_at DESC LIMIT 1`,
      [this.#accountId],
    );
    return row?.summary || truncate(row?.body_md ?? '', 900);
  }

  async #workspaceSummary(workspaceId: string): Promise<string> {
    const row = await this.#db.one(
      `SELECT summary, body_md FROM wiki_page
        WHERE account_id = $1 AND workspace_id = $2 AND kind IN ('workspace','project')
        ORDER BY generated_at DESC LIMIT 1`,
      [this.#accountId, workspaceId],
    );
    return row?.summary || truncate(row?.body_md ?? '', 700);
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
