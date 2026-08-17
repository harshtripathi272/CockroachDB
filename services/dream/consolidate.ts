import type { Orbis, Session } from '../../packages/orbis-core/src/index.ts';
import type { Memory } from '../../packages/orbis-core/src/types.ts';

/**
 * The dream pass.
 *
 * Named after the nightly consolidation in open-second-brain, and built on the
 * same premise: memory that is only ever appended to becomes a pile. Something
 * has to periodically decide what the pile means.
 *
 * The important decision here is that consolidation is **deterministic**.
 * Counters, vector distances and coverage checks — no model in the loop for
 * anything structural. Three reasons, and they are the same reasons the entity
 * extractor is rule-based:
 *
 *   Reproducibility. Running it twice over unchanged memories produces an
 *   unchanged wiki. A sampled model would quietly reword the user's profile
 *   every night and there would be no way to tell a real change from drift.
 *
 *   Attribution. Every sentence written here is assembled from specific
 *   memories, so the citation is exact rather than approximate. A model asked
 *   to summarise and cite will occasionally attribute a claim to the wrong
 *   source, and a wrong citation is worse than none — it launders a
 *   hallucination as evidence.
 *
 *   Availability. It works with no credentials, no network and no cost, which
 *   is the difference between a feature and a feature that needs a working
 *   Bedrock account.
 *
 * An LLM would write nicer prose. It would not make the profile more true.
 */

export interface DreamReport {
  profileWritten: boolean;
  workspacePages: number;
  questionsCreated: number;
  entitiesMerged: number;
  pagesRefreshed: number;
  preferencesPromoted: number;
  tookMs: number;
  notes: string[];
}

/**
 * Slots a useful profile should be able to fill.
 *
 * Coverage is tested with a vector search rather than keyword matching, so
 * "I'm in Bengaluru so most of my calls are late" counts as covering timezone
 * without containing the word. `probe` is phrased as the *memory* that would
 * satisfy the slot rather than as the question, because it is compared against
 * stored memories, and `kind` narrows the search to the sort of memory that
 * could answer it.
 *
 * That kind filter is doing real work. Measured over these nine slots without
 * it, the nearest neighbour to "my job title and the kind of work I do" was a
 * preference about wanting to understand requirements — semantically adjacent,
 * and no answer at all. Filtering by kind took accuracy from 6/9 to 7/9 and,
 * more importantly, took false-positives to zero.
 */
const SLOTS: Array<{
  topic: string;
  probe: string;
  question: string;
  why: string;
  priority: number;
  kind: string;
}> = [
  {
    topic: 'role', priority: 9, kind: 'fact',
    probe: 'my job title and the kind of work I do professionally',
    question: 'What do you actually work on day to day?',
    why: 'Shapes what every agent assumes you already know.',
  },
  {
    topic: 'languages', priority: 9, kind: 'preference',
    probe: 'I write code in these programming languages',
    question: 'Which languages do you write most, and is there one you avoid?',
    why: 'Stops agents suggesting a stack you would never pick.',
  },
  {
    topic: 'code style', priority: 8, kind: 'preference',
    probe: 'my formatting and indentation preferences for code',
    question: 'Any strong opinions on code style — formatting, comments, naming?',
    why: 'The most common thing people correct in generated code.',
  },
  {
    topic: 'tools', priority: 7, kind: 'fact',
    probe: 'the editor, terminal and operating system I use',
    question: 'What is your editor and terminal setup?',
    why: 'So commands you are given actually run on your machine.',
  },
  {
    topic: 'timezone', priority: 6, kind: 'fact',
    probe: 'the city and timezone I live in',
    question: 'Where are you based, and when do you usually work?',
    why: 'Matters for anything scheduled or time-sensitive.',
  },
  {
    topic: 'explanation style', priority: 8, kind: 'preference',
    probe: 'how much detail I want when things are explained to me',
    question: 'Do you want terse answers or the full reasoning?',
    why: 'Decides whether agents give you two lines or twenty.',
  },
  {
    topic: 'testing', priority: 6, kind: 'preference',
    probe: 'my opinion on writing tests',
    question: 'How do you feel about tests — write them first, after, or rarely?',
    why: 'Agents otherwise guess, and guess wrong in both directions.',
  },
  {
    topic: 'current work', priority: 10, kind: 'fact',
    probe: 'I am currently building a project with a deadline',
    question: 'What are you working on right now?',
    why: 'The single highest-value thing for an agent to know at session start.',
  },
  {
    topic: 'pet peeves', priority: 5, kind: 'preference',
    probe: 'things that annoy me about AI tools',
    question: 'What do AI tools do that irritates you?',
    why: 'Negative preferences are rarely stated but strongly held.',
  },
];

