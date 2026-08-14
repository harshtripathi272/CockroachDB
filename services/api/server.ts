/**
 * Recall API.
 *
 * Deliberately plain node:http with a small router rather than a framework:
 * the handler signature stays trivially wrappable for AWS Lambda behind API
 * Gateway, which is how this is deployed (and keeps it inside the free tier).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Db, FakeEmbedder, BedrockEmbedder, Recall, type Embedder } from '../../packages/recall-core/src/index.ts';
import { loadEnv, resolveConnectionString, TENANT_ID } from '../../scripts/env.ts';
import { SupportAgent } from '../../apps/agent/agent.ts';
import { BedrockReasoner, PolicyReasoner, type Reasoner } from '../../apps/agent/reasoner.ts';

loadEnv();

const PORT = Number(process.env.PORT ?? 8787);
const TARGET = process.env.RECALL_TARGET ?? 'local';

const db = new Db({
  connectionString: resolveConnectionString(TARGET),
  applicationName: 'recall-api',
});

/**
 * Bedrock when it actually works, deterministic fake otherwise.
 *
 * Deliberately not gated on `AWS_ACCESS_KEY_ID` being set: the SDK's default
 * credential chain also reads ~/.aws/credentials, IAM roles and SSO, so
 * checking env vars would report "no credentials" on a perfectly configured
 * machine. The only honest test is to make a real call.
 *
 * The probe runs once at startup and the result is cached. A blocked model must
 * not take the whole console down -- the governance and lineage features have
 * nothing to do with embeddings, and they are the point of the product.
 */
async function makeEmbedder(): Promise<Embedder> {
  const region = process.env.AWS_REGION ?? 'ap-south-1';
  const bedrock = new BedrockEmbedder({ region, modelId: process.env.BEDROCK_EMBED_MODEL });

  try {
    await bedrock.embed('recall startup probe');
    console.log(`[recall] Bedrock embeddings live (${region})`);
    return bedrock;
  } catch (err) {
    const e = err as Error;
    console.warn(
      `[recall] Bedrock unavailable (${e.name}: ${e.message.slice(0, 120)})\n` +
      `[recall] falling back to deterministic FakeEmbedder — lineage, blast radius\n` +
      `[recall] and governance are unaffected; only semantic ranking is degraded.`,
    );
    return new FakeEmbedder();
  }
}

const recall = new Recall({
  db,
  embedder: await makeEmbedder(),
  actor: 'recall-console@v1',
});

/**
 * Claude via Bedrock when it is reachable, deterministic policy engine
 * otherwise. Probed the same way as the embedder -- by making a real call,
 * not by guessing from environment variables.
 *
 * The deterministic reasoner is not merely a fallback: decision replay has to
 * be reproducible, and a sampled model is not.
 */
async function makeReasoner(): Promise<Reasoner> {
  const region = process.env.AWS_REGION ?? 'ap-south-1';
  const modelId = process.env.BEDROCK_CHAT_MODEL ?? 'apac.anthropic.claude-3-5-sonnet-20241022-v2:0';
  const bedrock = new BedrockReasoner(region, modelId);

  try {
    await bedrock.decide('ping', []);
    console.log(`[recall] agent reasoning on ${modelId}`);
    return bedrock;
  } catch (err) {
    console.warn(
      `[recall] Bedrock reasoning unavailable (${(err as Error).name}) - ` +
      `using deterministic policy engine`,
    );
    return new PolicyReasoner();
  }
}

const agent = new SupportAgent({
  recall,
  reasoner: await makeReasoner(),
  tenantId: TENANT_ID,
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
type Handler = (
  params: Record<string, string>,
  url: URL,
  body: unknown,
) => Promise<unknown>;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$',
  );
  routes.push({ method, pattern, keys, handler });
}

/**
 * Health, for the chaos panel.
 *
 * The authoritative signal is deliberately NOT node topology -- it is whether a
 * real memory read still succeeds, and how long it took. That is the claim this
 * project is actually making: when a node dies, memory keeps answering. A
 * health check that depended on an admin interface would be measuring the wrong
 * thing, and would report "unhealthy" for a cluster that is serving fine.
 *
 * Topology is read opportunistically on top of that. `crdb_internal` is
 * restricted in v26.2+, so it needs `allow_unsafe_internals`, scoped with SET
 * LOCAL to a single transaction so the flag never leaks to a pooled connection
 * that serves user queries. On CockroachDB Cloud Basic it is unavailable
 * entirely (serverless -- there are no nodes to report), and the panel simply
 * renders without it.
 */
