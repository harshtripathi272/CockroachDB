import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';

/**
 * Database access for Recall.
 *
 * The important thing in this file is `inTransaction`. CockroachDB runs
 * SERIALIZABLE isolation by default, which means a transaction can be aborted
 * by the database at COMMIT time if it conflicts with a concurrent one. That is
 * not an error condition -- it is the contract. The client is *required* to
 * retry.
 *
 * Recall leans hard on serializable transactions (a decision, its lineage, its
 * memory mutation and its outbox entry all commit together), so getting this
 * loop right is load-bearing. Without it, two agents acting on the same belief
 * concurrently will surface spurious failures to users under load.
 */

/** CockroachDB raises this SQLSTATE when a transaction must be retried. */
const SERIALIZATION_FAILURE = '40001';

/** pg returns numeric/decimal as string by default; we want floats as numbers. */
pg.types.setTypeParser(1700, (v: string) => Number.parseFloat(v)); // NUMERIC
pg.types.setTypeParser(701, (v: string) => Number.parseFloat(v));  // FLOAT8

export interface DbConfig {
  connectionString: string;
  /** Max retries for a serialization failure before giving up. */
  maxRetries?: number;
  applicationName?: string;
}

export class Db {
  private pool: pg.Pool;
  private maxRetries: number;

  constructor(cfg: DbConfig) {
    this.maxRetries = cfg.maxRetries ?? 5;
    this.pool = new pg.Pool({
      connectionString: cfg.connectionString,
      application_name: cfg.applicationName ?? 'recall',
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // CockroachDB Cloud requires TLS; the local Docker cluster runs insecure.
      ssl: cfg.connectionString.includes('sslmode=disable')
        ? undefined
        : { rejectUnauthorized: true },
    });
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<R[]> {
    const res = await this.pool.query<R>(sql, params as never[]);
    return res.rows;
  }

  /**
   * Run `fn` inside a serializable transaction, retrying on 40001 with
   * exponential backoff and jitter.
   *
   * The callback may be invoked more than once, so it must be free of side
   * effects outside the database. That is precisely why external effects go
   * into `effect_outbox` inside the transaction rather than being fired from
   * here -- a retried transaction must not send two emails.
   */
  async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          /* connection may already be dead; the pool will discard it */
        });

        const code = (err as { code?: string })?.code;
        if (code !== SERIALIZATION_FAILURE || attempt === this.maxRetries) {
          throw err;
        }
        lastErr = err;

        // Full jitter: 2^attempt * 50ms, randomised to avoid retry convoys
        // when many agents contend on the same belief.
        const ceiling = 2 ** attempt * 50;
        await sleep(Math.random() * ceiling);
      } finally {
        client.release();
      }
    }

    throw lastErr;
  }

  /**
   * Read the database as it existed at `at`.
   *
   * Uses AS OF SYSTEM TIME when `at` is inside the MVCC garbage-collection
   * window, which makes it a true point-in-time read of the whole database with
   * no snapshot machinery. Outside that window the caller must fall back to the
   * bitemporal valid_from/valid_to columns -- see `Recall.recall({ asOf })`.
   *
   * The window is NOT generous: CockroachDB Cloud Basic pins gc.ttlseconds to
   * 4500s (1h15m) and does not let you change it.
   */
  async asOf<R extends QueryResultRow = QueryResultRow>(
    at: Date,
    sql: string,
    params: unknown[] = [],
  ): Promise<R[]> {
    if (!this.isWithinGcWindow(at)) {
      throw new GcWindowExceededError(at, GC_WINDOW_SECONDS);
    }
    // AS OF SYSTEM TIME does not accept a placeholder, so the timestamp is
    // formatted directly. `at` is a Date, never user text, so there is no
    // injection surface here.
    const ts = at.toISOString();
    const stmt = sql.replace(/\bAS_OF_PLACEHOLDER\b/, `AS OF SYSTEM TIME '${ts}'`);
    return this.query<R>(stmt, params);
  }

  isWithinGcWindow(at: Date): boolean {
    return Date.now() - at.getTime() < GC_WINDOW_SECONDS * 1000;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** CockroachDB Cloud Basic: fixed at 4500s and not user-configurable. */
export const GC_WINDOW_SECONDS = 4500;

export class GcWindowExceededError extends Error {
  // Declared explicitly rather than as constructor parameter properties: Node's
  // built-in type stripping is strip-only and cannot emit the implied
  // assignments, so `public readonly x: T` in a constructor is a syntax error.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
