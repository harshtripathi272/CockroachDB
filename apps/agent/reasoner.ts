import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { RecalledBelief } from '../../packages/recall-core/src/index.ts';

/**
 * The reasoning step, behind an interface.
 *
 * Two implementations: Claude via Bedrock, and a deterministic policy engine.
 * The split is not a hedge against Bedrock being unavailable -- it is how the
 * *replay* feature works. Re-running a past decision against corrected memory
 * has to be reproducible, and a sampled LLM is not. The deterministic reasoner
 * is the reference implementation; the model is the production one.
 */

export interface Verdict {
  action: string;
  approve: boolean;
  payload: Record<string, unknown>;
  rationale: string;
  /** Belief ids the reasoner actually relied on, with influence weights. */
  used: Array<{ beliefId: string; weight: number }>;
  reasoner: string;
}

export interface Reasoner {
  name: string;
  decide(request: string, beliefs: RecalledBelief[]): Promise<Verdict>;
}

const SYSTEM = `You are a support operations agent for Northwind Air.

You decide whether to approve customer requests using ONLY the beliefs supplied.
You may not invent policy. If the supplied beliefs do not support a request, deny it.

Reply with JSON only:
{
  "action": "approve_refund" | "waive_change_fee" | "quote_policy" | "deny",
  "approve": boolean,
  "amount_usd": number | null,
  "rationale": "one sentence, citing which belief drove the decision",
  "used_belief_ids": ["<id>", ...]
}

"used_belief_ids" must list every belief you relied on. This is an audit record,
not a formality: it is what lets a human trace and reverse this decision later.`;

export class BedrockReasoner implements Reasoner {
  name: string;
  private client: BedrockRuntimeClient;
  private modelId: string;

  constructor(region: string, modelId: string) {
    this.client = new BedrockRuntimeClient({ region });
    this.modelId = modelId;
    this.name = `bedrock:${modelId}`;
  }

  async decide(request: string, beliefs: RecalledBelief[]): Promise<Verdict> {
    const context = beliefs
      .map((b) => `- [${b.id}] (${b.kind}, confidence ${b.confidence.toFixed(2)}) ${b.claim}`)
      .join('\n');

    const res = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: SYSTEM }],
        messages: [
          {
            role: 'user',
            content: [{ text: `Beliefs available:\n${context}\n\nCustomer request:\n${request}` }],
          },
        ],
        inferenceConfig: { maxTokens: 400, temperature: 0 },
      }),
    );

    const text = res.output?.message?.content?.[0]?.text ?? '{}';
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
      action: string;
      approve: boolean;
      amount_usd: number | null;
      rationale: string;
      used_belief_ids: string[];
    };

    // Trust but verify: a model can hallucinate a belief id, and an unverified
    // id would corrupt the lineage graph -- the one thing that must stay true.
    const valid = new Set(beliefs.map((b) => b.id));
    const used = (json.used_belief_ids ?? [])
      .filter((id) => valid.has(id))
      .map((id) => ({ beliefId: id, weight: 1 / Math.max(1, json.used_belief_ids.length) }));

    return {
      action: json.action,
      approve: json.approve,
      payload: json.amount_usd != null ? { amount_usd: json.amount_usd } : {},
      rationale: json.rationale,
      used,
      reasoner: this.name,
    };
  }
}

/**
 * Deterministic policy reasoner.
 *
 * Scores the recalled beliefs against the request and applies the policy they
 * express. Same inputs always produce the same verdict, which is what makes
 * decision replay meaningful.
 */
export class PolicyReasoner implements Reasoner {
  name = 'policy-engine:v1';

  async decide(request: string, beliefs: RecalledBelief[]): Promise<Verdict> {
    const q = request.toLowerCase();
    const wantsRefund = /refund|money back|reimburse/.test(q);
    const wantsWaiver = /waive|change fee|reschedul/.test(q);
    const amount = extractAmount(q);

    // Only active beliefs reach here -- recall() filters by the index prefix --
    // so relevance is the remaining question.
    const scored = beliefs
      .map((b) => ({ b, score: relevance(q, b) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 3);
    const policy = top.find((x) => x.b.kind === 'semantic' || x.b.kind === 'procedural');
    const total = top.reduce((s, x) => s + x.score, 0) || 1;
    const used = top.map((x) => ({ beliefId: x.b.id, weight: Number((x.score / total).toFixed(2)) }));

    if (!policy) {
      return {
        action: 'deny', approve: false, payload: {},
        rationale: 'No policy belief supports this request.',
        used, reasoner: this.name,
      };
    }

    const permissive = /can be refunded|are routinely approved|no fee|permits/.test(policy.b.claim.toLowerCase());

    if (wantsRefund) {
      return {
        action: permissive ? 'approve_refund' : 'deny',
        approve: permissive,
        payload: amount ? { amount_usd: amount } : {},
        rationale: permissive
          ? `Policy states: ${policy.b.claim}`
          : `Denied — no policy permits this refund. Closest policy: ${policy.b.claim}`,
        used, reasoner: this.name,
      };
    }

    if (wantsWaiver) {
      return {
        action: permissive ? 'waive_change_fee' : 'deny',
        approve: permissive,
        payload: amount ? { amount_usd: amount } : {},
        rationale: `Policy states: ${policy.b.claim}`,
        used, reasoner: this.name,
      };
    }

    return {
      action: 'quote_policy', approve: true,
      payload: { topic: policy.b.subject },
      rationale: `Quoted: ${policy.b.claim}`,
      used, reasoner: this.name,
    };
  }
}

/**
 * Pull a monetary amount out of free text.
 *
 * Requires an explicit currency marker. A bare number is not an amount: a
 * customer writing "I could not fly on NW-221" would otherwise have a $221
 * refund approved, which is exactly the kind of silent, confidently-wrong
 * action this project exists to make traceable. Better to record no amount
 * than a fabricated one.
 */
function extractAmount(q: string): number | null {
  const patterns = [
    /(?:\$|usd\s*)\s?([\d,]+(?:\.\d{1,2})?)/i,      // $3,400 | usd 3400
    /([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|usd)\b/i,  // 3400 dollars
  ];
  for (const re of patterns) {
    const raw = q.match(re)?.[1];
    if (!raw) continue;
    const n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Cheap lexical overlap, weighted by how much we trust the belief. */
function relevance(query: string, b: RecalledBelief): number {
  const terms = query.split(/\W+/).filter((t) => t.length > 3);
  const hay = `${b.subject} ${b.claim}`.toLowerCase();
  const hits = terms.filter((t) => hay.includes(t)).length;
  if (hits === 0) return 0;
  return hits * b.confidence;
}
