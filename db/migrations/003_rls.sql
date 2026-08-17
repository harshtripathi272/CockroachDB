-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- Orbis holds one person's entire working memory. Every query in the
-- application already filters by account_id, but "every query" is a property
-- that has to hold forever across every future change, and one forgotten
-- predicate in one endpoint leaks somebody's memory to somebody else.
--
-- These policies move that guarantee below the application. With them in place
-- a query that forgets its account filter returns nothing rather than returning
-- everything — the failure mode becomes a visible bug instead of a silent
-- breach.
--
-- The session variable is set with SET LOCAL inside a transaction (see
-- Db.asAccount). A plain SET would persist on the pooled connection and the
-- next request to check it out would inherit the previous caller's identity,
-- which is a worse hole than the one this closes.
-- ---------------------------------------------------------------------------

USE orbis;

-- Reading the setting with `missing_ok = true` returns '' rather than raising
-- when it has not been set, so an unscoped connection matches no rows instead
-- of erroring in a way that might get caught and ignored.
CREATE OR REPLACE FUNCTION orbis_account() RETURNS UUID AS $$
  SELECT nullif(current_setting('orbis.account_id', true), '')::UUID
$$ LANGUAGE SQL STABLE;

ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE node ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_page ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_citation ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_question ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat ENABLE ROW LEVEL SECURITY;
ALTER TABLE message ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE scratch ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_isolation ON memory
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON workspace
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON node
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON entity
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON edge
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON wiki_page
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON wiki_citation
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON memory_source
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON interview_question
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON chat
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON message
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON tool_call
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON audit_log
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON client_connection
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON api_token
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
CREATE POLICY account_isolation ON scratch
    USING (account_id = orbis_account()) WITH CHECK (account_id = orbis_account());
