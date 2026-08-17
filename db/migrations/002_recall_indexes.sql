-- ---------------------------------------------------------------------------
-- A second vector index, for searching across every workspace at once.
--
-- The assumption this migration exists to correct: that a trailing prefix
-- column may be left unconstrained and the index will still be chosen. It will
-- not, at least not for a nullable one. Measured on a real 800-row table:
--
--   WHERE account_id = $1 AND status = $2 AND workspace_id = $3   → vector search
--   WHERE account_id = $1 AND status = $2                         → full scan
--
-- Both are legitimate queries — "search this project" and "search everything I
-- know" — so both need an index whose prefix is fully constrained. Scoped
-- search uses memory_recall_idx; global search uses this one. The two return
-- identical top hits, verified against the same query vector.
-- ---------------------------------------------------------------------------

USE orbis;

CREATE VECTOR INDEX IF NOT EXISTS memory_recall_global_idx
    ON memory (account_id, status, embedding vector_cosine_ops);
