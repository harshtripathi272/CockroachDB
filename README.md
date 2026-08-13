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

**CockroachDB tools — 4 of 4** (2 required)

| Tool | How it is used |
|---|---|
| Distributed Vector Indexing | `belief_recall_idx ON belief (tenant_id, status, kind, embedding vector_cosine_ops)` — filtered ANN over beliefs |
| Cloud Managed MCP Server | the agent's memory access path; read-only default plus explicit write consent is the governance story |
| ccloud CLI | provisioning, `-o json` health feed, chaos scripting |
| Agent Skills Repo | the agent diagnoses its *own* memory layer using the observability skills |

**AWS services — 4** (1 required): Bedrock (Claude + Titan Text Embeddings V2),
Lambda (changefeed-driven consolidation), S3 (evidence artifacts), EC2/ECS (the
3-node cluster for the resilience demo).

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
