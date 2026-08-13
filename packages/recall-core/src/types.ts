/**
 * Recall - core domain types.
 *
 * The vocabulary here is deliberate: an agent holds *beliefs*, not "memories".
 * A belief can be wrong, can be sourced, and can be retracted. That framing is
 * what makes governance expressible at all.
 */

/** Six belief kinds, mirrored by the ck_belief_kind constraint in 001_init.sql. */
export type BeliefKind =
  | 'episodic'    // something that happened: "customer called on Tuesday"
  | 'semantic'    // a stable fact: "refund window is 30 days"
  | 'procedural'  // how to do something: "escalate to tier 2 after 2 failures"
  | 'assumption'  // unverified: "they are probably on the Pro plan"
  | 'entity'      // a thing in the world: "customer #8812"
  | 'preference'; // "this customer prefers email over phone"

export type BeliefStatus =
  | 'active'
  | 'quarantined'  // suspected false, not yet confirmed - agent must not use it
  | 'retracted'    // confirmed false
  | 'superseded';  // replaced by a newer version

/** Where a belief came from. Every belief must answer this. */
export type SourceKind = 'user' | 'tool' | 'inference' | 'import';

export interface Belief {
  tenantId: string;
  id: string;
  kind: BeliefKind;
  subject: string;
  claim: string;
  confidence: number;      // 0.0 - 1.0
  status: BeliefStatus;
  sourceKind: SourceKind;
  sourceRef?: string;      // s3:// pointer to raw evidence
  /** Set when an agent action produced this belief. Makes contamination transitive. */
  derivedFromDecision?: string;
  validFrom: Date;
  validTo?: Date;
  supersededBy?: string;
  createdAt: Date;
}

export type DecisionStatus = 'committed' | 'quarantined' | 'reverted' | 'failed';

export interface Decision {
  tenantId: string;
  id: string;
  action: string;                    // 'approve_refund', 'quote_policy', ...
  payload: Record<string, unknown>;
  rationale?: string;
  status: DecisionStatus;
  actor: string;                     // agent identity + version
  committedAt: Date;
  revertedAt?: Date;
}

/** The lineage edge. Pins the exact belief *version* a decision consumed. */
export interface DecisionInput {
  decisionId: string;
  beliefId: string;
  beliefValidFrom: Date;
  weight?: number;
}

export type EffectState = 'pending' | 'sent' | 'confirmed' | 'failed';

/**
 * An external side effect, committed as *intent* in the same transaction as the
 * decision. A worker drains it. This is why memory and the world cannot diverge.
 */
export interface Effect {
  id: string;
  decisionId: string;
  kind: string;                      // 'issue_refund', 'send_email', ...
  payload: Record<string, unknown>;
  state: EffectState;
  attempts: number;
  lastError?: string;
}

/** One row of the blast radius: a decision contaminated by a false belief. */
export interface ContaminatedDecision {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  rationale?: string;
  status: DecisionStatus;
  actor: string;
  committedAt: Date;
  /** 0 = the belief drove this decision directly; 1+ = downstream of another. */
  depth: number;
}

export interface RecallQuery {
  tenantId: string;
  text: string;
  kinds?: BeliefKind[];
  limit?: number;
  minConfidence?: number;
  /**
   * Read memory as it existed at this instant.
   * Within the MVCC GC window this uses AS OF SYSTEM TIME; beyond it, the
   * bitemporal valid_from/valid_to columns. Callers do not need to care which.
   */
  asOf?: Date;
}

/** A belief returned from a semantic search, with its distance score. */
export interface RecalledBelief extends Belief {
  distance: number;
}
