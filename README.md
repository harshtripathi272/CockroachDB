# Orbis

**One memory. Every agent. Yours.**

Connect once. Every AI tool you use — Claude Code, Codex, Cursor, opencode,
Antigravity, ChatGPT — reads and writes the same memory, through a single MCP
endpoint backed by CockroachDB.

**Live demo:** https://afctmu6tki.execute-api.ap-south-1.amazonaws.com

Built for the [CockroachDB × AWS Hackathon — Build with Agentic Memory](https://cockroachdb-ai.devpost.com/).

---

## The problem, stated honestly

I was already solving this by hand.

My global `CLAUDE.md` is a sixty-line protocol telling Claude Code, Codex and
Hermes how to read and write a shared Obsidian vault: where project context
lives, what is worth writing down, that decisions are append-only, that you must
read a file before overwriting it. Command Code keeps a separate
`.commandcode/taste/taste.md` scoring what it has learned about how I work.
open-second-brain keeps a third copy in `Brain/`.

Three memory systems, three formats, none of them able to see the others, all of
them synced by git and enforced by hope.

That is what Orbis replaces. Not "AI needs memory" in the abstract — the
specific, tedious, already-happening problem of maintaining the same context in
four places because no two tools can share it.

## What it does

- **One endpoint.** `https://your-host/api/mcp`. Every MCP-capable client
  connects to the same URL with a bearer token.
- **Recall by meaning.** Ask "how long do people have to get their money back"
  and find a memory that says "reimbursement within thirty days" — no shared
  vocabulary required.
- **Memory that organises itself.** A consolidation pass turns raw memories into
  a profile and project pages, and every claim links back to the memories it
  came from.
- **Correction that propagates.** Tell it something is wrong and one recursive
  query finds everything derived from it, however many hops away.
- **It asks.** Orbis works out what it does not know about you and raises
  questions — answerable in the console, or by any connected agent mid-task.

---

## Try it

```bash
npm install
npm run db:up          # 3-node CockroachDB in Docker
npm run db:migrate     # schema, indexes, RLS
npm run api            # API + MCP endpoint on :8787
npm run dev            # console on :5173
```

Then connect a client. Create a token in **Setup**, and:

```bash
claude mcp add --transport http orbis http://localhost:8787/api/mcp --header "Authorization: Bearer orb_live_..."
```

Populate it with something real rather than fiction:

```bash
node scripts/import.ts --taste                      # a Command Code taste profile
node scripts/import.ts --vault="<path>" --dry-run   # an Obsidian vault, preview first
npm run dream                                       # consolidate into a profile
```

---

## Requirement coverage

Stated plainly: what is wired and working, and what is not.

### CockroachDB tools — 2 of 4 (2 required)

| Tool | Status |
|---|---|
| **Distributed Vector Indexing** | ✅ **In use.** Two C-SPANN indexes with `vector_cosine_ops`. The console runs `EXPLAIN` live and labels whether the index was chosen, so index use is falsifiable rather than asserted. |
| **Agent Skills Repo** | ✅ **Installed** — 34 skills via `npx skills add cockroachlabs/cockroachdb-skills`. |
| Cloud Managed MCP Server | ❌ **Not wired.** Orbis exposes *its own* MCP server, which is a different thing. Consuming CockroachDB's is not done. |
| ccloud CLI | ❌ Not used. |

### AWS services — 4 in use (1 required)

**Live:** https://afctmu6tki.execute-api.ap-south-1.amazonaws.com

| Service | Status |
|---|---|
| **AWS Lambda** | ✅ Runs the whole application — MCP endpoint, REST API, and the console's static assets. The same `handleHttp` serves local development and production, so there is one routing code path rather than two. |
| **API Gateway (HTTP API)** | ✅ The public front door. Function URLs return 403 for every invocation in this account, even for a minimal function with `NONE` auth — an account-level restriction — so API Gateway is the door. |
| **Secrets Manager** | ✅ Holds the CockroachDB Cloud connection string and CA certificate. Neither is in the function's environment. |
| **S3** | ✅ Deployment artefacts. The bundle exceeds the 50MB inline limit, so it is uploaded to S3 and referenced by key. |
| Bedrock | ⚠️ **Coded, blocked, and no longer needed.** `InvokeModel` returns `ValidationException: Operation not allowed` — a new-account verification gate. Provider selection probes it first on every cold start, so if the account is ever unblocked Bedrock applies itself with no redeploy. |

### What is real, and what is not

**Real, and covered by tests against a live cluster:**
semantic recall, the vector indexes and their query plans, correction
propagation, bitemporal history, serializable retry behaviour under 20-way
contention, row-level security, entity extraction, the MCP wire protocol,
consolidation — and all of it running on the deployed Lambda, not only locally.

**Absent:**

- **No LLM anywhere.** Consolidation and entity extraction are deterministic by
  design, not by limitation (see below). There is no chat feature.
- **Nothing is simulated.** The one thing that was — keyword-only search on the
  deployed copy — is fixed, and how is worth reading.

### The deployed demo is semantic without Bedrock

The first deployment fell back to keyword-only matching, because the on-device
embedder was excluded from the bundle on the assumption that onnxruntime plus
transformers is ~350MB. That is true only of the unpruned tree:

| | Before | After |
|---|---|---|
| onnxruntime binaries | 211MB (win32 + darwin + linux) | **53MB** (linux/x64 only) |
| model weights | 87MB (fp32) | **22MB** (q8) |
| sharp binaries | win32 only — *fails on Lambda* | linux/x64 |

Quantizing costs nothing measurable: 5/5 top-1 retrieval either way, a margin to
the runner-up of 0.165 against 0.166, an unchanged dedupe corridor, and it runs
marginally faster. Lambda's real ceiling is 250MB *unzipped* when the package is
delivered via S3 — only direct upload is capped at 50MB. The result is 59MB
zipped, and the live endpoint reports:

```json
"embedder": { "id": "local:all-MiniLM-L6-v2", "semantic": true }
```

Verified end to end against the deployed URL: *"how long do people have to get
their money back"* matches a memory reading *"reimbursement within thirty days"*
in 90ms, sharing no vocabulary at all.

`ORBIS_EMBEDDER` is deliberately left unset. Pinning it to `bedrock` was what
caused the degradation in the first place — selection then tried exactly one
provider and had nothing to fall through to but the lexical stub.

---

## Three things that were measured, not assumed

Each of these changed the implementation.

### 1. The on-device model beat the cloud model, and the bigger local model

Bedrock being blocked forced a local fallback: MiniLM-L6-v2 running on CPU
through ONNX. It turns out to be genuinely semantic —

```
"reimbursement policy"  ↔  "refund rules"        0.660   no shared vocabulary
"prefers TypeScript"    ↔  "statically typed"    0.479
"prefers TypeScript"    ↔  "cat named Biscuit"   0.041
```

The obvious upgrade is `bge-small-en-v1.5`, which produces higher absolute
similarity scores and looks better at a glance. Measured on the same corpus it
is worse where it counts:

| | top-1 correct | mean margin to runner-up | load time |
|---|---|---|---|
| MiniLM-L6-v2 | **5/5** | **0.166** | 0.5s |
| bge-small-en-v1.5 | 4/5 | 0.094 | 9.4s |

Absolute score is cosmetic. The gap between the right answer and the runner-up
is what makes recall trustworthy. **Bedrock is now an upgrade path, not a
dependency** — which is a better architecture than the one originally planned.

### 2. Two clauses silently disqualify a CockroachDB vector index

Both return correct-looking rows. Only `EXPLAIN` tells you.

```sql
-- Looks like harmless defensive filtering. Drops the index entirely.
AND m.embedding IS NOT NULL

-- Leaving a nullable trailing prefix column unconstrained also drops it,
-- so "search everywhere" needs its own index.
WHERE account_id = $1 AND status = $2   -- workspace_id unconstrained
```

Bisected against a real 800-row table:

| Query shape | Plan |
|---|---|
| scoped, no `IS NOT NULL` | ✅ `vector search · memory_recall_idx` |
| scoped, with `IS NOT NULL` | ❌ full scan |
| unscoped, no global index | ❌ full scan |
| unscoped, with global index | ✅ `vector search · memory_recall_global_idx` |

There is a test that asserts the *failure* case still fails, so if CockroachDB
ever fixes it, the suite tells us the workaround can go.

### 3. Enabling row-level security is not the same as enforcing it

Policies were written, applied, and enforced nothing. Two default exemptions:
`root` carries `rolbypassrls`, and the table owner is exempt without
`FORCE ROW LEVEL SECURITY`. A connection scoped to a random account id still saw
every row.

After adding a least-privilege `orbis_app` role and forcing RLS:

| Connection | Rows visible |
|---|---|
| root, unscoped | 27 (superuser bypass) |
| **orbis_app, unscoped** | **0** — fails closed |
| orbis_app, scoped to own account | 27 |
| orbis_app, scoped to another account | 0 |
| orbis_app, cross-account **write** | **refused by `WITH CHECK`** |

The application still connects as owner and filters by `account_id` explicitly;
switching the runtime role is a configuration change. The policies are proven to
work, and that proof is in the test suite.

---

## Why consolidation has no LLM in it

The obvious way to turn a pile of memories into a profile is to ask a model.
This does not, and the reasons are the same ones that make entity extraction
rule-based:

- **Reproducibility.** Run it twice over unchanged memories and the wiki is
  unchanged. A sampled model would reword your profile every night and there
  would be no way to distinguish a real change from drift.
- **Attribution.** Every sentence is assembled from specific memories, so each
  citation is exact. A model asked to summarise *and* cite will occasionally
  attribute a claim to the wrong source — and a wrong citation is worse than
  none, because it launders a hallucination as evidence.
- **Availability.** No credentials, no network, no cost.

An LLM would write nicer prose. It would not make the profile more true.

The one place judgement is genuinely needed — deciding what Orbis does not know
about you — is done with vector coverage checks, and the thresholds there were
measured too. Filtering each probe by the kind of memory that could satisfy it
took accuracy from 6/9 to 7/9 and false-positives to zero. The threshold then
went *tighter* rather than looser, because the errors are not symmetric: a false
"covered" means Orbis silently believes it knows your job and never asks, while a
false "not covered" costs one click to skip.

---

## Architecture

```
   Claude Code ─┐
   Codex ───────┤
   Cursor ──────┼──▶  /api/mcp  ──▶  orbis-core  ──▶  CockroachDB
   opencode ────┤   Streamable HTTP    memory · graph      vector index
   Antigravity ─┤   bearer auth        wiki · context      RLS · MVCC
   ChatGPT ─────┘                                          audit log
                                            ▲
   console (React) ──▶ /api/console         │
   scripts ──────────▶ /api/v1              │
                                     dream pass (scheduled)
```

**Four layers, one database.** Raw memories, extracted entities and edges,
generated wiki pages with citations, and a personal profile. Systems in this
space typically compose four datastores to get vector search, graph traversal,
provenance and history. Doing it in one is the entire argument for putting agent
memory in a distributed SQL database rather than beside one.

| Table | Role |
|---|---|
| `memory` | raw, vector-indexed, bitemporal |
| `memory_source` | **the lineage edge** — what makes correction propagation possible |
| `entity` / `edge` | the extracted graph |
| `wiki_page` / `wiki_citation` | generated pages and their receipts |
| `interview_question` | what Orbis knows it does not know |
| `tool_call` / `client_connection` | observability, and the Setup page's green light |
| `audit_log` | append-only, written in the same transaction as each change |

### The MCP endpoint

Streamable HTTP, spec `2025-06-18`, with **no SSE at all**. The spec permits
answering POST with `application/json` and GET with `405`, and taking both
options removes streaming entirely. That is honest here — Orbis has no
server-initiated messages — and it keeps the same handler viable behind a
serverless function.

Nine tools, plus `search`/`fetch` aliases in OpenAI's schema so one endpoint also
serves ChatGPT's deep-research path.

Governance lives at the protocol boundary, not in the console: `remember`
refuses a memory with no substance, `search_memory` can never return a retracted
memory, `correct` always reports what it invalidated. Ten agents from four
vendors are held to one standard because the rule is in the endpoint they all
share.

---

## Connecting a client

Every config in the console's Setup page is verified. One correction worth
noting: **`@modelcontextprotocol/server-http-sse` does not exist on npm** — the
registry returns 404. It appears in widely circulated setup tables for Claude
Desktop, Cline and Roo. The real bridge package is `mcp-remote`.

| Client | Where |
|---|---|
| Claude Code | `claude mcp add --transport http` |
| Codex CLI | `~/.codex/config.toml` |
| opencode | `~/.config/opencode/opencode.json`, `type: "remote"` |
| Antigravity | `~/.gemini/config/mcp_config.json` |
| Cursor / Zed / Cline / Roo | standard `mcpServers` |
| Claude Desktop | via `mcp-remote` |
| Hermes Agent | its MCP config — which puts Orbis on Telegram, Discord, Slack and email |
| ChatGPT | Developer mode connector; deep research uses the `search`/`fetch` aliases |

---

## Tests

```bash
npm test                      # against the local 3-node cluster
ORBIS_TARGET=cloud npm test   # against CockroachDB Cloud
```

23 tests. Local: 23 pass. Cloud: 20 pass, 3 skipped — the RLS tests need the
`orbis_app` role, which has no password on Cloud and skips cleanly rather than
pretending to pass.

They run against a real cluster, never a mock. Every property worth testing here
is a property of the database rather than of the TypeScript, and a mock would
only assert that the code calls the functions it calls.

They also honour `ORBIS_TARGET` because of a bug from the previous build: a retry
budget tuned against a 1ms localhost round trip exhausted itself at Cloud's 40ms
and surfaced an error to the caller. **Contention scales with latency, not just
with load,** and testing only against localhost hid it.

One harness note: the suites share a database, so they run with
`--test-concurrency=1`. Run in parallel, one suite deleting rows while another
runs `ANALYZE` shifts the optimizer's row estimate and makes query-plan
assertions flaky — which cost twenty minutes to diagnose as a test bug rather
than a product one.

---

## Prior art

Recorded because building something already solved would waste everyone's time.
**No code from any of these was used.**

| Project | What it contributed |
|---|---|
| [innernet](https://innernet.live) | The shape of the whole thing: one MCP endpoint, memory that follows you across tools, row-level privacy. Orbis is an independent implementation of that idea on CockroachDB. |
| [open-second-brain](https://github.com/itechmeat/open-second-brain) | The "dream pass" — nightly consolidation promoting repeated signals into confirmed preferences with confidence bands. Adopted directly, reimplemented in SQL. |
| [Command Code](https://commandcode.ai) | Taste profiles: confidence-scored preferences learned from accepts and rejects. Orbis imports these. |
| [mem0](https://mem0.ai) | Extraction-first memory. Confirmed storage-and-retrieval is a crowded, solved space. |
| [Zep / Graphiti](https://arxiv.org/abs/2501.13956) | Temporal knowledge graphs — pushed us to treat time as first-class. |

MCP is an open standard; implementing it is independent of any product that also
uses it.

---

## Licence

Apache-2.0. See [LICENSE](LICENSE).

Dependencies: `pg` (MIT), `@huggingface/transformers` (Apache-2.0), AWS SDK
(Apache-2.0), React (MIT), Vite (MIT) — all permissive and compatible.
