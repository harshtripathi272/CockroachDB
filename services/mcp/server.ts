/**
 * Recall MCP server — governable agent memory, exposed over Model Context Protocol.
 *
 * Any MCP-capable agent (Claude Code, Cursor, Cline, …) can connect and share the
 * same memory. The point is not just sharing, though — it is that the governance
 * rules live at the *protocol boundary*, not inside one application:
 *
 *   - `recall_remember` refuses a belief with no provenance.
 *   - `recall_decide` refuses an action that cites no beliefs.
 *   - `recall_search` never returns quarantined or retracted beliefs.
 *
 * So ten agents from four vendors writing to this memory are all held to the same
 * audit standard, and one `recall_trace_blast_radius` call covers all of them.
 * That is something an application-level guarantee cannot give you.
 *
 * Transport is stdio with newline-delimited JSON-RPC 2.0.
 *
 * IMPORTANT: stdout is the protocol channel. Nothing may be written to it except
 * JSON-RPC messages — a stray console.log corrupts the stream. All diagnostics go
 * to stderr.
 *
 *   claude mcp add recall -- node services/mcp/server.ts
 */
import { createInterface } from 'node:readline';
import { Db, FakeEmbedder, BedrockEmbedder, Recall, type Embedder } from '../../packages/recall-core/src/index.ts';
import { loadEnv, resolveConnectionString, TENANT_ID } from '../../scripts/env.ts';

loadEnv();

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const log = (...args: unknown[]) => console.error('[recall-mcp]', ...args);

const db = new Db({
  connectionString: resolveConnectionString(process.env.RECALL_TARGET ?? 'local'),
  applicationName: 'recall-mcp',
});

async function makeEmbedder(): Promise<Embedder> {
  const bedrock = new BedrockEmbedder({
    region: process.env.AWS_REGION ?? 'ap-south-1',
    modelId: process.env.BEDROCK_EMBED_MODEL,
  });
  try {
    await bedrock.embed('probe');
    log('embeddings: Bedrock Titan');
    return bedrock;
  } catch {
    log('embeddings: deterministic fallback (Bedrock unavailable)');
    return new FakeEmbedder();
  }
}

