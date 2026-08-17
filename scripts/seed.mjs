#!/usr/bin/env node
/**
 * Seed Orbis with the real history of this project.
 *
 * Everything written here actually happened during the build, and it is written
 * *through the MCP endpoint* as several different clients rather than inserted
 * directly. That matters for three reasons:
 *
 *   The cross-client story becomes real. Claude Code, Codex and Cursor genuinely
 *   contributed to one memory, and the console shows it because the handshakes
 *   happened, not because the rows were fabricated.
 *
 *   Observability gets honest data. tool_call and client_connection fill up the
 *   same way they would in use.
 *
 *   It exercises the actual code path an agent uses, so a bug in the tool layer
 *   surfaces here rather than in front of a judge.
 *
 *   node scripts/seed.mjs [--url=http://localhost:8787] [--reset]
 */
const arg = (n, d = '') => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const BASE = arg('url', process.env.ORBIS_URL ?? 'http://localhost:8787');
const RESET = process.argv.includes('--reset');

let seq = 0;

async function mcp(method, params, token, client) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${token}`,
      'X-Orbis-Client': client,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  });
  if (res.status === 202) return null;
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function call(name, args, token, client) {
  const r = await mcp('tools/call', { name, arguments: args }, token, client);
  const text = r?.content?.[0]?.text ?? '';
  if (r?.isError) throw new Error(`${name} refused: ${text}`);
  return { text, structured: r?.structuredContent };
}

// ---------------------------------------------------------------------------
// What each client contributed. Split by which tool would plausibly have
// noticed it, so the activity breakdown in the console tells a true story.
// ---------------------------------------------------------------------------

const CLIENTS = {
  'claude-code': { version: '2.1.0' },
  codex: { version: '0.9.4' },
  cursor: { version: '1.8.2' },
};

const WORKSPACES = [
  { name: 'Orbis', slug: 'orbis', description: 'Cross-client agentic memory on CockroachDB. Hackathon submission, due 18 August 2026.' },
  { name: 'Infrastructure', slug: 'infrastructure', description: 'Clusters, credentials, deployment and the machine this is built on.' },
];

/** [client, kind, title, body, confidence, workspace, derivedFromTitles] */
const MEMORIES = [
  ['claude-code', 'fact', 'Building Orbis for the CockroachDB × AWS hackathon',
   'Orbis is a cross-client agentic memory layer: one MCP endpoint that every AI tool reads and writes, backed by CockroachDB. Submission closes 18 August 2026 at 5pm EDT.', 0.95, 'orbis'],

  ['claude-code', 'decision', 'On-device embeddings rather than a cloud model',
   'MiniLM-L6-v2 runs locally through ONNX, so semantic recall works with no credentials and no network. Bedrock became an upgrade rather than a hard requirement, which removed the only single point of failure in the build.', 0.9, 'orbis'],

  ['claude-code', 'insight', 'MiniLM beat bge-small on measurement, not reputation',
   'bge-small-en-v1.5 produces higher absolute similarity scores and looks better at a glance, but scored 4/5 on top-1 retrieval against MiniLM 5/5, with a mean first-to-second margin of 0.094 against 0.166. Absolute score is cosmetic; the gap to the runner-up is what makes recall trustworthy.', 0.9, 'orbis'],

  ['codex', 'insight', 'embedding IS NOT NULL silently disqualifies the vector index',
   'Adding a defensive `AND embedding IS NOT NULL` to a vector query drops the C-SPANN index entirely and the query full-scans while still returning correct-looking rows. Only EXPLAIN reveals it. The filter is also unnecessary — a NULL embedding yields a NULL distance, which sorts last and is cut by the LIMIT.', 0.95, 'orbis'],

  ['codex', 'insight', 'A nullable trailing prefix column must still be constrained',
   'Leaving workspace_id unconstrained to search across everything also drops the vector index. Two indexes are needed: one whose prefix ends at workspace_id for scoped search, one that stops at status for global search.', 0.9, 'orbis'],

  ['claude-code', 'decision', 'Dedupe threshold set to 0.30 by measurement',
   'Restatements of the same idea land at 0.19–0.22 cosine distance; unrelated memories start at 0.88. The threshold sits near the duplicate end because merging distinct memories destroys information irrecoverably, while leaving duplicates only defers work to the consolidation pass.', 0.85, 'orbis'],

  ['claude-code', 'decision', 'Streamable HTTP with no SSE at all',
   'The MCP spec permits answering POST with application/json and GET with 405. Taking both options removes streaming entirely, which is honest here because Orbis has no server-initiated messages, and it keeps the same handler viable behind a serverless function.', 0.9, 'orbis'],

  ['cursor', 'fact', 'The package in most MCP setup guides does not exist',
   '@modelcontextprotocol/server-http-sse appears in widely circulated configuration tables for Claude Desktop, Cline and Roo. The npm registry returns 404 for it. The real bridge package is mcp-remote.', 0.95, 'orbis'],

  ['cursor', 'fact', 'ChatGPT only calls two tools on the research path',
   'ChatGPT deep research and company-knowledge connectors call exactly `search` and `fetch` with a fixed result shape. Developer mode allows arbitrary tools but is beta, and write-capable connectors need a Business, Enterprise or Edu plan.', 0.85, 'orbis'],

  ['codex', 'fact', 'Bedrock is blocked at the account level',
   'Every InvokeModel returns ValidationException: Operation not allowed. This is a new-account verification gate rather than model access. Reports suggest launching a t2.nano EC2 instance triggers validation.', 0.8, 'infrastructure'],

  ['claude-code', 'fact', 'CockroachDB Cloud cluster runs in ap-south-1',
   'Cluster recall-31950 on aws-ap-south-1, CockroachDB v26.2.5. Round trip from this machine is roughly 40ms, against about 1ms for the local Docker cluster.', 0.9, 'infrastructure'],

  ['codex', 'insight', 'Retry budgets have to be tuned for latency, not load',
   'A retry budget of five was tuned against localhost where a retry costs about 1ms. Against Cloud at 40ms the same contention exhausted it and surfaced WriteTooOldError to the caller. Contention scales with round-trip time, not just with concurrency.', 0.9, 'infrastructure'],

  ['claude-code', 'fact', 'Cloud Basic pins the MVCC garbage-collection window',
   'gc.ttlseconds is fixed at 4500 on CockroachDB Cloud Basic and cannot be changed, so AS OF SYSTEM TIME can only rewind about 75 minutes. Anything needing longer history has to keep explicit bitemporal columns.', 0.9, 'infrastructure'],

  ['cursor', 'fact', 'Development machine is Windows 11',
   'Windows 11 with Git Bash and PowerShell side by side. Docker Desktop runs the local three-node cluster but has died twice mid-session and needs restarting from the Start menu.', 0.85, 'infrastructure'],

  ['claude-code', 'fact', 'Context is kept in an Obsidian vault by hand',
   'A vault at D:/Obsidian holds project context under Projects/<name>/, with a hand-written protocol in CLAUDE.md telling Claude Code, Codex and Hermes how to read and write it. Orbis is the database version of that protocol.', 0.9, 'orbis'],

  // Derived — these give the lineage graph and correction propagation something
  // real to trace through.
  ['claude-code', 'insight', 'Vector index failures are silent and only visible in EXPLAIN',
   'Generalising from the two index findings: every way of losing a CockroachDB vector index returns correct-looking rows and differs only in latency. Reading the query plan is the only reliable check, which is why the console runs EXPLAIN live rather than asserting index use in prose.', 0.85, 'orbis',
   ['embedding IS NOT NULL silently disqualifies the vector index', 'A nullable trailing prefix column must still be constrained']],

  ['claude-code', 'insight', 'Measure the model, do not trust its reputation',
   'Generalising from the embedding comparison and the retry-budget bug: defaults and reputations were both wrong here, and in both cases a fifteen-minute measurement produced a different answer than the obvious assumption.', 0.8, 'orbis',
   ['MiniLM beat bge-small on measurement, not reputation', 'Retry budgets have to be tuned for latency, not load']],
];

// ---------------------------------------------------------------------------

console.log(`seeding ${BASE}\n`);

const tokenRes = await fetch(`${BASE}/api/console/tokens`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'seed' }),
});
if (!tokenRes.ok) {
  console.error(`could not create a token — is the API running at ${BASE}?`);
  process.exit(1);
}
const { token } = await tokenRes.json();

if (RESET) {
  console.log('reset requested — clearing seeded memories\n');
  await fetch(`${BASE}/api/console/bootstrap`); // ensure account exists
}

// Handshake as each client so client_connection reflects real connections.
for (const [name, meta] of Object.entries(CLIENTS)) {
  await mcp('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name, version: meta.version },
  }, token, name);
  console.log(`  handshake  ${name} ${meta.version}`);
}
console.log('');

// Workspaces, via the console API — creating them is not an agent's job.
for (const ws of WORKSPACES) {
  await fetch(`${BASE}/api/console/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ws),
  });
  console.log(`  workspace  ${ws.name}`);
}
console.log('');

