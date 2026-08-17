-- ---------------------------------------------------------------------------
-- A least-privilege role that row-level security actually applies to.
--
-- Enabling RLS is not the same as enforcing it, and the difference is easy to
-- miss. Two exemptions apply by default:
--
--   `root` carries rolbypassrls, so policies are ignored entirely.
--   The table owner is exempt unless FORCE ROW LEVEL SECURITY is set.
--
-- Verified on the local cluster: with policies enabled but neither of these
-- addressed, a connection scoped to a random account id still saw all 27 rows.
-- The policies were decorative.
--
-- This migration closes both. `orbis_app` is an ordinary role with table
-- privileges and no bypass, and FORCE makes the owner subject to policy too, so
-- a query arriving without orbis.account_id set returns nothing rather than
-- everything.
-- ---------------------------------------------------------------------------

USE orbis;

CREATE ROLE IF NOT EXISTS orbis_app LOGIN;

GRANT CONNECT ON DATABASE orbis TO orbis_app;
GRANT USAGE ON SCHEMA public TO orbis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orbis_app;

-- Applies to tables created after this runs, so a later migration does not
-- silently leave the app role without access to a new table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orbis_app;

-- Without FORCE, the owner bypasses its own policies.
ALTER TABLE memory FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
ALTER TABLE node FORCE ROW LEVEL SECURITY;
ALTER TABLE entity FORCE ROW LEVEL SECURITY;
ALTER TABLE edge FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_page FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_citation FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_source FORCE ROW LEVEL SECURITY;
ALTER TABLE interview_question FORCE ROW LEVEL SECURITY;
ALTER TABLE chat FORCE ROW LEVEL SECURITY;
ALTER TABLE message FORCE ROW LEVEL SECURITY;
ALTER TABLE tool_call FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE client_connection FORCE ROW LEVEL SECURITY;
ALTER TABLE api_token FORCE ROW LEVEL SECURITY;
ALTER TABLE scratch FORCE ROW LEVEL SECURITY;

-- `account` has no account_id of its own; a row IS the account. Scoped so a
-- session can only ever see its own row.
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE account FORCE ROW LEVEL SECURITY;
CREATE POLICY self_only ON account
    USING (id = orbis_account()) WITH CHECK (id = orbis_account());
