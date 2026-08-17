import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';

/**
 * Database access for Orbis.
 *
 * The load-bearing part of this file is `inTransaction`. CockroachDB runs
 * SERIALIZABLE isolation by default, which means a transaction can be aborted
 * at COMMIT time if it conflicts with a concurrent one. That is not a failure
 * mode — it is the contract, and the client is required to retry.
 *
 * It matters more here than in a typical app because Orbis is written to by
 * many agents at once: Claude Code, a Codex session and a Telegram message can
 * all land on the same workspace within the same second, and each write touches
 * the memory row, its lineage edges, the entity graph and the audit log
 * together.
 */

/** CockroachDB raises this SQLSTATE when a transaction must be retried. */
const SERIALIZATION_FAILURE = '40001';

/**
 * Is this an error the client is expected to retry?
 *
 * SQLSTATE 40001 is normally sufficient. The message check is a deliberate
 * safety net: retryable conditions (WriteTooOldError, RETRY_SERIALIZABLE,
 * TransactionRetryWithProtoRefreshError) occasionally surface through a driver
 * or proxy without the code preserved, and treating one of those as fatal turns
 * a transient conflict into a user-visible error.
 */
function isRetryable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code === SERIALIZATION_FAILURE) return true;
  return /restart transaction|TransactionRetryWithProtoRefresh|WriteTooOld|RETRY_SERIALIZABLE/i.test(
    e?.message ?? '',
  );
}

// pg returns NUMERIC and FLOAT8 as strings by default. Confidence scores and
// vector distances are arithmetic, so parse them as numbers at the boundary
// rather than scattering Number() calls through the query layer.
pg.types.setTypeParser(1700, (v: string) => Number.parseFloat(v));
pg.types.setTypeParser(701, (v: string) => Number.parseFloat(v));

export interface DbConfig {
  connectionString: string;
  maxRetries?: number;
  applicationName?: string;
  /** Pool ceiling. Small on serverless, larger for a long-lived process. */
  max?: number;
}

export class Db {
  #pool: pg.Pool;
  #maxRetries: number;
  readonly stats = { queries: 0, transactions: 0, retries: 0, exhausted: 0 };

  constructor(cfg: DbConfig) {
    // Ten, not five. Five was tuned against a local cluster where a retry costs
    // ~1ms; against CockroachDB Cloud a round trip is ~40ms, so identical
    // contention burns the whole budget before the queue drains and the error
    // reaches a user. Contention scales with latency, not just with load.
    this.#maxRetries = cfg.maxRetries ?? 10;
    this.#pool = new pg.Pool({
      connectionString: cfg.connectionString,
      application_name: cfg.applicationName ?? 'orbis',
      max: cfg.max ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: cfg.connectionString.includes('sslmode=disable')
        ? undefined
        : { rejectUnauthorized: true },
    });

    // An idle client erroring (a node going away, say) must not take the
    // process down. The pool discards it and the next checkout gets a fresh
    // connection; that is exactly the failover we want to demonstrate.
    this.#pool.on('error', () => {});
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<R[]> {
    this.stats.queries++;
    const res = await this.#pool.query<R>(sql, params as never[]);
    return res.rows;
  }

  async one<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<R | null> {
    const rows = await this.query<R>(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Run `fn` inside a serializable transaction, retrying on 40001 with
   * exponential backoff and full jitter.
   *
   * `fn` may be invoked more than once, so it must have no side effects outside
   * the database. Anything that touches the outside world belongs in a row that
   * a separate process drains — a retried transaction must not send two
   * messages.
   */
  async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    this.stats.transactions++;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      const client = await this.#pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          /* connection may already be gone; the pool discards it */
        });

        if (!isRetryable(err)) throw err;
        if (attempt === this.#maxRetries) {
          this.stats.exhausted++;
          throw err;
        }

        lastErr = err;
        this.stats.retries++;

        // Capped full jitter. Uncapped 2^attempt reaches 51s by attempt 10,
        // which is worse than failing outright; capped at 1s the entire budget
        // is a few seconds and the queue still drains.
        const ceiling = Math.min(2 ** attempt * 50, 1000);
        await sleep(Math.random() * ceiling);
      } finally {
        client.release();
      }
    }

    throw lastErr;
  }

  /**
   * Run `fn` with row-level security scoped to one account.
   *
   * `SET LOCAL` rather than `SET` is essential: the setting must die with the
   * transaction. A plain SET would persist on the pooled connection and the
   * next request to check it out would inherit somebody else's identity — a
   * cross-tenant data leak produced by connection reuse.
   */
  async asAccount<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.inTransaction(async (client) => {
      await client.query(`SET LOCAL orbis.account_id = '${assertUuid(accountId)}'`);
      return fn(client);
    });
  }

  /**
   * Read the database as it was at `at`.
   *
   * AS OF SYSTEM TIME is a true point-in-time read of the whole database with
   * no snapshot machinery, but the window is short: CockroachDB Cloud Basic
   * pins gc.ttlseconds to 4500s and does not allow changing it. Beyond that,
   * callers fall back to the bitemporal valid_from/valid_to columns, which is
   * precisely why memory rows carry them.
   */
  async asOf<R extends QueryResultRow = QueryResultRow>(
    at: Date,
    sql: string,
    params: unknown[] = [],
  ): Promise<R[]> {
    if (!this.isWithinGcWindow(at)) throw new GcWindowExceededError(at, GC_WINDOW_SECONDS);
    // AS OF SYSTEM TIME does not accept a placeholder. `at` is a Date, never
    // user-supplied text, so formatting it in carries no injection surface.
    const stmt = sql.replace(/\bAS_OF_PLACEHOLDER\b/, `AS OF SYSTEM TIME '${at.toISOString()}'`);
    return this.query<R>(stmt, params);
  }

  isWithinGcWindow(at: Date): boolean {
    return Date.now() - at.getTime() < GC_WINDOW_SECONDS * 1000;
  }

  /** Liveness, and how long a real read actually took. */
  async health(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      await this.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/** CockroachDB Cloud Basic: fixed at 4500s, not user-configurable. */
export const GC_WINDOW_SECONDS = 4500;

export class GcWindowExceededError extends Error {
  // Fields are declared rather than written as constructor parameter
  // properties: Node's built-in type stripping is strip-only and cannot emit
  // the implied assignments, so `constructor(readonly x: T)` is a syntax error.
  readonly requested: Date;
  readonly windowSeconds: number;

  constructor(requested: Date, windowSeconds: number) {
    super(
      `${requested.toISOString()} is older than the ${windowSeconds}s MVCC ` +
        `garbage-collection window; use the bitemporal history instead.`,
    );
    this.requested = requested;
    this.windowSeconds = windowSeconds;
    this.name = 'GcWindowExceededError';
  }
}

/**
 * Guard for values interpolated into SQL that cannot take a placeholder.
 *
 * Only `SET LOCAL` needs this, but that one call decides which account's rows
 * are visible, so it gets an explicit check rather than a trusting cast.
 */
function assertUuid(v: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw new Error(`not a uuid: ${v}`);
  }
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
