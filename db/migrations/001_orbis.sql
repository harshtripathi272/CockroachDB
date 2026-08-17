-- ---------------------------------------------------------------------------
-- Orbis — one memory, every agent.
--
-- Four layers, one database:
--
--   RAW        memory              what you and your agents actually said
--   EXTRACT    entity / edge       people, repos, tools, concepts
--   ORGANIZE   wiki_page + cite    generated pages, every claim sourced
--   IDENTITY   memory[preference]  who you are and how you work
--
-- The design rule throughout: a derived thing must always be able to name the
-- raw things it came from. That is what makes correction propagation possible
-- and it is the reason this is a relational database and not a vector store.
-- ---------------------------------------------------------------------------

SET CLUSTER SETTING feature.vector_index.enabled = true;

CREATE DATABASE IF NOT EXISTS orbis;
USE orbis;

-- ---------------------------------------------------------------------------
-- Identity and access
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         STRING NOT NULL UNIQUE,
    display_name  STRING NOT NULL,
    -- Freeform, agent-authored: timezone, pronouns, working hours. Kept as
    -- JSONB because the shape genuinely is open-ended and querying it is rare.
    traits        JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bearer tokens for the MCP endpoint and the REST API.
--
-- Only the hash is stored. `prefix` exists so the UI can show you which token
-- is which ("orb_live_4f2a…") without being able to reconstruct it.
CREATE TABLE IF NOT EXISTS api_token (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    name          STRING NOT NULL,
    token_hash    STRING NOT NULL UNIQUE,
    prefix        STRING NOT NULL,
    scopes        STRING[] NOT NULL DEFAULT ARRAY['read','write'],
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_token_by_account ON api_token (account_id, revoked_at);

-- ---------------------------------------------------------------------------
-- Structure: workspaces, and a folder/project tree inside each
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspace (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    slug          STRING NOT NULL,
    name          STRING NOT NULL,
    description   STRING NOT NULL DEFAULT '',
    -- Cosmetic, but it is what makes eight workspaces scannable at a glance.
    color         STRING NOT NULL DEFAULT 'slate',
    icon          STRING NOT NULL DEFAULT 'folder',
    is_default    BOOL NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, slug)
);

-- The tree. `parent_id` gives structure; `path` is a materialised ancestor
-- string ('/research/hackathon') so "everything under X" is a prefix scan
-- rather than a recursive walk. Both are maintained together on write.
CREATE TABLE IF NOT EXISTS node (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    parent_id     UUID REFERENCES node(id) ON DELETE CASCADE,
    kind          STRING NOT NULL DEFAULT 'folder'
                    CHECK (kind IN ('folder','project','collection')),
    name          STRING NOT NULL,
    slug          STRING NOT NULL,
    path          STRING NOT NULL,
    summary       STRING NOT NULL DEFAULT '',
    position      INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, path)
);

CREATE INDEX IF NOT EXISTS node_by_parent ON node (workspace_id, parent_id, position);

