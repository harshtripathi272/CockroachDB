-- The atomic write that is impossible on a vector database.
--
-- In ONE serializable transaction we record:
--   1. the decision the agent made
--   2. the exact belief versions that drove it        (lineage)
--   3. the confidence updates that decision implies   (memory mutation)
--   4. the external side effect, into the outbox      (the real-world action)
--   5. the audit entry
--
-- Either all five land, or none do. The agent can never end up believing it did
-- something the world never saw, and the world can never see something the
-- agent has no record of deciding.
--
-- mem0 / Zep / Pinecone / Weaviate cannot express this: they have no
-- cross-record atomicity, so (1) can succeed while (4) fails.

BEGIN;

-- 1. the decision
INSERT INTO decision (tenant_id, action, payload, rationale, actor)
VALUES ($1, $2, $3, $4, $5)
RETURNING id AS decision_id;

-- 2. lineage: pin the exact belief versions consumed
--    (belief_valid_from makes this version-specific, not just id-specific)
INSERT INTO decision_input (tenant_id, decision_id, belief_id, belief_valid_from, weight)
SELECT $1, $6, b.id, b.valid_from, w.weight
FROM belief b
JOIN (SELECT unnest($7::UUID[]) AS id, unnest($8::FLOAT[]) AS weight) w
  ON w.id = b.id
WHERE b.tenant_id = $1;

-- 3. acting on a belief reinforces it
UPDATE belief
SET confidence = least(1.0, confidence + 0.05)
WHERE tenant_id = $1 AND id = ANY($7::UUID[]) AND status = 'active';

-- 4. the side effect -- not executed here, only committed as intent.
--    A worker drains it with FOR UPDATE SKIP LOCKED.
INSERT INTO effect_outbox (tenant_id, decision_id, kind, payload)
VALUES ($1, $6, $9, $10);

-- 5. audit
INSERT INTO audit_log (tenant_id, actor, operation, target_kind, target_id, detail)
VALUES ($1, $5, 'decide', 'decision', $6, $3);

COMMIT;
