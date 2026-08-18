# One memory, every agent: building Orbis on CockroachDB and AWS

*How a sixty-line protocol file I was maintaining by hand became a distributed
memory system with a brain — built in five days for the CockroachDB × AWS
"Build with Agentic Memory" hackathon.*

**Live demo:** https://afctmu6tki.execute-api.ap-south-1.amazonaws.com
**Source:** https://github.com/harshtripathi272/CockroachDB

<!-- ────────────────────────────────────────────────────────────────────── -->

> **📸 SCREENSHOT 1 — the hero.**
> The console's **connect** page, light theme, desktop width, with at least one
> client showing as connected (Claude Code shows up if you've connected it).
> This is the first image people see — make the browser window clean, no
> devtools, no bookmarks bar if you can.

![The Orbis console](screenshots/01-connect.png)

---

## The problem I was already solving by hand

Every AI coding tool I use keeps its own memory, and none of them can read the
others'.

My global `CLAUDE.md` is a sixty-line protocol telling Claude Code how to read
and write a shared Obsidian vault: where project context lives, what's worth
writing down, that decisions are append-only, that you must read a file before
overwriting it. Command Code keeps a separate taste profile in
`.commandcode/taste/taste.md`. open-second-brain keeps a third copy in
`Brain/`. Codex gets the same vault protocol pasted into its own config.

Three memory systems, three formats, none of them aware of the others, all of
them synced by git and enforced by hope. Every new tool I adopt starts from
zero and has to be taught who I am — again.

That's the specific, tedious, *already-happening* problem Orbis replaces. Not
"AI needs memory" in the abstract. The concrete one: I tell Claude Code that my
Obsidian vault has a space in its path and must always be quoted, and an hour
later Codex breaks on exactly that, because knowledge that lives in one tool's
config is invisible to every other tool.

## What Orbis is

One MCP endpoint. Every agent you use — Claude Code, Codex, Cursor, opencode,
ChatGPT — connects to the same URL with a bearer token, and from that moment
they read and write the same memory:

```bash
claude mcp add --transport http orbis https://your-host/api/mcp \
  --header "Authorization: Bearer orb_live_..."
```

Behind that endpoint sits CockroachDB, holding memories, the entities extracted
from them, wiki pages derived from them, and a full audit trail of which client
read or wrote what, when. In front of it sits a console where you can watch all
of it happen.

> **📸 SCREENSHOT 2 — memory recall by meaning.**
> The **memories** page with the search box filled with *"how long do people
> have to get their money back"* and the result showing the memory about
> *reimbursement within thirty days*. The point of the shot: the query and the
> result share no vocabulary.

![Search by meaning, not keywords](screenshots/02-semantic-search.png)

---

## The architecture: a serverless request path and a serverful brain

The two halves of the system have opposite shapes, and forcing either into the
other's shape was the biggest design mistake I made and then unmade during the
week.

**The request path is serverless.** An MCP tool call is a stateless
request/response round trip: an agent asks, the database answers, the
connection ends. AWS Lambda is the right shape for that — it scales to zero
between requests and scales out under load without anything to manage. The
whole application — MCP endpoint, REST API, the console and its static assets —
is one Lambda behind API Gateway, running the *same* `handleHttp` function that
serves local development, so there is exactly one routing code path to get
right.

**The thinking is not serverless, and pretending otherwise was the flaw.** A
memory system that only organises itself while someone is watching is a search
index with extra steps. The consolidation pass — promote repeated observations
into preferences, merge duplicate entities, rewrite the profile, work out what
the system still doesn't know about you — existed from day two, but as a script
somebody had to run. The fix is **the brain**: a long-running worker
(`services/brain/worker.ts`) that stays up and wakes for two reasons:

1. **A write happened.** A CockroachDB **changefeed** on the `memory` table
   streams every insert and update as it commits. That's a rangefeed pushed by
   the database, not a poll — the brain reacts within seconds of a memory
   landing, debounced per account so an agent saving six things in a row
   causes one consolidation pass, not six.
2. **Time passed.** A full sweep every fifteen minutes, so nothing can stay
   permanently unconsolidated even if a changefeed event is missed.

```
  agents (Claude Code, Cursor, ChatGPT, Telegram…)
      │  MCP over HTTPS, bearer token
      ▼
  API Gateway ──► Lambda (MCP + REST + console)          AWS, serverless
      │                          │
      │ SQL (TLS, Secrets Mgr)   │ EXPLAIN / cluster introspection
      ▼                          ▼
  CockroachDB Cloud ◄──── managed MCP server (cockroachlabs.cloud/mcp)
      │
      │ CHANGEFEED (the database pushes commits)
      ▼
  the brain — long-running worker: consolidate, merge, fade
```

The changefeed is the one piece here that a dedicated vector database
genuinely cannot offer — Pinecone has no transaction log to tail. It's also
why the brain can't live on Lambda: a core changefeed is a query that never
returns, and a 60-second execution ceiling cannot hold one open. The request
path stays serverless; only the thinking moved.

> **📸 SCREENSHOT 3 — the brain reacting to a write.**
> A terminal running `npm run brain`, showing the log lines: `changefeed open —
> reacting to writes as they commit`, then a `· a memory changed ·`
> consolidation line a few seconds after you save a memory from another window.
> Dark terminal, readable font size.

![The brain waking on a changefeed event](screenshots/03-brain-changefeed.png)

---

## Agentic memory design — what "production-grade" means here

*(Judging criterion 1: a meaningful production-grade role beyond toy queries.)*

Memory in Orbis is not a pile of embeddings. It has structure, lifecycle, and
provenance:

**Memories carry status, confidence and history.** A memory is `active`,
`superseded` or `retracted` — never silently deleted. The table is bitemporal
(`valid_from` / `valid_to`), so "what did the system believe last Tuesday" is a
query, not a shrug.

**Correction propagates.** Tell Orbis one memory is wrong and a single
recursive query walks the derivation graph — the wiki pages citing it, the
entities extracted from it, the memories written on top of it, however many
hops away — and shows you the fallout before anything changes. The daily
scratch table uses CockroachDB **row-level TTL**, so genuinely ephemeral notes
expire at the database layer with no cron job to forget about.

**It knows what it doesn't know.** Consolidation generates *interview
questions* — gaps in the profile, ranked by how often adjacent topics come up.
You can answer them in the console, or any connected agent can ask them
mid-conversation.

**Forgetting is opt-in and gentle.** With fading enabled (off by default — a
memory system that quietly discards things has to be *asked* to), a memory
nobody has touched in thirty days loses a little confidence per pass, down to
a floor. It stops surfacing in ordinary recall but an explicit search still
finds it: forgetting where you put something is human, having it destroyed is
not.

**Every claim is cited.** The profile page and project pages are generated
documents where each claim links back to the memories it came from — click
through and check, rather than trust.

> **📸 SCREENSHOT 4 — the profile as a wiki article.**
> The **about you** page, showing the generated article with its table of
> contents on the right and at least one citation marker visible. This is the
> "what a brand-new chat gets handed" shot.

![A profile with receipts](screenshots/04-profile-wiki.png)

> **📸 SCREENSHOT 5 — correction fallout.**
> Open any memory in **memories**, click through to its trace/correct view so
> the derived pages and entities are listed. The shot should show one memory at
> the top and the things that would be affected below it.

![What happens if this memory is wrong](screenshots/05-correction-trace.png)

---

## Technological implementation — the parts that had to be measured

*(Judging criterion 2: quality software engineering, using tools safely.)*

### The vector index is falsifiable, not asserted

Recall runs on two **C-SPANN vector indexes** with `vector_cosine_ops` — a
composite one prefixed by `(account_id, workspace_id, status)` for scoped
search and a global one for cross-workspace recall. Claiming "we use the vector
index" is easy; the console instead runs `EXPLAIN` on the live query and shows
you the plan, labelled with whether a `vector search` node was chosen. During
testing this caught a real regression: an innocuous `IS NOT NULL` predicate
disqualified the index and silently degraded every search to a scan. There is
now a test that asserts that exact failure *still fails*, so nobody
reintroduces it believing it's harmless.

> **📸 SCREENSHOT 6 — the live query plan.**
> The **activity** page's CockroachDB panel (or the plans view) showing the
> EXPLAIN output with the `vector search` line visible, index name
> `memory_recall_global_idx` in the shot.

![EXPLAIN, run live against the deployed cluster](screenshots/06-explain-plan.png)

### The embeddings story: the local model won, and I can prove it

Bedrock on a fresh account returns `ValidationException: Operation not
allowed` — a verification gate, not a code problem. The honest options were to
fake it or to route around it, so Orbis embeds **on-device**: MiniLM-L6-v2,
quantized to 22MB, running on CPU through ONNX inside the Lambda bundle.

Then I benchmarked it against the obvious "better" model, and the numbers were
a surprise worth keeping:

| | top-1 correct | margin to runner-up | load time |
|---|---|---|---|
| MiniLM-L6-v2 (q8, 22MB) | **5/5** | **0.166** | 0.5s |
| bge-small-en-v1.5 | 4/5 | 0.094 | 9.4s |

bge produces higher absolute similarity scores — and worse *decisions*. The
gap between the right answer and the runner-up is what makes recall
trustworthy, and MiniLM's gap is nearly double. Absolute score is cosmetic.

Provider selection still probes Bedrock first on every cold start, so the
moment the account is unblocked, Titan embeddings apply themselves with no
redeploy. The deployed health endpoint states all of this rather than hiding
it:

```json
"embedder": {
  "id": "local:all-MiniLM-L6-v2",
  "semantic": true,
  "rejected": [{ "id": "bedrock:titan-embed-text-v2", "error": "Operation not allowed" }]
}
```

### ACID where memory meets action

Memory writes and their side effects — the evidence counter, the entity graph,
the audit row — commit in one serializable transaction. The test suite proves
it the unpleasant way: twenty concurrent writers hammering the same memory
under `SERIALIZABLE`, with retry-on-conflict, and the evidence count comes out
exactly right. On a vector database bolted to a separate metadata store, that
count is eventually wrong by construction.

### MCP, implemented twice, from the spec

Orbis is an MCP **server** (the endpoint agents connect to) and an MCP
**client** (it connects out to CockroachDB Cloud's managed MCP server — more
below). Both are hand-written implementations of Streamable HTTP from the
2025-06-18 spec, and they are tested *against each other* over a real socket:
handshake, `tools/list`, `tools/call`, error taxonomy, session headers. Two
independently written sides of the same protocol agreeing is a much stronger
test than either side agreeing with itself.

---

## Both directions of MCP — the creative bet

*(Judging criterion 5: creativity and originality.)*

Most hackathon entries will use MCP in one direction: expose tools, let an
agent call them. Orbis completes the loop. It **consumes CockroachDB Cloud's
managed MCP server as a client** — the same protocol, pointed the other way —
so the chat agent can ask *the cluster about itself* in the same turn it asks
*memory about you*: node liveness, schemas, running queries, and `EXPLAIN`
plans run by CockroachDB's own tooling rather than self-reported.

The integration is deliberately paranoid. The Cloud server will happily
register `insert_rows`, `update_rows` and `delete_rows` for a service account
with the roles for them; Orbis filters to an **enumerated read-only
allowlist** in code — not the server's own `readOnlyHint` metadata — because
the blast radius of a chat agent should never depend on a remote server's
annotations being right. A chat agent that can be talked into `delete_rows`
on a production cluster is not a feature.

> **📸 SCREENSHOT 7 — the Cloud MCP panel.**
> **activity → Cloud MCP** showing the live handshake: server name
> `cockroachdb-cloud`, protocol `2025-06-18`, and the tool list with the
> allowed/read-only markers. Take this one *after* granting the service
> account its cluster role, so the panel shows tools instead of the diagnosis.

![Orbis as an MCP client of CockroachDB Cloud](screenshots/07-cloud-mcp.png)

The other creative surface is reach: a **Telegram bot** runs the same tool
layer, so something noted on a phone during a walk is in Claude Code an hour
later — and the console's **ask** tab is itself just another MCP client that
happens to render in a browser, writing with `client: 'orbis-chat'` and
showing its tool trace under every reply.

> **📸 SCREENSHOT 8 — ask, with its work shown.**
> The **ask** page with a question answered and the tool-trace expanded under
> the reply, citations visible. If you have an Anthropic key configured, use a
> real generative answer; otherwise the retrieval-only banner is itself an
> honest shot worth taking.

![The chat shows which memories it used](screenshots/08-ask-trace.png)

---

## Real-world impact — who this actually helps

*(Judging criterion 3.)*

The problem is not hypothetical, and neither is the data in the demo: the
memories you can browse were **imported from my real systems** — the Obsidian
vault protocol, the Command Code taste profile — through importers that ship
with the repo. Anyone maintaining context across more than one AI tool today
is doing some version of what I was doing, and the population doing that is
every developer who has adopted two of: Claude Code, Cursor, Codex, ChatGPT,
Windsurf, opencode.

The path from demo to daily driver is deliberately short:

- **Self-hosted in five commands** (`db:up`, `db:migrate`, `api`, `dev`, done)
  against a free CockroachDB Cloud cluster and a free-tier Lambda — the entire
  demo runs inside free tiers.
- **Import, don't start over.** `node scripts/import.ts --vault="…"` walks an
  Obsidian vault; `--taste` reads a Command Code profile. `--dry-run` first,
  because a tool that writes 400 memories into your database on the first
  invocation should have to ask.
- **Scoped access per project.** A workspace can be pointed at a single tool
  via a scoped MCP config, so a work agent never sees personal memories.

> **📸 SCREENSHOT 9 — projects.**
> The **projects** page in master-detail: workspace list on the left, one
> project open showing its memories, folders, and the scoped MCP config block.

![Projects keep work and life apart](screenshots/09-projects.png)

---

## Product readiness — secure, observable, scalable, resilient

*(Judging criterion 4, taken clause by clause.)*

### Secure

- **Row-level security** on the CockroachDB tables: tenant isolation is
  enforced by the database, not by remembering to add a `WHERE` clause.
- **Bearer tokens** for every MCP and REST request, stored hashed, revocable
  from the console, with per-token last-used tracking.
- **Secrets stay in Secrets Manager** — the database connection string, CA
  certificate and Cloud API key are fetched at cold start, never baked into
  the function's environment where anyone who can describe the function can
  read them.
- **The public demo is read-only by construction.** Anonymous visitors can
  browse every page; every mutating request without a token gets a 403 and a
  sentence explaining why. The gate is method-based and lives in exactly one
  place, so a route added next month is born closed rather than remembered
  into a list. This exists because the first deployment shipped with dev-mode
  auth bypass enabled and I proved the hole with a curl before a judge could —
  the fix is in the commit history, stated plainly.

> **📸 SCREENSHOT 10 — the read-only demo banner.**
> The live demo URL in a fresh incognito window, showing the "You're looking
> at the public demo" banner above the content. One shot, any page.

![Anyone can look, nobody can touch](screenshots/10-readonly-banner.png)

### Observable

Every tool call from every surface — MCP, REST, chat, Telegram — lands in one
`tool_call` table with client, latency, and outcome. The **activity** page
shows per-client traffic, per-tool p50/p95 latency, and error rates; the
quickest way to check a new connection is genuinely working is to watch
yourself appear in it.

> **📸 SCREENSHOT 11 — activity.**
> The **activity** page with real traffic in it — a few clients, the latency
> table populated. Take it after clicking around the demo so the numbers are
> alive.

![Every read and write, accounted for](screenshots/11-activity.png)

### Scalable

The request path scales the way Lambda scales: to zero when idle, out under
load, no instance to size. The data layer scales the way CockroachDB scales —
it is a distributed SQL database whose entire design premise is horizontal
growth, and the memory table's vector indexes are C-SPANN, built for exactly
this. The brain is the one intentionally serial component (two consolidation
passes racing on the same wiki pages would corrupt them), and it is
per-account serial — accounts consolidate independently, so more users means
more parallelism, not a longer queue.

### Resilient — planned, not hoped

Resilience here means **every dependency has a stated degradation path**, and
the degraded state is labelled in the UI rather than silently worse:

| dependency | when it's gone | what happens |
|---|---|---|
| Bedrock | blocked on this account today | on-device MiniLM, semantic, 5/5 on the benchmark — and the UI says which is running |
| the changefeed | connection drops | the brain backs off, reconnects, and falls back to polling; a 15-minute sweep bounds staleness either way |
| a chat API key | not configured (the demo's state) | retrieval-only answers with citations, and a banner saying no model wrote this |
| a CockroachDB node | killed mid-demo | the 3-node local cluster keeps serving; the chaos script does this on camera |
| the Cloud MCP key | absent or unroled | the panel diagnoses *which* it is — including the subtle case where a valid key has no cluster role and every call fails with a misleading "not found" |

And underneath all of it, the database itself is the resilience story: Orbis's
memory survives a node failure because surviving node failures is what
CockroachDB *is*.

> **📸 SCREENSHOT 12 — the chaos demo (optional but the strongest shot).**
> Terminal split: left pane `docker kill` on one of the three local
> CockroachDB nodes, right pane a loop of Orbis searches continuing to answer.
> If you only capture one terminal shot for the video, make it this one.

![Kill a node, keep remembering](screenshots/12-chaos.png)

---

## What it doesn't do

Honesty compounds, so: consolidation and entity extraction are
**deterministic, not LLM-driven** — by design (they run on every write and
must be cheap, repeatable and explainable), but it's a real limitation for
subtle inference. The Telegram bot needs a token from @BotFather; there's no
hosted instance. Generative chat needs an API key you supply — without one the
demo answers from retrieval alone and says so. Bedrock remains blocked on this
account, coded and waiting. And the brain currently runs as a long-lived
process you start with `npm run brain`; on AWS it belongs on a small
EC2/ECS instance, which is the next infrastructure step, not a hidden gap.

## The stack, in one breath

CockroachDB Cloud (vector indexes, changefeeds, row-level TTL, RLS,
serializable transactions, bitemporal history) · AWS Lambda + API Gateway +
Secrets Manager + S3 · on-device MiniLM-L6-v2 through ONNX · MCP Streamable
HTTP, server *and* client, hand-written · React + Vite console · a Telegram
bot · and a brain that never sleeps for more than fifteen minutes.

*Built solo in five days. The commit history is the honest version of this
post.*
