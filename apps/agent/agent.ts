import type { Recall, RecalledBelief } from '../../packages/recall-core/src/index.ts';
import type { Reasoner, Verdict } from './reasoner.ts';

/**
 * The Northwind Air support agent.
 *
 * The loop is deliberately small, because the interesting property is not the
 * reasoning -- it is that the agent *cannot* act without leaving a trace:
 *
 *   1. recall   - semantic search over active beliefs only
 *   2. reason   - decide, citing which beliefs were used
 *   3. commit   - decision + lineage + memory mutation + side effect, atomically
 *   4. reflect  - optionally form a new belief, tagged with the decision that
 *                 produced it
 *
 * Step 4 is where agents genuinely drift in production: the agent generalises
 * from its own past action into a new "fact". Recall keeps that edge
 * (`derived_from_decision`) so the generalisation is traceable back to the
 * decision that spawned it -- which is what makes contamination transitive.
 */

export interface HandleResult {
  request: string;
  recalled: RecalledBelief[];
  verdict: Verdict;
  decisionId: string | null;
  reflection: { beliefId: string; claim: string } | null;
  timings: { recallMs: number; reasonMs: number; commitMs: number };
}

export class SupportAgent {
  private recall: Recall;
  private reasoner: Reasoner;
  private tenantId: string;

  constructor(opts: { recall: Recall; reasoner: Reasoner; tenantId: string }) {
    this.recall = opts.recall;
    this.reasoner = opts.reasoner;
    this.tenantId = opts.tenantId;
  }

  async handle(request: string, opts: { reflect?: boolean } = {}): Promise<HandleResult> {
    // 1. recall -------------------------------------------------------------
    const t0 = Date.now();
    const recalled = await this.recall.recall({
      tenantId: this.tenantId,
      text: request,
      limit: 8,
    });
    const recallMs = Date.now() - t0;

    // 2. reason -------------------------------------------------------------
    const t1 = Date.now();
    const verdict = await this.reasoner.decide(request, recalled);
    const reasonMs = Date.now() - t1;

    // A verdict citing no beliefs is not actionable. Recording it would create
    // exactly the unexplainable action this project exists to prevent, so the
    // agent declines rather than acting on nothing.
    if (verdict.used.length === 0) {
      return {
        request, recalled, decisionId: null, reflection: null,
        verdict: {
          ...verdict,
          approve: false,
          action: 'deny',
          rationale: 'No belief supported this request, so no action was taken.',
        },
        timings: { recallMs, reasonMs, commitMs: 0 },
      };
    }

    // 3. commit -------------------------------------------------------------
    const t2 = Date.now();
    const decision = await this.recall.decide({
      tenantId: this.tenantId,
      action: verdict.action,
      payload: verdict.payload,
      rationale: verdict.rationale,
      inputs: verdict.used,
      // Only approvals touch the outside world; a denial has nothing to deliver.
      effect: verdict.approve
        ? { kind: effectFor(verdict.action), payload: verdict.payload }
        : undefined,
    });
    const commitMs = Date.now() - t2;

    // 4. reflect ------------------------------------------------------------
    let reflection: HandleResult['reflection'] = null;
    if (opts.reflect && verdict.approve) {
      const claim = generalise(verdict);
      const belief = await this.recall.remember({
        tenantId: this.tenantId,
        kind: 'procedural',
        subject: `${verdict.action}_precedent`,
        claim,
        sourceKind: 'inference',
        // The edge that makes contamination transitive.
        derivedFromDecision: decision.id,
      });
      reflection = { beliefId: belief.id, claim };
    }

    return {
      request,
      recalled,
      verdict,
      decisionId: decision.id,
      reflection,
      timings: { recallMs, reasonMs, commitMs },
    };
  }
}

function effectFor(action: string): string {
  switch (action) {
    case 'approve_refund': return 'issue_refund';
    case 'waive_change_fee': return 'issue_credit';
    case 'quote_policy': return 'send_email';
    default: return 'noop';
  }
}

/**
 * How an agent turns one action into a general rule. This is the drift.
 * It is intentionally a little too confident -- that is what real agents do,
 * and the demo depends on it being plausible rather than obviously wrong.
 */
function generalise(v: Verdict): string {
  return `${v.action.replace(/_/g, ' ')} requests of this kind are routinely approved`;
}