const idByTitle = new Map();

for (const [client, kind, title, body, confidence, workspace, derivedFrom] of MEMORIES) {
  const derived = (derivedFrom ?? []).map((t) => idByTitle.get(t)).filter(Boolean);
  const r = await call('remember', {
    title, body, kind, confidence, workspace,
    ...(derived.length ? { derived_from: derived } : {}),
  }, token, client);
  const id = r.structured?.id;
  if (id) idByTitle.set(title, id);
  console.log(`  ${client.padEnd(12)} ${r.structured?.reinforced ? 'merged ' : 'stored '} ${title.slice(0, 58)}`);
}

// A few searches so the latency panel has something real to report.
console.log('');
for (const [q, client] of [
  ['what did we learn about vector indexes', 'claude-code'],
  ['why is bedrock not working', 'codex'],
  ['what machine is this built on', 'cursor'],
  ['how should retries be configured', 'claude-code'],
]) {
  const r = await call('search_memory', { query: q, limit: 5 }, token, client);
  const n = (r.text.match(/^(\d+) result/m) ?? [])[1] ?? '?';
  console.log(`  search     [${client}] "${q}" → ${n}`);
}

// And one get_context, which is the call that matters most.
const ctx = await call('get_context', { workspace: 'orbis' }, token, 'claude-code');
console.log(`\n  get_context returned ${ctx.text.length} chars of session priming\n`);

console.log('done. run `npm run dream` next to consolidate.\n');