route('GET', '/api/health', async () => {
  const started = Date.now();
  let beliefCount = 0;
  let ok = true;
  let error: string | undefined;

  try {
    const [row] = await db.query<{ count: string }>(
      `SELECT count(*)::STRING AS count FROM belief WHERE tenant_id = $1`, [TENANT_ID],
    );
    beliefCount = Number(row.count);
  } catch (e) {
    ok = false;
    error = (e as Error).message;
  }
  const latencyMs = Date.now() - started;

  const nodes = await db
    .inTransaction(async (c) => {
      await c.query('SET LOCAL allow_unsafe_internals = true');
      const { rows } = await c.query<{ node_id: number; is_live: boolean; address: string }>(
        `SELECT node_id, is_live, address FROM crdb_internal.gossip_nodes ORDER BY node_id`,
      );
      return rows;
    })
    .catch(() => [] as Array<{ node_id: number; is_live: boolean; address: string }>);

  return {
    ok,
    error,
    latencyMs,
    target: TARGET,
    topologyAvailable: nodes.length > 0,
    nodes: nodes.map((n) => ({ id: n.node_id, live: n.is_live, address: n.address })),
    liveNodes: nodes.filter((n) => n.is_live).length,
    totalNodes: nodes.length,
    beliefCount,
    at: new Date().toISOString(),
  };
});

route('GET', '/api/beliefs', async (_p, url) => {
  const q = url.searchParams.get('q');
  const status = url.searchParams.get('status');
  const kind = url.searchParams.get('kind');

  // Semantic search when the user typed something, otherwise a plain listing.
  if (q && q.trim().length > 1) {
    const hits = await recall.recall({
      tenantId: TENANT_ID,
      text: q,
      kinds: kind ? [kind as never] : undefined,
      limit: 40,
    });
    return { mode: 'semantic', beliefs: hits };
  }

  const params: unknown[] = [TENANT_ID];
  let filter = '';
  if (status) { params.push(status); filter += ` AND status = $${params.length}`; }
  if (kind) { params.push(kind); filter += ` AND kind = $${params.length}`; }

  const beliefs = await db.query(
    `SELECT id, kind, subject, claim, confidence, status,
            source_kind AS "sourceKind", source_ref AS "sourceRef",
            derived_from_decision AS "derivedFromDecision",
            valid_from AS "validFrom", valid_to AS "validTo"
       FROM belief WHERE tenant_id = $1 ${filter}
      ORDER BY valid_from DESC LIMIT 200`,
    params,
  );
  return { mode: 'list', beliefs };
});

route('GET', '/api/beliefs/:id', async (p) => {
  const [belief] = await db.query(
    `SELECT id, kind, subject, claim, confidence, status,
            source_kind AS "sourceKind", source_ref AS "sourceRef",
            derived_from_decision AS "derivedFromDecision",
            valid_from AS "validFrom", valid_to AS "validTo"
       FROM belief WHERE tenant_id = $1 AND id = $2`,
    [TENANT_ID, p.id],
  );
  if (!belief) throw new HttpError(404, 'belief not found');

  const usedBy = await db.query(
    `SELECT d.id, d.action, d.payload, d.committed_at AS "committedAt",
            d.status, di.weight
       FROM decision_input di
       JOIN decision d ON d.tenant_id = di.tenant_id AND d.id = di.decision_id
      WHERE di.tenant_id = $1 AND di.belief_id = $2
      ORDER BY d.committed_at DESC`,
    [TENANT_ID, p.id],
  );
  return { belief, usedBy };
});

route('GET', '/api/decisions', async (_p, url) => {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 60), 200);
  const decisions = await db.query(
    `SELECT id, action, payload, rationale, status, actor,
            committed_at AS "committedAt", reverted_at AS "revertedAt"
       FROM decision WHERE tenant_id = $1
      ORDER BY committed_at DESC LIMIT $2`,
    [TENANT_ID, limit],
  );
  return { decisions };
});

/** Full causal lineage for one decision: which belief versions drove it. */
route('GET', '/api/decisions/:id/lineage', async (p) => {
  const inputs = await db.query(
    `SELECT b.id, b.kind, b.subject, b.claim, b.status, b.confidence,
            b.source_kind AS "sourceKind", di.weight
       FROM decision_input di
       JOIN belief b ON b.tenant_id = di.tenant_id AND b.id = di.belief_id
      WHERE di.tenant_id = $1 AND di.decision_id = $2
      ORDER BY di.weight DESC NULLS LAST`,
    [TENANT_ID, p.id],
  );
  return { inputs };
});

/** THE endpoint. What did this false belief contaminate? */
route('GET', '/api/blast-radius/:beliefId', async (p) => {
  const started = Date.now();
  const decisions = await recall.traceBlastRadius(TENANT_ID, p.beliefId);
  return {
    beliefId: p.beliefId,
    decisions,
    generations: decisions.length ? Math.max(...decisions.map((d) => Number(d.generation))) + 1 : 0,
    tookMs: Date.now() - started,
  };
});

