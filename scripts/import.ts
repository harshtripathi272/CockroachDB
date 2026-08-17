#!/usr/bin/env node
/**
 * Import from memory systems that already exist.
 *
 * Almost everyone doing this seriously already has something: a Command Code
 * taste profile, an open-second-brain `Brain/` folder, an Obsidian vault with a
 * hand-written protocol telling agents how to use it. All of them are markdown
 * on a disk that no other tool can see.
 *
 * That is the honest version of the pitch. Orbis is not asking anyone to start
 * over — it is asking to be the shared, queryable layer underneath what they
 * are already maintaining by hand.
 *
 *   node scripts/import.ts --taste                       .commandcode/taste
 *   node scripts/import.ts --brain=<path>                open-second-brain
 *   node scripts/import.ts --vault="<path>" --dry-run    Obsidian
 *
 * --dry-run prints exactly what would be stored and writes nothing. It is the
 * default posture for anything pointed at a personal vault: showing someone
 * their own notes reformatted is a much better way to earn a real run than
 * asking them to trust it first.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, relative, extname } from 'node:path';
import { Orbis } from '../packages/orbis-core/src/index.ts';
import type { Session } from '../packages/orbis-core/src/index.ts';
import { loadEnv, resolveConnectionString, ROOT } from './env.mjs';

loadEnv();

const argv = process.argv.slice(2);
const arg = (n: string, d = '') => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const flag = (n: string) => argv.includes(`--${n}`);

const DRY = flag('dry-run');
const target = arg('target', process.env.ORBIS_TARGET ?? 'local');

interface Candidate {
  title: string;
  body: string;
  kind: string;
  confidence: number;
  tags: string[];
  sourceRef: string;
  workspace?: string;
}

// ---------------------------------------------------------------------------
// Command Code — .commandcode/taste/taste.md
// ---------------------------------------------------------------------------

/**
 * Command Code writes a confidence-scored taste profile as bullet points:
 *
 *   - Wants honest status reporting: ... Confidence: 0.85
 *
 * The confidence is already calibrated by the tool that observed it, so it is
 * carried across rather than recomputed. Re-deriving it here would discard the
 * only signal Command Code actually contributes.
 */