-- ---------------------------------------------------------------------------
-- RAW LAYER — memory
--
-- Everything an agent or a human contributes lands here first. Nothing is
-- deleted: a correction supersedes rather than overwrites, so the history of
-- what was believed and when stays intact and queryable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    workspace_id  UUID REFERENCES workspace(id) ON DELETE CASCADE,
    node_id       UUID REFERENCES node(id) ON DELETE SET NULL,

    -- STRING + CHECK rather than an ENUM on purpose: enum-typed columns behave
    -- unreliably as vector-index prefix columns, and `kind` sits in a prefix.
    kind          STRING NOT NULL DEFAULT 'fact'
                    CHECK (kind IN ('fact','preference','decision','event',
                                    'insight','doc','task','question')),
    title         STRING NOT NULL,
    body          STRING NOT NULL,

    -- 1024 dimensions because that is what Titan V2 emits. Smaller local models
    -- (MiniLM is 384) are zero-padded to fit: cosine similarity is unchanged by
    -- shared zero dimensions, so padding is lossless *within* one model. It is
    -- NOT comparable across models, which is why embed_model is recorded and a
    -- provider switch triggers a re-embed rather than silently degrading.
    embedding     VECTOR(1024),
    embed_model   STRING,

    -- Provenance. `source` is how it arrived, `client` is which tool wrote it.
    source        STRING NOT NULL DEFAULT 'api'
                    CHECK (source IN ('mcp','chat','interview','import',
                                      'api','dream','telegram')),
    client        STRING NOT NULL DEFAULT 'unknown',
    source_ref    STRING,

    -- Confidence and reinforcement. A preference stated once is a guess; the
    -- same preference observed nine times is a rule. This is the mechanism the
    -- dream pass uses to promote signals, borrowed from open-second-brain.
    confidence      FLOAT NOT NULL DEFAULT 0.5
                      CHECK (confidence >= 0 AND confidence <= 1),
    evidence_count  INT NOT NULL DEFAULT 1,
    last_reinforced_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Lifecycle. Bitemporal, because the MVCC garbage-collection window on
    -- CockroachDB Cloud Basic is pinned to 4500s — AS OF SYSTEM TIME can only
    -- rewind ~75 minutes, which is nowhere near enough for a memory product.
    status        STRING NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','superseded','retracted')),
    valid_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to      TIMESTAMPTZ,
    superseded_by UUID REFERENCES memory(id) ON DELETE SET NULL,

    tags          STRING[] NOT NULL DEFAULT ARRAY[]::STRING[],
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The recall index, and the shape of it is load-bearing.
--
-- Three things were learned the hard way on the previous build, all of which
-- fail *silently* — the query still returns rows, it just full-scans:
--
--   1. The operator class must match the query operator. Without an explicit
--      vector_cosine_ops the index defaults to L2 and a <=> query ignores it.
--   2. Any filter on a non-prefix column also forces a full scan. Every read
--      filters status='active' (a retracted memory must never resurface), so
--      status has to live in the prefix.
--   3. Trailing prefix columns MAY be left unconstrained. workspace_id sits
--      last, so this one index serves both "search this workspace" and
--      "search everything".
CREATE VECTOR INDEX IF NOT EXISTS memory_recall_idx
    ON memory (account_id, status, workspace_id, embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS memory_by_workspace
    ON memory (account_id, workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_by_kind
    ON memory (account_id, kind, status, confidence DESC);
CREATE INDEX IF NOT EXISTS memory_by_node
    ON memory (node_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_by_client
    ON memory (account_id, client, created_at DESC);
CREATE INVERTED INDEX IF NOT EXISTS memory_by_tag ON memory (tags);

-- Lineage. A memory derived from other memories names them here.
--
-- This is the edge that makes correction propagation work: falsify one raw
-- memory and a recursive walk over this table finds every insight, preference
-- and wiki page that was built on top of it, however many hops away.
CREATE TABLE IF NOT EXISTS memory_source (
    memory_id     UUID NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    source_id     UUID NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    weight        FLOAT NOT NULL DEFAULT 1.0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (memory_id, source_id)
);

CREATE INDEX IF NOT EXISTS memory_source_reverse
    ON memory_source (account_id, source_id);

-- ---------------------------------------------------------------------------
-- EXTRACT LAYER — entities and the graph between them
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    kind          STRING NOT NULL DEFAULT 'concept'
                    CHECK (kind IN ('person','org','project','tool','repo',
                                    'place','concept','event')),
    name          STRING NOT NULL,
    -- Lowercased/normalised form used for dedupe. "CockroachDB", "cockroachdb"
    -- and "Cockroach DB" must converge on one node or the graph is noise.
    canonical     STRING NOT NULL,
    summary       STRING NOT NULL DEFAULT '',
    embedding     VECTOR(1024),
    embed_model   STRING,
    mention_count INT NOT NULL DEFAULT 1,
    first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, kind, canonical)
);

CREATE VECTOR INDEX IF NOT EXISTS entity_recall_idx
    ON entity (account_id, embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS entity_by_mentions
    ON entity (account_id, mention_count DESC);

-- One generic edge table rather than one table per relationship.
--
-- src/dst are (kind, id) pairs so the same relation walks memory→entity,
-- entity→entity and memory→memory. The graph view needs all three and
-- splitting them into separate tables would mean a UNION on every read.
CREATE TABLE IF NOT EXISTS edge (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    src_kind      STRING NOT NULL CHECK (src_kind IN ('memory','entity','node')),
    src_id        UUID NOT NULL,
    dst_kind      STRING NOT NULL CHECK (dst_kind IN ('memory','entity','node')),
    dst_id        UUID NOT NULL,
    rel           STRING NOT NULL DEFAULT 'mentions',
    weight        FLOAT NOT NULL DEFAULT 1.0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, src_kind, src_id, dst_kind, dst_id, rel)
);

CREATE INDEX IF NOT EXISTS edge_out ON edge (account_id, src_kind, src_id);
CREATE INDEX IF NOT EXISTS edge_in  ON edge (account_id, dst_kind, dst_id);

-- ---------------------------------------------------------------------------
-- ORGANIZE LAYER — the wiki
--
-- A wiki page is never authoritative. It is a *rendering* of the memories
-- underneath it, and wiki_citation records exactly which ones. That is what
-- lets the UI show receipts for every claim, and what lets a correction mark
-- the right pages stale instead of regenerating the whole wiki.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wiki_page (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    workspace_id  UUID REFERENCES workspace(id) ON DELETE CASCADE,
    slug          STRING NOT NULL,
    title         STRING NOT NULL,
    kind          STRING NOT NULL DEFAULT 'topic'
                    CHECK (kind IN ('profile','project','topic','entity','workspace')),
    body_md       STRING NOT NULL DEFAULT '',
    summary       STRING NOT NULL DEFAULT '',
    generator     STRING NOT NULL DEFAULT 'dream',
    source_count  INT NOT NULL DEFAULT 0,
    -- Set when a cited memory is corrected. The page keeps serving its old
    -- content (stale beats blank) but the UI flags it and the next dream pass
    -- regenerates it.
    stale         BOOL NOT NULL DEFAULT false,
    generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, slug)
);

