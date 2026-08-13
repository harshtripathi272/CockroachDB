-- Recall: governable agent memory
-- Migration 001 - core schema
--
-- Design notes that matter:
--  * `kind` and `status` are STRING + CHECK rather than ENUM. Enums cannot be used
--    as vector-index prefix columns reliably, and we need `kind` in the index prefix
--    to get filtered ANN. Portability wins over elegance here.
--  * Vector indexes MUST be created on an empty table: adding one to a non-empty
--    table blocks writes during backfill. This migration runs before any seed data.
--  * Bitemporal columns (valid_from / valid_to / superseded_by) carry unbounded
--    history. CockroachDB Cloud Basic pins the MVCC GC window to 4500s (1h15m) and
--    it is not user-configurable, so `AS OF SYSTEM TIME` is a fast path for recent
--    forensics only -- it can never be the durable record.

SET CLUSTER SETTING feature.vector_index.enabled = true;

CREATE DATABASE IF NOT EXISTS recall;
USE recall;

-- ---------------------------------------------------------------------------
-- belief: what the agent thinks is true, with provenance and lifecycle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS belief (
  tenant_id   UUID        NOT NULL,
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),

  kind        STRING      NOT NULL,
  subject     STRING      NOT NULL,          -- what the belief is about
  claim       STRING      NOT NULL,          -- the belief itself, in words
  confidence  FLOAT       NOT NULL DEFAULT 0.5,
  status      STRING      NOT NULL DEFAULT 'active',

  embedding   VECTOR(1024),                  -- Amazon Titan Text Embeddings V2

  -- provenance: every belief must answer "where did you come from?"
  source_kind STRING      NOT NULL,          -- user | tool | inference | import
  source_ref  STRING,                        -- s3:// pointer to the raw evidence
  derived_from_decision UUID,                -- set when an agent action produced it;
                                             -- this is what makes contamination
                                             -- propagate transitively

  -- bitemporal history
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to      TIMESTAMPTZ,
  superseded_by UUID,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pk_belief PRIMARY KEY (tenant_id, id),
  CONSTRAINT ck_belief_kind CHECK (kind IN
    ('episodic','semantic','procedural','assumption','entity','preference')),
  CONSTRAINT ck_belief_status CHECK (status IN
    ('active','quarantined','retracted','superseded')),
  CONSTRAINT ck_belief_confidence CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

-- Filtered ANN. Three things here were established empirically against
-- CockroachDB v26.2.5, not guessed:
--
--  1. The operator class must match the query operator. Without an explicit
--     opclass the index defaults to vector_l2_ops, and a `<=>` (cosine) query
--     silently falls back to a full scan. We use cosine because embeddings are
--     normalized text vectors, so the index declares vector_cosine_ops and every
--     read must use `<=>`.
--  2. A filter on a column that is NOT in the index prefix also forces a full
--     scan. `status` is in the prefix because the agent must never retrieve a
--     quarantined belief -- that filter is on every single read, so it has to
--     accelerate.
--  3. Trailing prefix columns MAY be left unconstrained. tenant+status alone,
--     and `kind IN (...)`, both still use the index. So one index covers
--     search-within-a-kind and search-across-all-kinds.
CREATE VECTOR INDEX IF NOT EXISTS belief_recall_idx
  ON belief (tenant_id, status, kind, embedding vector_cosine_ops);

-- Point lookups for the console's belief browser.
CREATE INDEX IF NOT EXISTS belief_subject_idx
  ON belief (tenant_id, subject, status);

-- ---------------------------------------------------------------------------
-- decision: what the agent actually did
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision (
  tenant_id    UUID        NOT NULL,
  id           UUID        NOT NULL DEFAULT gen_random_uuid(),

  action       STRING      NOT NULL,         -- e.g. 'approve_refund'
  payload      JSONB       NOT NULL,
  rationale    STRING,                       -- the agent's stated reasoning
  status       STRING      NOT NULL DEFAULT 'committed',

  actor        STRING      NOT NULL,         -- which agent/version decided
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at  TIMESTAMPTZ,

  CONSTRAINT pk_decision PRIMARY KEY (tenant_id, id),
  CONSTRAINT ck_decision_status CHECK (status IN
    ('committed','quarantined','reverted','failed'))
);

CREATE INDEX IF NOT EXISTS decision_recent_idx
  ON decision (tenant_id, committed_at DESC);

-- ---------------------------------------------------------------------------
-- decision_input: THE lineage edge. This one table is the product.
-- Records exactly which belief versions fed which decision.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_input (
  tenant_id         UUID        NOT NULL,
  decision_id       UUID        NOT NULL,
  belief_id         UUID        NOT NULL,
  belief_valid_from TIMESTAMPTZ NOT NULL,    -- pins the exact version consumed
  weight            FLOAT,                    -- how much it influenced the call

  CONSTRAINT pk_decision_input PRIMARY KEY (tenant_id, decision_id, belief_id)
);

-- Reverse lookup: "which decisions used this belief?" - the blast-radius seed.
CREATE INDEX IF NOT EXISTS decision_input_by_belief_idx
  ON decision_input (tenant_id, belief_id);

-- ---------------------------------------------------------------------------
-- effect_outbox: external side effects, committed in the same transaction as
-- the belief change that caused them. A worker drains this. If an effect can
-- never be delivered, the decision and its memory are rolled back together --
-- the agent can never believe it did something the world never saw.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS effect_outbox (
  tenant_id    UUID        NOT NULL,
  id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  decision_id  UUID        NOT NULL,

  kind         STRING      NOT NULL,         -- 'send_email' | 'issue_refund' | ...
  payload      JSONB       NOT NULL,
  state        STRING      NOT NULL DEFAULT 'pending',
  attempts     INT         NOT NULL DEFAULT 0,
  last_error   STRING,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,

  CONSTRAINT pk_effect_outbox PRIMARY KEY (tenant_id, id),
  CONSTRAINT ck_effect_state CHECK (state IN
    ('pending','sent','confirmed','failed'))
);

-- Drained with SELECT ... FOR UPDATE SKIP LOCKED so multiple workers can run.
CREATE INDEX IF NOT EXISTS effect_outbox_pending_idx
  ON effect_outbox (tenant_id, state, created_at);

-- ---------------------------------------------------------------------------
-- scratch: working memory that expires itself via row-level TTL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scratch (
  tenant_id  UUID        NOT NULL,
  id         UUID        NOT NULL DEFAULT gen_random_uuid(),
  session_id STRING      NOT NULL,
  content    STRING      NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT pk_scratch PRIMARY KEY (tenant_id, id)
) WITH (ttl_expiration_expression = 'expires_at');

-- ---------------------------------------------------------------------------
-- audit_log: every memory mutation, append-only. Governance is the product.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  tenant_id   UUID        NOT NULL,
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       STRING      NOT NULL,
  operation   STRING      NOT NULL,          -- remember | retract | revert | ...
  target_kind STRING      NOT NULL,          -- belief | decision | effect
  target_id   UUID        NOT NULL,
  detail      JSONB,

  CONSTRAINT pk_audit_log PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS audit_log_recent_idx
  ON audit_log (tenant_id, at DESC);