const recall = new Recall({
  db,
  embedder: await makeEmbedder(),
  // Every write through MCP is attributed to the connecting agent, so the audit
  // log distinguishes "Claude Code wrote this" from "the console wrote this".
  actor: process.env.RECALL_MCP_ACTOR ?? 'mcp-client@unknown',
});

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, never>) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'recall_search',
    title: 'Search memory',
    description:
      'Semantic search over the agent memory. Returns only ACTIVE beliefs — ' +
      'quarantined and retracted ones are excluded by the database index, so a ' +
      'belief that has been proven false can never come back through this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, in natural language' },
        kinds: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['episodic', 'semantic', 'procedural', 'assumption', 'entity', 'preference'],
          },
          description: 'Optional: restrict to these belief kinds',
        },
        limit: { type: 'number', description: 'Max results (default 8)' },
      },
      required: ['query'],
    },
    handler: async (a) => {
      const args = a as unknown as { query: string; kinds?: string[]; limit?: number };
      const hits = await recall.recall({
        tenantId: TENANT_ID,
        text: args.query,
        kinds: args.kinds as never,
        limit: args.limit ?? 8,
      });
      return {
        count: hits.length,
        beliefs: hits.map((b) => ({
          id: b.id,
          kind: b.kind,
          subject: b.subject,
          claim: b.claim,
          confidence: b.confidence,
          source: b.sourceKind,
          distance: b.distance,
        })),
      };
    },
  },

  {
    name: 'recall_remember',
    title: 'Store a belief',
    description:
      'Store something the agent now believes. Provenance is mandatory: every ' +
      'belief must say where it came from, because a belief with no source cannot ' +
      'be audited later. Use derived_from_decision when this belief is a ' +
      'generalisation from an action the agent took — that edge is what makes ' +
      'contamination traceable if the belief later proves false.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['episodic', 'semantic', 'procedural', 'assumption', 'entity', 'preference'],
        },
        subject: { type: 'string', description: 'What this belief is about' },
        claim: { type: 'string', description: 'The belief itself, in plain words' },
        source_kind: {
          type: 'string',
          enum: ['user', 'tool', 'inference', 'import'],
          description: 'Where this came from. Required — no anonymous beliefs.',
        },
        source_ref: { type: 'string', description: 'Optional pointer to the raw evidence' },
        confidence: { type: 'number', description: '0.0–1.0; defaults by source kind' },
        derived_from_decision: {
          type: 'string',
          description: 'Decision id, if the agent inferred this from its own action',
        },
      },
      required: ['kind', 'subject', 'claim', 'source_kind'],
    },
    handler: async (a) => {
      const args = a as unknown as {
        kind: string; subject: string; claim: string; source_kind: string;
        source_ref?: string; confidence?: number; derived_from_decision?: string;
      };
      const b = await recall.remember({
        tenantId: TENANT_ID,
        kind: args.kind as never,
        subject: args.subject,
        claim: args.claim,
        sourceKind: args.source_kind as never,
        sourceRef: args.source_ref,
        confidence: args.confidence,
        derivedFromDecision: args.derived_from_decision,
      });
      return { id: b.id, subject: b.subject, confidence: b.confidence, status: b.status };
    },
  },

  {
    name: 'recall_decide',
    title: 'Record an action with its cause',
    description:
      'Record something the agent DID, together with the beliefs that caused it. ' +
      'belief_ids may not be empty: an action with no recorded cause is exactly ' +
      'what this system exists to make impossible, and the call will be rejected. ' +
      'The decision, its lineage, the confidence updates and any external effect ' +
      'all commit in a single transaction — so the record can never disagree with ' +
      'what actually happened.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: "e.g. 'approve_refund', 'send_email'" },
        payload: { type: 'object', description: 'Structured details of the action' },
        rationale: { type: 'string', description: 'Why the agent did this' },
        belief_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Beliefs that drove this decision. Must not be empty.',
        },
        effect_kind: {
          type: 'string',
          description: 'Optional external side effect to queue (transactional outbox)',
        },
      },
      required: ['action', 'belief_ids'],
    },
    handler: async (a) => {
      const args = a as unknown as {
        action: string; payload?: Record<string, unknown>; rationale?: string;
        belief_ids: string[]; effect_kind?: string;
      };
      const d = await recall.decide({
        tenantId: TENANT_ID,
        action: args.action,
        payload: args.payload ?? {},
        rationale: args.rationale,
        inputs: (args.belief_ids ?? []).map((id) => ({ beliefId: id, weight: 1 })),
        effect: args.effect_kind
          ? { kind: args.effect_kind, payload: args.payload ?? {} }
          : undefined,
      });
      return { decision_id: d.id, action: d.action, status: d.status, committed_at: d.committedAt };
    },
  },

  {
    name: 'recall_trace_blast_radius',
    title: 'Trace what a false belief contaminated',
    description:
      'Given a belief that has turned out to be false, find every decision it ' +
      'contaminated — transitively, including decisions built on beliefs the agent ' +
      'inferred from earlier contaminated decisions. generation 0 means the belief ' +
      'drove that decision directly; 1+ means downstream. This is the question a ' +
      'vector store cannot answer at all, because it never stored the edge.',
    inputSchema: {
      type: 'object',
      properties: { belief_id: { type: 'string' } },
      required: ['belief_id'],
    },
    handler: async (a) => {
      const args = a as unknown as { belief_id: string };
      const rows = await recall.traceBlastRadius(TENANT_ID, args.belief_id);
      return {
        belief_id: args.belief_id,
        contaminated_count: rows.length,
        decisions: rows.map((d) => ({
          id: d.id,
          action: d.action,
          payload: d.payload,
          rationale: d.rationale,
          generation: Number(d.generation),
          committed_at: d.committedAt,
        })),
      };
    },
  },

  {
    name: 'recall_retract',
    title: 'Mark a belief false',
    description:
      'Mark a belief as false. It immediately stops being returned by search, so ' +
      'no agent can act on it again. This does NOT undo past decisions — call ' +
      'recall_trace_blast_radius to see what it already affected.',
    inputSchema: {
      type: 'object',
      properties: {
        belief_id: { type: 'string' },
        reason: { type: 'string', description: 'Why it is false. Recorded in the audit log.' },
      },
      required: ['belief_id', 'reason'],
    },
    handler: async (a) => {
      const args = a as unknown as { belief_id: string; reason: string };
      await recall.retract(TENANT_ID, args.belief_id, args.reason);
      const blast = await recall.traceBlastRadius(TENANT_ID, args.belief_id);
      return {
        retracted: args.belief_id,
        contaminated_decisions: blast.length,
        note: blast.length
          ? `${blast.length} past decision(s) used this belief. Review them.`
          : 'No committed decision used this belief.',
      };
    },
  },

  {
    name: 'recall_timeline',
    title: 'Read memory as it was',
    description:
      'What did memory contain at a past instant? Within the MVCC garbage-collection ' +
      'window this is answered by AS OF SYSTEM TIME — a true point-in-time read of ' +
      'the whole database with no snapshot infrastructure. Beyond that window it ' +
      'falls back to the bitemporal validity columns. The response says which ' +
      'mechanism answered.',
    inputSchema: {
      type: 'object',
      properties: {
        at: { type: 'string', description: 'ISO timestamp, e.g. 2026-08-14T10:00:00Z' },
        query: { type: 'string', description: 'Optional: what to look for at that time' },
      },
      required: ['at'],
    },
    handler: async (a) => {
      const args = a as unknown as { at: string; query?: string };
      const at = new Date(args.at);
      if (Number.isNaN(at.getTime())) throw new Error(`invalid timestamp: ${args.at}`);

      const withinGc = db.isWithinGcWindow(at);
      const beliefs = await recall.recall({
        tenantId: TENANT_ID,
        text: args.query ?? '',
        asOf: at,
        limit: 20,
      });
      return {
        at: at.toISOString(),
        mechanism: withinGc ? 'AS OF SYSTEM TIME' : 'bitemporal validity columns',
        count: beliefs.length,
        beliefs: beliefs.map((b) => ({
          id: b.id, subject: b.subject, claim: b.claim, status: b.status,
        })),
      };
    },
  },
];