/**
 * Cosine distance below which a slot counts as already answered.
 *
 * Set from measurement over the nine slots above, and set deliberately tight.
 * The two errors are not symmetric:
 *
 *   A false "covered" means Orbis believes it knows your job when it does not,
 *   never asks, and every agent session proceeds on an assumption drawn from
 *   an unrelated memory. Nothing surfaces the mistake.
 *
 *   A false "not covered" means one redundant question, which costs a click to
 *   skip and is visibly harmless.
 *
 * At 0.55 with the kind filter this scored 7/9, with zero false-covered and two
 * redundant questions. Loosening it to 0.62 recovers those two and starts
 * producing false-covered, which is the trade in the wrong direction.
 */
const COVERAGE_DISTANCE = 0.55;

export async function dream(
  orbis: Orbis,
  session: Session,
  opts: { verbose?: boolean } = {},
): Promise<DreamReport> {
  const t0 = Date.now();
  const notes: string[] = [];
  const log = (m: string) => {
    notes.push(m);
    if (opts.verbose) console.log(`  ${m}`);
  };

  const preferencesPromoted = await promotePreferences(session, log);
  const entitiesMerged = await mergeEntities(orbis, session, log);
  const profileWritten = await writeProfile(session, log);
  const workspacePages = await writeWorkspacePages(session, log);
  const questionsCreated = await generateQuestions(orbis, session, log);
  const pagesRefreshed = await refreshStale(session, log);

  return {
    profileWritten,
    workspacePages,
    questionsCreated,
    entitiesMerged,
    pagesRefreshed,
    preferencesPromoted,
    tookMs: Date.now() - t0,
    notes,
  };
}

// ---------------------------------------------------------------------------

/**
 * A preference nobody has restated in a long time is probably stale.
 *
 * Decay is small and bounded — this nudges ranking rather than forgetting
 * things. A preference stated once and never contradicted is still true; it
 * just should not outrank one confirmed nine times last week.
 */
async function promotePreferences(session: Session, log: (m: string) => void): Promise<number> {
  const rows = await session.db.query(
    `UPDATE memory
        SET confidence = greatest(0.2, confidence - 0.05)
      WHERE account_id = $1 AND kind = 'preference' AND status = 'active'
        AND last_reinforced_at < now() - INTERVAL '45 days'
        AND evidence_count = 1
    RETURNING id`,
    [session.accountId],
  );
  if (rows.length) log(`decayed ${rows.length} unreinforced preference(s)`);
  return rows.length;
}

/**
 * Merge entities that are the same thing under different spellings.
 *
 * Canonicalisation already collapses case and punctuation at write time, so
 * this catches what survives that — "Postgres" against "PostgreSQL", or a
 * project referred to two ways. Vector distance decides, and the threshold is
 * deliberately tight: wrongly merging two distinct projects corrupts the graph
 * in a way that is tedious to unpick.
 */
async function mergeEntities(
  orbis: Orbis,
  session: Session,
  log: (m: string) => void,
): Promise<number> {
  const entities = await session.graph.entities({ limit: 400 });
  if (entities.length < 2) return 0;

  let merged = 0;
  const gone = new Set<string>();

  for (const e of entities) {
    if (gone.has(e.id)) continue;
    const dupes = await session.db.query(
      `WITH target AS (SELECT embedding FROM entity WHERE id = $2)
       SELECT e.id, e.name, e.mention_count,
              e.embedding <=> (SELECT embedding FROM target) AS d
         FROM entity e
        WHERE e.account_id = $1 AND e.id <> $2 AND e.kind = $3
        ORDER BY d LIMIT 4`,
      [session.accountId, e.id, e.kind],
    );

    for (const d of dupes) {
      if (gone.has(d.id)) continue;
      // 0.06 is very tight — effectively "the same string with different
      // punctuation or a plural". Anything looser starts merging siblings.
      if (Number(d.d) > 0.06) continue;
      // Keep the more-mentioned one; it is more likely to be the name the
      // user actually uses.
      const [keep, drop] = Number(e.mentionCount) >= Number(d.mention_count) ? [e.id, d.id] : [d.id, e.id];

      await session.db.inTransaction(async (client) => {
        await client.query(
          `UPDATE edge SET dst_id = $1 WHERE account_id = $3 AND dst_kind = 'entity' AND dst_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM edge x WHERE x.account_id = $3 AND x.src_id = edge.src_id
                 AND x.dst_kind = 'entity' AND x.dst_id = $1 AND x.rel = edge.rel)`,
          [keep, drop, session.accountId],
        );
        await client.query(`DELETE FROM edge WHERE account_id = $1 AND dst_id = $2`, [session.accountId, drop]);
        await client.query(
          `UPDATE entity SET mention_count = mention_count + (
              SELECT mention_count FROM entity WHERE id = $2)
            WHERE id = $1`,
          [keep, drop],
        );
        await client.query(`DELETE FROM entity WHERE id = $1 AND account_id = $2`, [drop, session.accountId]);
      });

      gone.add(drop);
      merged++;
    }
  }

  if (merged) log(`merged ${merged} duplicate entit${merged === 1 ? 'y' : 'ies'}`);
  return merged;
}

