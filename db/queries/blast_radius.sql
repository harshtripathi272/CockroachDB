-- The query the whole product exists for.
--
-- Question: "This belief turned out to be false. What did it contaminate?"
--
-- Contamination alternates between two node types:
--   a false belief  -> feeds decisions that consumed it  (decision_input)
--   those decisions -> produce new beliefs               (belief.derived_from_decision)
--   those beliefs   -> feed further decisions ... and so on.
--
-- Note on shape: SQL recursive CTEs permit only self-reference, not mutual
-- recursion between two CTEs. So instead of one CTE per node type we flatten
-- both hop types into a single `edges` relation over (kind, id) nodes and walk
-- it with one recursive term. `edges` is an ordinary CTE nested inside the
-- WITH RECURSIVE block, which is legal.
--
-- CockroachDB evaluates this in one distributed transaction against live data.
-- A vector store cannot answer this question at all -- it never stored the edge.
--
-- $1 = tenant_id, $2 = the belief proven false

WITH RECURSIVE
edges (src_kind, src_id, dst_kind, dst_id) AS (
    -- belief -> decision: the decision consumed this belief
    SELECT 'belief', di.belief_id, 'decision', di.decision_id
    FROM decision_input di
    WHERE di.tenant_id = $1::UUID
  UNION ALL
    -- decision -> belief: the agent inferred this belief from that decision
    SELECT 'decision', b.derived_from_decision, 'belief', b.id
    FROM belief b
    WHERE b.tenant_id = $1::UUID
      AND b.derived_from_decision IS NOT NULL
),
taint (kind, id, hops) AS (
    SELECT 'belief', $2::UUID, 0
  UNION
    SELECT e.dst_kind, e.dst_id, t.hops + 1
    FROM taint t
    JOIN edges e
      ON e.src_kind = t.kind AND e.src_id = t.id
    WHERE t.hops < 32                        -- cycle guard
)
SELECT
  d.id,
  d.action,
  d.payload,
  d.rationale,
  d.status,
  d.actor,
  d.committed_at,
  -- hops alternate belief->decision->belief->..., so a decision is always at an
  -- odd hop count. Generation 0 = the belief drove it directly; 1+ = downstream.
  --
  -- min() because a decision can be reached by more than one path: an agent
  -- that cites BOTH the falsified belief and something inferred from it is
  -- reachable at two depths, and would otherwise appear twice. We report the
  -- shortest path -- its most direct link to the falsified belief.
  min((t.hops - 1) // 2) AS generation
FROM taint t
JOIN decision d
  ON d.tenant_id = $1::UUID AND d.id = t.id
WHERE t.kind = 'decision'
  AND d.status = 'committed'
GROUP BY d.id, d.action, d.payload, d.rationale, d.status, d.actor, d.committed_at
ORDER BY generation ASC, d.committed_at ASC;