/* -------------------------------------------------------------------------- */
/* JSON-RPC plumbing                                                           */
/* -------------------------------------------------------------------------- */

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: string | number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: string | number, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handle(req: RpcRequest): Promise<void> {
  // Notifications carry no id and must not be answered.
  if (req.id === undefined) return;
  const id = req.id;

  switch (req.method) {
    case 'initialize': {
      const asked = (req.params?.protocolVersion as string) ?? PROTOCOL_VERSION;
      // Echo the client's version when we support it, else offer our latest.
      const agreed = SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION;
      reply(id, {
        protocolVersion: agreed,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'recall', title: 'Recall — governable agent memory', version: '0.1.0' },
        instructions:
          'This memory layer is auditable. Every belief you store must declare where it ' +
          'came from, and every action you record must cite the beliefs that caused it — ' +
          'calls that omit either are rejected. If you learn that something you stored is ' +
          'false, call recall_retract and then recall_trace_blast_radius to see what it ' +
          'already affected.',
      });
      return;
    }

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
          name, title, description, inputSchema,
        })),
      });
      return;

    case 'tools/call': {
      const name = req.params?.name as string;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        replyError(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      try {
        const out = await tool.handler((req.params?.arguments ?? {}) as Record<string, never>);
        const text = JSON.stringify(out, null, 2);
        // structuredContent for clients that use it; the text block is the
        // backwards-compatible mirror the spec asks for.
        reply(id, { content: [{ type: 'text', text }], structuredContent: out, isError: false });
      } catch (err) {
        // A rejected write is a *business* outcome, not a transport failure, so
        // it comes back as isError rather than a JSON-RPC error. The agent needs
        // to read the reason and correct itself.
        const message = (err as Error).message;
        log(`tool ${name} failed:`, message);
        reply(id, { content: [{ type: 'text', text: `Refused: ${message}` }], isError: true });
      }
      return;
    }

    default:
      replyError(id, -32601, `Method not found: ${req.method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: RpcRequest;
  try {
    req = JSON.parse(trimmed) as RpcRequest;
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  void handle(req).catch((e) => {
    log('handler crashed:', e);
    if (req.id !== undefined) replyError(req.id, -32603, 'Internal error');
  });
});

rl.on('close', () => {
  void db.close().finally(() => process.exit(0));
});

log(`ready — ${TOOLS.length} tools, target ${process.env.RECALL_TARGET ?? 'local'}`);