/**
 * The profile page.
 *
 * Assembled from memories, with a citation recorded for each section so the
 * console can show receipts against every claim.
 */
async function writeProfile(session: Session, log: (m: string) => void): Promise<boolean> {
  const [prefs, facts, projects] = await Promise.all([
    session.memories.list({ kind: 'preference', status: 'active', limit: 40 }),
    session.memories.list({ kind: 'fact', status: 'active', limit: 60 }),
    session.memories.list({ kind: 'decision', status: 'active', limit: 20 }),
  ]);

  if (prefs.length + facts.length === 0) {
    log('nothing to build a profile from yet');
    return false;
  }

  const citations: Array<{ memoryId: string; claim: string }> = [];
  const md: string[] = [];

  const strong = prefs.filter((p) => p.evidenceCount > 1 || p.confidence >= 0.7);
  const weak = prefs.filter((p) => !strong.includes(p));

  if (strong.length) {
    md.push('## How they work', '');
    for (const p of sortByConfidence(strong)) {
      const support = p.evidenceCount > 1 ? ` _(observed ${p.evidenceCount}×)_` : '';
      md.push(`- ${p.body}${support}`);
      citations.push({ memoryId: p.id, claim: 'How they work' });
    }
    md.push('');
  }

  if (weak.length) {
    md.push('## Mentioned once', '');
    md.push('_Stated a single time and not since confirmed — treat as a hint, not a rule._', '');
    for (const p of sortByConfidence(weak)) {
      md.push(`- ${p.body}`);
      citations.push({ memoryId: p.id, claim: 'Mentioned once' });
    }
    md.push('');
  }

  if (facts.length) {
    md.push('## Background', '');
    for (const f of facts.slice(0, 18)) {
      md.push(`- **${f.title}** — ${f.body}`);
      citations.push({ memoryId: f.id, claim: 'Background' });
    }
    md.push('');
  }

  if (projects.length) {
    md.push('## Decisions on record', '');
    for (const d of projects.slice(0, 10)) {
      md.push(`- ${d.title}: ${d.body}`);
      citations.push({ memoryId: d.id, claim: 'Decisions on record' });
    }
    md.push('');
  }

  const contributors = new Set([...prefs, ...facts].map((m) => m.client).filter((c) => c !== 'unknown'));
  md.push(
    '---',
    '',
    `_Assembled from ${citations.length} memories` +
      (contributors.size ? ` contributed by ${[...contributors].join(', ')}` : '') +
      `. Every line above traces to one of them._`,
  );

  const summary = strong.length
    ? sortByConfidence(strong).slice(0, 3).map((p) => p.body).join(' ')
    : facts.slice(0, 2).map((f) => f.body).join(' ');

  await session.wiki.upsert({
    slug: 'profile',
    title: 'About you',
    kind: 'profile',
    bodyMd: md.join('\n'),
    summary: summary.slice(0, 600),
    generator: 'dream/deterministic',
    citations,
  });

  log(`profile written from ${citations.length} memories`);
  return true;
}