route('POST', '/api/beliefs/:id/retract', async (p, _u, body) => {
  const reason = (body as { reason?: string })?.reason ?? 'marked false from console';
  await recall.retract(TENANT_ID, p.id, reason);
  return { ok: true };
});

route('POST', '/api/revert', async (_p, _u, body) => {
  const { decisionIds, reason } = (body ?? {}) as { decisionIds?: string[]; reason?: string };
  if (!Array.isArray(decisionIds) || decisionIds.length === 0) {
    throw new HttpError(400, 'decisionIds is required');
  }
  return recall.revert(TENANT_ID, decisionIds, reason ?? 'contaminated');
});

/** Memory as it stood at a past instant. */
route('GET', '/api/timeline', async (_p, url) => {
  const atParam = url.searchParams.get('at');
  if (!atParam) throw new HttpError(400, 'at is required (ISO timestamp)');
  const at = new Date(atParam);

  const withinGc = db.isWithinGcWindow(at);
  const sql = `SELECT id, kind, subject, claim, confidence, status
                 FROM belief AS_OF_PLACEHOLDER
                WHERE tenant_id = $1 ORDER BY valid_from DESC LIMIT 200`;

  const beliefs = withinGc
    ? await db.asOf(at, sql, [TENANT_ID])
    : await db.query(
        `SELECT id, kind, subject, claim, confidence, status
           FROM belief
          WHERE tenant_id = $1 AND valid_from <= $2
            AND (valid_to IS NULL OR valid_to > $2)
          ORDER BY valid_from DESC LIMIT 200`,
        [TENANT_ID, at],
      );

  // Which mechanism answered matters, so the UI can say so honestly.
  return { at: at.toISOString(), mechanism: withinGc ? 'AS OF SYSTEM TIME' : 'bitemporal', beliefs };
});

/**
 * Run the agent live.
 *
 * This is the whole product in one request: recall -> reason -> atomic commit
 * -> optional reflection. The response returns every intermediate step, because
 * the console shows the agent's working rather than just its answer.
 */
route('POST', '/api/agent/handle', async (_p, _u, body) => {
  const { request, reflect } = (body ?? {}) as { request?: string; reflect?: boolean };
  if (!request || request.trim().length < 3) {
    throw new HttpError(400, 'request text is required');
  }
  const result = await agent.handle(request.trim(), { reflect: reflect ?? false });
  return result;
});

/* -------------------------------------------------------------------------
   CockroachDB introspection.

   These endpoints exist so the console can show the database actually doing
   distributed-database work, rather than asking anyone to take it on trust.
   Everything here is read live from the cluster serving the app.
   ------------------------------------------------------------------------- */

/**
 * Range and replica placement.
 *
 * Each range of the memory tables is replicated across nodes, and exactly one
 * replica per range holds the lease and serves reads. When a node dies, its
 * leases move. That movement is the whole resilience claim, made visible.
 *
 * `SHOW RANGES` is a supported statement and needs no unsafe-internals flag.
 * It is unavailable on serverless, where ranges are not the tenant's concern.
 */
route('GET', '/api/crdb/ranges', async () => {
  try {
    const rows = await db.query<{
      range_id: number;
      replicas: number[];
      lease_holder: number;
      start_key: string;
      end_key: string;
    }>(`SELECT range_id, replicas, lease_holder, start_key, end_key
          FROM [SHOW RANGES FROM DATABASE recall WITH DETAILS]
         ORDER BY range_id`);

    const byNode = new Map<number, { replicas: number; leases: number }>();
    for (const r of rows) {
      for (const n of r.replicas ?? []) {
        const e = byNode.get(n) ?? { replicas: 0, leases: 0 };
        e.replicas++;
        byNode.set(n, e);
      }
      if (r.lease_holder != null) {
        const e = byNode.get(r.lease_holder) ?? { replicas: 0, leases: 0 };
        e.leases++;
        byNode.set(r.lease_holder, e);
      }
    }

    return {
      available: true,
      replicationFactor: rows.length ? (rows[0].replicas?.length ?? 0) : 0,
      ranges: rows.map((r) => ({
        id: r.range_id,
        replicas: r.replicas ?? [],
        leaseHolder: r.lease_holder,
        span: `${r.start_key} → ${r.end_key}`,
      })),
      perNode: [...byNode.entries()]
        .map(([node, v]) => ({ node, ...v }))
        .sort((a, b) => a.node - b.node),
    };
  } catch (e) {
    // Serverless (Cloud Basic) does not expose ranges to the tenant.
    return { available: false, reason: (e as Error).message, ranges: [], perNode: [] };
  }
});