CREATE INDEX IF NOT EXISTS wiki_by_workspace
    ON wiki_page (account_id, workspace_id, kind);
CREATE INDEX IF NOT EXISTS wiki_stale ON wiki_page (account_id, stale)
    WHERE stale = true;

CREATE TABLE IF NOT EXISTS wiki_citation (
    page_id       UUID NOT NULL REFERENCES wiki_page(id) ON DELETE CASCADE,
    memory_id     UUID NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    -- Which claim in the page this memory supports, so the UI can highlight
    -- the specific sentence rather than the whole document.
    claim         STRING NOT NULL DEFAULT '',
    PRIMARY KEY (page_id, memory_id, claim)
);

CREATE INDEX IF NOT EXISTS citation_by_memory
    ON wiki_citation (account_id, memory_id);

-- ---------------------------------------------------------------------------
-- Interview — the "train your data" loop
--
-- Orbis notices what it does not know about you and asks. An answered question
-- becomes a memory with source='interview', so the profile fills in from
-- conversation rather than from a settings form.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS interview_question (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    workspace_id  UUID REFERENCES workspace(id) ON DELETE CASCADE,
    topic         STRING NOT NULL,
    question      STRING NOT NULL,
    why           STRING NOT NULL DEFAULT '',
    priority      INT NOT NULL DEFAULT 5,
    status        STRING NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','answered','skipped')),
    answer_memory UUID REFERENCES memory(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS interview_open
    ON interview_question (account_id, status, priority DESC);

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    workspace_id  UUID REFERENCES workspace(id) ON DELETE CASCADE,
    title         STRING NOT NULL DEFAULT 'New chat',
    model         STRING NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_recent ON chat (account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS message (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id       UUID NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    role          STRING NOT NULL CHECK (role IN ('user','assistant','tool','system')),
    content       STRING NOT NULL,
    tool_calls    JSONB,
    tokens_in     INT NOT NULL DEFAULT 0,
    tokens_out    INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_by_chat ON message (chat_id, created_at);

-- ---------------------------------------------------------------------------
-- Observability
--
-- Every MCP and REST call lands in tool_call. This is what the Observability
-- tab reads, and it is also how the Setup tab knows a client has genuinely
-- connected — the green light is driven by a real handshake, not a checkbox.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS client_connection (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    client_name    STRING NOT NULL,
    client_version STRING NOT NULL DEFAULT '',
    protocol       STRING NOT NULL DEFAULT '',
    transport      STRING NOT NULL DEFAULT 'http',
    first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    call_count     INT NOT NULL DEFAULT 0,
    UNIQUE (account_id, client_name)
);

CREATE TABLE IF NOT EXISTS tool_call (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    client        STRING NOT NULL DEFAULT 'unknown',
    surface       STRING NOT NULL DEFAULT 'mcp'
                    CHECK (surface IN ('mcp','rest','console','telegram','dream')),
    tool          STRING NOT NULL,
    ok            BOOL NOT NULL DEFAULT true,
    latency_ms    INT NOT NULL DEFAULT 0,
    error         STRING,
    result_count  INT NOT NULL DEFAULT 0,
    at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_call_recent ON tool_call (account_id, at DESC);
CREATE INDEX IF NOT EXISTS tool_call_by_tool ON tool_call (account_id, tool, at DESC);
CREATE INDEX IF NOT EXISTS tool_call_by_client ON tool_call (account_id, client, at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    action        STRING NOT NULL,
    target_kind   STRING NOT NULL DEFAULT '',
    target_id     UUID,
    actor         STRING NOT NULL DEFAULT 'system',
    detail        JSONB NOT NULL DEFAULT '{}',
    at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_recent ON audit_log (account_id, at DESC);

-- Ephemeral working memory. Row-level TTL means CockroachDB deletes these
-- itself — no cron, no cleanup job, no orphaned rows if the app is down.
CREATE TABLE IF NOT EXISTS scratch (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    session_key   STRING NOT NULL,
    content       STRING NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '6 hours')
) WITH (ttl_expiration_expression = 'expires_at', ttl_job_cron = '*/15 * * * *');

CREATE INDEX IF NOT EXISTS scratch_by_session ON scratch (account_id, session_key);
