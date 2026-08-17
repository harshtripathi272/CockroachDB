import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';

/**
 * Bearer tokens for the MCP endpoint and the REST API.
 *
 * The plaintext token is shown exactly once, at creation, and never stored.
 * What is stored is a SHA-256 hash and a short display prefix, so the console
 * can list "orb_live_4f2a…" without being able to reconstruct the credential.
 *
 * SHA-256 rather than bcrypt/argon2 is a deliberate choice for this specific
 * case: these are 256-bit random tokens, not user-chosen passwords. There is no
 * dictionary to attack and no meaningful entropy shortfall, so a slow KDF would
 * add latency to every single MCP call while defending against nothing. That
 * reasoning does not transfer to passwords.
 */

const PREFIX = 'orb_live_';

export interface TokenIdentity {
  accountId: string;
  tokenId: string;
  scopes: string[];
  displayName: string;
  email: string;
}

export function generateToken(): { token: string; hash: string; prefix: string } {
  const raw = randomBytes(32).toString('base64url');
  const token = `${PREFIX}${raw}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, PREFIX.length + 6) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class TokenStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async create(accountId: string, name: string, scopes = ['read', 'write']) {
    const { token, hash, prefix } = generateToken();
    const row = await this.#db.one(
      `INSERT INTO api_token (account_id, name, token_hash, prefix, scopes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [accountId, name, hash, prefix, scopes],
    );
    // The only time the caller ever sees the plaintext.
    return { id: row!.id, token, prefix, name, scopes, createdAt: row!.created_at };
  }

  /**
   * Resolve a bearer token to an identity.
   *
   * The lookup is by hash, which is an indexed equality match — the
   * timing-safe comparison afterwards is belt and braces on top of that, and
   * costs nothing.
   *
   * `last_used_at` is updated on a separate statement outside any transaction
   * on purpose. Folding it into the same transaction as the caller's actual
   * work would make every concurrent request from the same token contend on one
   * row, manufacturing serialization failures out of pure bookkeeping.
   */
  async resolve(token: string): Promise<TokenIdentity | null> {
    if (!token?.startsWith(PREFIX)) return null;
    const hash = hashToken(token);

    const row = await this.#db.one(
      `SELECT t.id, t.account_id, t.scopes, t.token_hash, a.display_name, a.email
         FROM api_token t
         JOIN account a ON a.id = t.account_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
      [hash],
    );
    if (!row) return null;

    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(row.token_hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    void this.#db
      .query(`UPDATE api_token SET last_used_at = now() WHERE id = $1`, [row.id])
      .catch(() => {});

    return {
      accountId: row.account_id,
      tokenId: row.id,
      scopes: row.scopes ?? [],
      displayName: row.display_name,
      email: row.email,
    };
  }

  async list(accountId: string) {
    return this.#db.query(
      `SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at
         FROM api_token WHERE account_id = $1 ORDER BY created_at DESC`,
      [accountId],
    );
  }

  async revoke(accountId: string, tokenId: string): Promise<boolean> {
    const rows = await this.#db.query(
      `UPDATE api_token SET revoked_at = now()
        WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING id`,
      [tokenId, accountId],
    );
    return rows.length > 0;
  }
}

/**
 * Record that a client connected, and how.
 *
 * This is what makes the Setup tab's green light honest: it turns on because a
 * real MCP handshake arrived from a real client, not because someone ticked a
 * box saying they had configured it.
 */
export async function recordConnection(
  db: Db,
  accountId: string,
  info: { name: string; version?: string; protocol?: string; transport?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO client_connection
       (account_id, client_name, client_version, protocol, transport, call_count)
     VALUES ($1,$2,$3,$4,$5,1)
     ON CONFLICT (account_id, client_name) DO UPDATE
        SET last_seen = now(),
            call_count = client_connection.call_count + 1,
            client_version = excluded.client_version,
            protocol = excluded.protocol,
            transport = excluded.transport`,
    [
      accountId,
      info.name || 'unknown',
      info.version ?? '',
      info.protocol ?? '',
      info.transport ?? 'http',
    ],
  );
}

/**
 * Log a tool call.
 *
 * Deliberately fire-and-forget: observability must never be the reason a user's
 * memory write fails. A dropped metric is an acceptable loss, a dropped memory
 * is not.
 */
export function logToolCall(
  db: Db,
  entry: {
    accountId: string;
    client?: string;
    surface?: string;
    tool: string;
    ok?: boolean;
    latencyMs?: number;
    error?: string | null;
    resultCount?: number;
  },
): void {
  void db
    .query(
      `INSERT INTO tool_call (account_id, client, surface, tool, ok, latency_ms, error, result_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        entry.accountId,
        entry.client ?? 'unknown',
        entry.surface ?? 'mcp',
        entry.tool,
        entry.ok ?? true,
        Math.round(entry.latencyMs ?? 0),
        entry.error ?? null,
        entry.resultCount ?? 0,
      ],
    )
    .catch(() => {});
}