/**
 * Live query plans for the queries the product actually runs.
 *
 * The point is falsifiability: anyone can claim their app "uses the vector
 * index". This runs EXPLAIN against the real statement and returns the plan,
 * so you can see `vector search → belief@belief_recall_idx` or catch that it
 * silently degraded to a full scan.
 */
route('GET', '/api/crdb/plans', async () => {
  const [sample] = await db.query<{ embedding: string }>(
    `SELECT embedding::STRING AS embedding FROM belief
      WHERE tenant_id = $1 AND embedding IS NOT NULL LIMIT 1`,
    [TENANT_ID],
  );

  const probes: Array<{ id: string; label: string; why: string; sql: string; params: unknown[] }> = [
    {
      id: 'vector',
      label: 'Semantic recall',
      why: 'Must use the C-SPANN vector index, not a full scan.',
      sql: `SELECT id FROM belief
             WHERE tenant_id = $1 AND status = 'active'
             ORDER BY embedding <=> $2 LIMIT 8`,
      params: [TENANT_ID, sample?.embedding ?? null],
    },
    {
      id: 'lineage',
      label: 'Blast radius (recursive walk)',
      why: 'The contamination trace, over the lineage edge table.',
      sql: `WITH RECURSIVE
            edges (src_kind, src_id, dst_kind, dst_id) AS (
                SELECT 'belief', di.belief_id, 'decision', di.decision_id
                  FROM decision_input di WHERE di.tenant_id = $1::UUID
              UNION ALL
                SELECT 'decision', b.derived_from_decision, 'belief', b.id
                  FROM belief b
                 WHERE b.tenant_id = $1::UUID AND b.derived_from_decision IS NOT NULL
            ),
            taint (kind, id, hops) AS (
                SELECT 'belief', $2::UUID, 0
              UNION
                SELECT e.dst_kind, e.dst_id, t.hops + 1
                  FROM taint t JOIN edges e
                    ON e.src_kind = t.kind AND e.src_id = t.id
                 WHERE t.hops < 32
            )
            SELECT d.id FROM taint t
              JOIN decision d ON d.tenant_id = $1::UUID AND d.id = t.id
             WHERE t.kind = 'decision'`,
      params: [TENANT_ID, TENANT_ID],
    },
  ];

  const plans = [];
  for (const p of probes) {
    if (p.params.some((x) => x === null)) continue;
    try {
      const started = Date.now();
      const rows = await db.query<{ info: string }>(`EXPLAIN ${p.sql}`, p.params);
      const plan = rows.map((r) => r.info).join('\n');
      plans.push({
        id: p.id,
        label: p.label,
        why: p.why,
        sql: p.sql.replace(/\n\s+/g, '\n  ').trim(),
        plan,
        usesVectorIndex: /vector search/i.test(plan),
        fullScan: /table: belief@pk_belief/i.test(plan) && !/vector search/i.test(plan),
        tookMs: Date.now() - started,
      });
    } catch (e) {
      plans.push({ id: p.id, label: p.label, why: p.why, sql: p.sql, plan: `error: ${(e as Error).message}`, usesVectorIndex: false, fullScan: false, tookMs: 0 });
    }
  }
  return { plans };
});

/** The schema, so the console can show what the memory layer actually is. */
route('GET', '/api/crdb/schema', async () => {
  const tables = await db.query<{ table_name: string; estimated_row_count: number }>(
    `SELECT table_name, estimated_row_count
       FROM [SHOW TABLES FROM recall WITH COMMENT]
      ORDER BY table_name`,
  ).catch(() => []);

  const indexes = await db.query<{ index_name: string; column_name: string; seq_in_index: number }>(
    `SELECT index_name, column_name, seq_in_index
       FROM [SHOW INDEXES FROM belief] ORDER BY index_name, seq_in_index`,
  ).catch(() => []);

  const vectorIdx = indexes.filter((i) => i.index_name === 'belief_recall_idx');

  return {
    tables,
    vectorIndex: {
      name: 'belief_recall_idx',
      columns: vectorIdx.map((i) => i.column_name),
      definition:
        'CREATE VECTOR INDEX belief_recall_idx ON belief (tenant_id, status, kind, embedding vector_cosine_ops)',
    },
  };
});

route('GET', '/api/audit', async (_p, url) => {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const entries = await db.query(
    `SELECT id, at, actor, operation, target_kind AS "targetKind",
            target_id AS "targetId", detail
       FROM audit_log WHERE tenant_id = $1 ORDER BY at DESC LIMIT $2`,
    [TENANT_ID, limit],
  );
  return { entries };
});

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;

    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const result = await r.handler(params, url, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[recall]', err);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`recall api  ->  http://localhost:${PORT}  (target: ${TARGET})`);
});
