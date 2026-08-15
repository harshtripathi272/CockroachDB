# Recall — governable agent memory

**A product recall for your AI's memory.** When a belief turns out to be defective,
recall every decision it shipped into.

Built for the [CockroachDB × AWS Hackathon — Build with Agentic Memory](https://cockroachdb-ai.devpost.com/).

---

## The problem

Agent memory today is **unauditable and unrecoverable**.

When an agent does something wrong, three questions have no answer:

1. **Why did it do that?** Nothing records which facts drove which action.
2. **What else did that wrong fact touch?** No lineage, so no way to trace it.
3. **How do I undo it?** No way to unwind the damage.

This is not hypothetical. In 2024 an airline was held liable by a tribunal for a
refund policy its support chatbot had invented. The company argued the bot's
statement wasn't binding, and lost. It had no way to ask *"who else did we tell
this to?"*

The 2026 survey of 21 agent-memory frameworks found the same gap across the
board: the leading systems have **no lineage and no governance**. That gap needs
ACID transactions, MVCC and RBAC — which is exactly what a distributed SQL
database has, and what a vector store structurally cannot fake.

## What Recall does

- **Every belief is typed and provenanced.** Where it came from, how confident we
  are, and what evidence backs it.
- **Every action commits atomically with the beliefs that caused it.** One
  serializable transaction carries the decision, its lineage, the memory
  mutation and the external side effect. If the effect can never be delivered,
  the memory of it rolls back. The record cannot disagree with reality.
- **When a belief is falsified, one query finds everything it contaminated** —
  transitively, including decisions built on beliefs the agent inferred from
  earlier contaminated decisions. Then you revert them.
- **It keeps working when a node dies.** Because the memory is a real
  distributed database, not a sidecar.

## The two things a vector database cannot do

**1. Commit memory and action together**

```sql
BEGIN;
  INSERT INTO decision (...);              -- what the agent did
  INSERT INTO decision_input (...);        -- the exact belief versions it used
  UPDATE belief SET confidence = ...;      -- the memory mutation
  INSERT INTO effect_outbox (...);         -- the real-world side effect, as intent
COMMIT;
```

mem0, Zep, Pinecone and Weaviate have no cross-record atomicity, so the first
statement can succeed while the last one fails. The agent then believes it did
something the world never saw.

**2. Trace contamination transitively**

```sql
WITH RECURSIVE
edges (src_kind, src_id, dst_kind, dst_id) AS (
    SELECT 'belief', di.belief_id, 'decision', di.decision_id
      FROM decision_input di WHERE di.tenant_id = $1
  UNION ALL
    SELECT 'decision', b.derived_from_decision, 'belief', b.id
      FROM belief b WHERE b.tenant_id = $1 AND b.derived_from_decision IS NOT NULL
),
taint (kind, id, hops) AS (
    SELECT 'belief', $2::UUID, 0
  UNION
    SELECT e.dst_kind, e.dst_id, t.hops + 1
      FROM taint t JOIN edges e ON e.src_kind = t.kind AND e.src_id = t.id
     WHERE t.hops < 32
)
SELECT d.*, (t.hops - 1) // 2 AS generation FROM taint t JOIN decision d ...;
```

A vector store cannot answer this question at all — it never stored the edge.

On the demo dataset this traces **5 contaminated decisions across 2 generations,
$9,870 of exposure, in 23 ms**.

## Architecture

```
                 ┌──────────────────────────────────────────┐
   Bedrock ──────│  agent            console (React + Vite)  │
   (Claude +     │    │                        │             │
    Titan V2)    │    └────────┬───────────────┘             │
                 │             │  recall-core                │
                 │             │  remember / recall / decide │
                 │             │  retract / trace / revert   │
                 └─────────────┼───────────────--------------┘
                               │
              ┌────────────────┴─────────────────┐
              │                                  │
     CockroachDB Cloud Basic            local 3-node cluster
     (Managed MCP Server,               (chaos demo — Basic is
      hosted demo)                       serverless, no nodes to kill)
              │
              └── changefeed ──▶ API Gateway ──▶ Lambda (consolidator)
                                                      │
                                                      └──▶ S3 (evidence)
```

### Schema

| Table | Role |
|---|---|
| `belief` | typed, provenanced, bitemporal, vector-indexed |
| `decision` | what the agent did |
| `decision_input` | **the lineage edge** — pins the exact belief *version* consumed |
| `effect_outbox` | external effects, committed as intent in the same transaction |
| `scratch` | working memory that expires itself via row-level TTL |
| `audit_log` | append-only record of every memory mutation |

## Requirement coverage

Stated honestly — what is wired and working today, versus what is not.

**CockroachDB tools — 2 of 4 in use** (2 required)

| Tool | Status |
|---|---|
| Distributed Vector Indexing | ✅ **In use.** `belief_recall_idx ON belief (tenant_id, status, kind, embedding vector_cosine_ops)` — filtered ANN. The console runs `EXPLAIN` live so index use is verifiable, not asserted. |
| Agent Skills Repo | ✅ **Installed** (34 skills, `npx skills add cockroachlabs/cockroachdb-skills`). |
| Cloud Managed MCP Server | ⚠️ **Not yet wired.** Recall exposes *its own* MCP server (see above), which is a different thing — we do not yet consume CockroachDB's. |
| ccloud CLI | ⚠️ **Not yet used.** |

**AWS services — 0 working** (1 required)

| Service | Status |
|---|---|
| Bedrock (Titan embeddings + Claude reasoning) | ⚠️ **Coded, not working.** Every `InvokeModel` returns `ValidationException: Operation not allowed` — an account-level first-invoke gate. The app probes at startup and degrades to a deterministic embedder and policy engine, so nothing breaks, but semantic ranking and LLM reasoning are currently simulated. |
| S3 (evidence artifacts) | ❌ Not implemented. `source_ref` values are illustrative paths. |
| Lambda / API Gateway (changefeed consolidation) | ❌ Not implemented. |
| EC2/ECS (3-node cluster for the chaos demo) | ❌ Runs locally in Docker, not deployed. |

### What is simulated

Being explicit, because a demo that hides this is worse than one that admits it:

- **Embeddings** fall back to a deterministic hash when Bedrock is unavailable.
  The vector index, its query plan and the prefix filtering are all real; the
  vectors themselves are not semantic in that mode.
- **Agent reasoning** falls back to a deterministic policy engine. That engine is
  also the reference implementation for decision replay, which has to be
  reproducible — a sampled model is not.
- **Outbox delivery** logs rather than calling a payment or mail provider.

Everything else — the schema, transactions, lineage, blast radius, retry
handling, TTL, time travel, replica placement and the node-failure behaviour —
runs against a real CockroachDB cluster and is covered by the test suite.


## Connect any agent to it (MCP)

Recall speaks [Model Context Protocol](https://modelcontextprotocol.io), so any
MCP-capable agent — Claude Code, Cursor, Cline — can share the same memory:

```bash
claude mcp add recall -- node services/mcp/server.ts
```

Or use the checked-in `.mcp.json`, which Claude Code picks up automatically.

Six tools: `recall_search`, `recall_remember`, `recall_decide`,
`recall_trace_blast_radius`, `recall_retract`, `recall_timeline`.

The reason this matters is not memory sharing — plenty of products do that. It is
that **the governance rules live at the protocol boundary, not inside one app**:

- `recall_remember` refuses a belief with no provenance
- `recall_decide` refuses an action that cites no beliefs
- `recall_search` never returns quarantined or retracted beliefs

So ten agents from four different vendors writing to the same memory are all held
to one audit standard, and a single `recall_trace_blast_radius` call covers all of
them. An application-level guarantee cannot do that.

Driven end to end from an external agent, this is the whole product in six calls:

```
1) store a belief (provenance mandatory)      -> fc198e4e, confidence 0.9
2) record an action citing it                 -> f7da7c76, committed
3) agent generalises from its own action      -> a595fcff  (this is how drift starts)
4) a second action driven by that inference   -> 237377a2
5) the original belief turns out to be FALSE  -> "2 past decisions used this belief"
6) blast radius                               -> gen 0: approve_upgrade (7740)
                                                 gen 1: approve_upgrade (9004)
7) still searchable?                          -> no
```

## Running it

```bash
npm install
npm run db:up          # 3-node CockroachDB in Docker
npm run db:migrate     # schema
npm run seed           # the Northwind Air scenario
npm run api            # API on :8787
npm run dev            # console on :5173
```

Prove the resilience claim:

```bash
npm run chaos:kill     # docker kill one node — the console stays green
```

Run the tests:

```bash
npm test
```

The suite honours `RECALL_TARGET`, so it runs against either cluster:

```bash
RECALL_TARGET=cloud npm test
```

## What we learned about CockroachDB

Three things cost real debugging time, and all three **fail silently**:

1. **Vector index operator class must match the query operator.** Creating an
   index without an explicit opclass defaults to `vector_l2_ops`; a `<=>` cosine
   query then ignores it and full-scans with no error or warning. Only `EXPLAIN`
   reveals it.
2. **Any filter on a non-prefix column also silently forces a full scan.** We
   filter `status = 'active'` on every read so the agent never retrieves a
   quarantined belief, which meant `status` had to move into the index prefix.
   Trailing prefix columns *may* be left unconstrained, so one index still
   serves both search-within-a-kind and search-across-all-kinds.
3. **The optimizer ignores the vector index at low row counts.** At 3 rows it
   full-scans regardless; at 600 rows (after `ANALYZE`) it picks the vector
   search. Benchmarking on a small table gives a misleading plan.

Also worth documenting: `gc.ttlseconds` is pinned to **4500s (1h15m)** on Cloud
Basic and is not user-configurable, so `AS OF SYSTEM TIME` can only rewind ~75
minutes. Recall therefore keeps an explicit bitemporal history
(`valid_from`/`valid_to`) for the durable record and uses MVCC time travel only
as a fast path inside that window. And mutual recursion between two CTEs is not
permitted — both hop types have to be flattened into a single edge relation.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