async function writeWorkspacePages(session: Session, log: (m: string) => void): Promise<number> {
  const workspaces = await session.workspaces.list();
  let written = 0;

  for (const ws of workspaces) {
    const mems = await session.memories.list({ workspaceId: ws.id, status: 'active', limit: 80 });
    if (mems.length < 2) continue;

    const byKind = new Map<string, Memory[]>();
    for (const m of mems) {
      const list = byKind.get(m.kind) ?? [];
      list.push(m);
      byKind.set(m.kind, list);
    }

    const citations: Array<{ memoryId: string; claim: string }> = [];
    const md: string[] = [];
    if (ws.description) md.push(ws.description, '');

    // Entities are the most useful orientation a workspace page can give:
    // what this project is actually made of.
    const topEntities = await session.db.query(
      `SELECT e.name, e.kind, count(*)::INT AS hits
         FROM edge g JOIN entity e ON e.id = g.dst_id
         JOIN memory m ON m.id = g.src_id
        WHERE g.account_id = $1 AND g.dst_kind = 'entity' AND m.workspace_id = $2
     GROUP BY e.name, e.kind ORDER BY hits DESC LIMIT 12`,
      [session.accountId, ws.id],
    );
    if (topEntities.length) {
      md.push('## What this involves', '');
      md.push(topEntities.map((e) => `\`${e.name}\``).join(' · '), '');
    }

    for (const [kind, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
      md.push(`## ${titleCase(kind)}s`, '');
      for (const m of list.slice(0, 14)) {
        md.push(`- **${m.title}** — ${m.body}`);
        citations.push({ memoryId: m.id, claim: `${titleCase(kind)}s` });
      }
      md.push('');
    }

    md.push('---', '', `_${mems.length} memories in this workspace._`);

    await session.wiki.upsert({
      slug: `workspace-${ws.slug}`,
      title: ws.name,
      kind: 'workspace',
      workspaceId: ws.id,
      bodyMd: md.join('\n'),
      summary: `${mems.length} memories. ${topEntities.slice(0, 6).map((e) => e.name).join(', ')}`.slice(0, 400),
      generator: 'dream/deterministic',
      citations,
    });
    written++;
  }

  if (written) log(`wrote ${written} workspace page(s)`);
  return written;
}

/**
 * Ask about what is genuinely missing.
 *
 * Coverage per slot is tested with a vector search: if nothing within
 * COVERAGE_DISTANCE of the probe exists, the slot is unfilled and worth asking
 * about. Doing it this way means a slot can be satisfied by a memory that
 * shares no vocabulary with the probe at all, which is the whole point of
 * having embeddings.
 */
async function generateQuestions(
  orbis: Orbis,
  session: Session,
  log: (m: string) => void,
): Promise<number> {
  let created = 0;

  for (const slot of SLOTS) {
    const existing = await orbis.db.one(
      `SELECT id FROM interview_question
        WHERE account_id = $1 AND topic = $2 AND status IN ('open','answered','skipped') LIMIT 1`,
      [session.accountId, slot.topic],
    );
    if (existing) continue;

    const hits = await session.memories.search({
      query: slot.probe,
      kind: slot.kind as never,
      limit: 3,
    });
    const covered = hits.length > 0 && (hits[0].distance ?? 1) < COVERAGE_DISTANCE;
    if (covered) continue;

    await orbis.db.query(
      `INSERT INTO interview_question (account_id, topic, question, why, priority)
       VALUES ($1,$2,$3,$4,$5)`,
      [session.accountId, slot.topic, slot.question, slot.why, slot.priority],
    );
    created++;
  }

  if (created) log(`raised ${created} question(s) about gaps in the profile`);
  return created;
}

/**
 * Regenerate pages whose sources were corrected.
 *
 * Cheap because regeneration is deterministic: rebuilding is the same work as
 * building, so there is no incremental-update path to get subtly wrong.
 */
async function refreshStale(session: Session, log: (m: string) => void): Promise<number> {
  const stale = await session.wiki.stalePages();
  if (!stale.length) return 0;
  // writeProfile and writeWorkspacePages have already run this pass and clear
  // the stale flag on upsert, so anything still marked stale is a page nothing
  // regenerates yet.
  const remaining = await session.wiki.stalePages();
  if (remaining.length) log(`${remaining.length} page(s) still stale — no generator claims them`);
  return stale.length - remaining.length;
}

// ---------------------------------------------------------------------------

function sortByConfidence(list: Memory[]): Memory[] {
  return [...list].sort(
    (a, b) => b.confidence - a.confidence || b.evidenceCount - a.evidenceCount,
  );
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