function importTaste(dir: string): Candidate[] {
  const out: Candidate[] = [];
  const files = walk(dir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      const m = line.match(/^[-*]\s+(.*?)(?:\s*Confidence:\s*([\d.]+))?\.?$/i);
      if (!m) continue;
      const body = m[1].replace(/\s*Confidence:\s*[\d.]+\.?$/i, '').trim();
      if (body.length < 20) continue;
      if (/^see\s+\[/i.test(body)) continue; // index pointer, not content

      const confidence = m[2] ? Math.min(1, Number(m[2])) : 0.6;
      out.push({
        title: firstClause(body),
        body,
        kind: 'preference',
        confidence,
        tags: ['imported', 'command-code'],
        sourceRef: relative(ROOT, file).replace(/\\/g, '/'),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// open-second-brain — Brain/**/*.md
// ---------------------------------------------------------------------------

/**
 * open-second-brain stores preferences as markdown files with frontmatter
 * carrying status, evidence count and confidence band. Frontmatter is read when
 * present; otherwise the filename becomes the title and the body is the body.
 */
function importBrain(dir: string): Candidate[] {
  const out: Candidate[] = [];
  for (const file of walk(dir).filter((f) => f.endsWith('.md'))) {
    const raw = readFileSync(file, 'utf8');
    const { meta, body } = frontmatter(raw);
    if (body.trim().length < 20) continue;

    const band = String(meta.confidence ?? '').toLowerCase();
    const confidence =
      band === 'high' ? 0.85 : band === 'medium' ? 0.6 : band === 'low' ? 0.35
      : Number(meta.confidence) || 0.6;

    out.push({
      title: String(meta.title ?? basename(file, '.md').replace(/[-_]/g, ' ')),
      body: body.trim().slice(0, 4000),
      kind: /preference|rule/i.test(String(meta.type ?? '')) ? 'preference' : 'fact',
      confidence: Math.min(1, Math.max(0, confidence)),
      tags: ['imported', 'second-brain'],
      sourceRef: file.replace(/\\/g, '/'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Obsidian vault
// ---------------------------------------------------------------------------

/**
 * Obsidian vaults organised as Projects/<name>/{overview,decisions,todo}.md.
 *
 * Each project becomes a workspace. Files are split on `##` headings rather
 * than imported whole, because a 400-line overview stored as one memory is
 * useless to recall — the whole document comes back whatever you asked about.
 * A heading is the author's own statement of where one topic ends.
 *
 * `decisions.md` is append-only by convention, so each entry becomes its own
 * memory of kind `decision`.
 */
function importVault(vaultPath: string): Candidate[] {
  const out: Candidate[] = [];
  const projects = join(vaultPath, 'Projects');
  if (!existsSync(projects)) {
    console.error(`no Projects/ directory under ${vaultPath}`);
    return out;
  }

  for (const project of readdirSync(projects)) {
    const dir = join(projects, project);
    if (!statSync(dir).isDirectory()) continue;

    for (const file of walk(dir).filter((f) => extname(f) === '.md')) {
      const name = basename(file, '.md');
      const text = readFileSync(file, 'utf8');
      const { body } = frontmatter(text);

      const kind =
        name === 'decisions' ? 'decision'
        : name === 'todo' ? 'task'
        : /session/i.test(file) ? 'event'
        : 'fact';

      for (const section of splitSections(body)) {
        if (section.body.trim().length < 40) continue;
        out.push({
          title: section.heading || `${project} · ${name}`,
          body: section.body.trim().slice(0, 4000),
          kind,
          confidence: 0.7,
          tags: ['imported', 'obsidian', project],
          sourceRef: relative(vaultPath, file).replace(/\\/g, '/'),
          workspace: project,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

function walk(dir: string, depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, depth + 1));
    else out.push(full);
  }
  return out;
}

function frontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

function splitSections(text: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  let heading = '';
  let buf: string[] = [];

  const flush = () => {
    if (buf.join('\n').trim()) sections.push({ heading, body: buf.join('\n') });
    buf = [];
  };

  for (const line of text.split('\n')) {
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) { flush(); heading = h[1].trim(); continue; }
    buf.push(line);
  }
  flush();
  return sections.length ? sections : [{ heading: '', body: text }];
}

/**
 * A title from the first clause.
 *
 * Falls back to a word-boundary truncation rather than a hard character cut,
 * because a title ending "…before wo" reads as a bug even though it is only
 * cosmetic.
 */
function firstClause(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const clause = flat.split(/[:.;—(]/)[0].trim();
  if (clause.length > 4 && clause.length <= 72) return clause;

  const words = flat.split(' ');
  let out = '';
  for (const w of words) {
    if ((`${out} ${w}`).trim().length > 68) break;
    out = `${out} ${w}`.trim();
  }
  return out || flat.slice(0, 68);
}

// ---------------------------------------------------------------------------

const sources: Array<[string, Candidate[]]> = [];

if (flag('taste')) {
  const dir = arg('taste-path', join(ROOT, '.commandcode'));
  sources.push(['Command Code taste profile', importTaste(dir)]);
}
if (arg('brain')) sources.push(['open-second-brain', importBrain(arg('brain'))]);
if (arg('vault')) sources.push(['Obsidian vault', importVault(arg('vault'))]);

if (sources.length === 0) {
  console.log(`
Nothing selected. Pick a source:

  --taste                     read .commandcode/taste in this repo
  --brain=<path>              an open-second-brain Brain/ directory
  --vault="<path>"            an Obsidian vault containing Projects/

Add --dry-run to see exactly what would be stored without writing anything.
`);
  process.exit(0);
}

const all = sources.flatMap(([, c]) => c);
console.log(`\n${DRY ? 'DRY RUN — nothing will be written' : 'importing'}\n`);
for (const [label, items] of sources) {
  console.log(`  ${String(items.length).padStart(4)}  ${label}`);
}
console.log('');

if (all.length === 0) {
  console.log('nothing found.');
  process.exit(0);
}

if (DRY) {
  for (const c of all.slice(0, 40)) {
    console.log(`  [${c.kind}] ${c.title}`);
    console.log(`      ${c.body.replace(/\s+/g, ' ').slice(0, 130)}`);
    console.log(`      conf ${c.confidence.toFixed(2)}  ${c.workspace ? `ws:${c.workspace}  ` : ''}${c.sourceRef}`);
    console.log('');
  }
  if (all.length > 40) console.log(`  … and ${all.length - 40} more`);
  process.exit(0);
}

const orbis = new Orbis({
  connectionString: resolveConnectionString(target),
  applicationName: 'orbis-import',
  embedder: { preferred: process.env.ORBIS_EMBEDDER, awsRegion: process.env.AWS_REGION },
});
await orbis.ready();

// The configured account first, then whichever holds the most memories.
// Taking the oldest row is wrong as soon as a test account exists, and it
// fails silently by importing someone else's memories into the wrong place.
const acct = await orbis.db.one(
  `SELECT a.id, a.email FROM account a
   LEFT JOIN memory m ON m.account_id = a.id AND m.status = 'active'
   GROUP BY a.id, a.email
   ORDER BY (a.email = $1) DESC, count(m.id) DESC
   LIMIT 1`,
  [arg('account-email', process.env.ORBIS_DEV_EMAIL ?? 'you@orbis.local')],
);
if (!acct) {
  console.error('no account — start the API once first');
  process.exit(1);
}
console.log(`  into ${acct.email}\n`);
const session: Session = orbis.session(acct.id);

// Workspaces named by the import are created on demand, so an Obsidian vault
// with eight projects lands as eight workspaces rather than one heap.
const workspaceIds = new Map<string, string>();
async function workspaceFor(name?: string): Promise<string | null> {
  if (!name) return (await session.workspaces.getDefault())?.id ?? null;
  if (workspaceIds.has(name)) return workspaceIds.get(name)!;
  const ws = await session.workspaces.create({
    name: name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: `Imported from ${sources[0][0]}.`,
  });
  workspaceIds.set(name, ws.id);
  return ws.id;
}

let created = 0;
let reinforced = 0;

for (const [i, c] of all.entries()) {
  const workspaceId = await workspaceFor(c.workspace);
  const r = await session.memories.remember({
    title: c.title,
    body: c.body,
    kind: c.kind as never,
    workspaceId,
    tags: c.tags,
    confidence: c.confidence,
    source: 'import',
    client: 'import',
    sourceRef: c.sourceRef,
  });
  if (r.reinforced) reinforced++;
  else created++;

  // Entity extraction inline rather than fire-and-forget: an import is a batch
  // job with no user waiting, and the process exits when it finishes.
  await session.graph.indexMemory(r.memory.id, `${r.memory.title}\n\n${r.memory.body}`).catch(() => {});
  process.stdout.write(`\r  ${i + 1}/${all.length}`);
}

console.log(`\n\n  ${created} stored, ${reinforced} merged into existing memories\n`);
await new Promise((r) => setTimeout(r, 200));
await orbis.close();
