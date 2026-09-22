import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };
export { sql, eq, and, or, desc, asc, inArray, isNull, isNotNull, count, gte, lte, like, ilike, ne } from "drizzle-orm";

const globalForDb = globalThis as unknown as { __seoPool?: Pool; __seoDb?: Db };

export type Db = NodePgDatabase<typeof schema>;

function makePool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // An `sslmode` in the URL governs TLS on its own (pg parses it). PGSSL=require
  // is for URLs without one and means verified TLS, never an unchecked certificate.
  const sslFromEnv = !/\bsslmode=/.test(url) && process.env.PGSSL === "require";
  return new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(sslFromEnv ? { ssl: true } : {}),
  });
}

export const pool: Pool = globalForDb.__seoPool ?? makePool();

// An idle connection can be closed by the server at any time (a serverless
// Postgres such as Neon suspends after a few minutes without queries). pg emits
// that as an 'error' event on the pool; without a listener Node would crash the
// process. The pool drops the dead client and opens a new one on the next query.
if (pool.listenerCount("error") === 0) {
  pool.on("error", (err) => {
    console.warn(`[db] idle connection closed by the server: ${err.message}`);
  });
}
export const db: Db = globalForDb.__seoDb ?? drizzle(pool, { schema });

if (process.env.NODE_ENV === "development") {
  globalForDb.__seoPool = pool;
  globalForDb.__seoDb = db;
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

/** Liveness probe used by /api/health and /api/ready. */
export async function pingDb(): Promise<boolean> {
  const res = await pool.query("select 1 as ok");
  return res.rows[0]?.ok === 1;
}

/**
 * Stable 63-bit key from an id, for PostgreSQL advisory locks.
 * FNV-1a 64-bit, clamped to the signed range bigint accepts.
 */
export function advisoryKey(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (const ch of Buffer.from(input, "utf8")) {
    hash = ((hash ^ BigInt(ch)) * prime) & mask;
  }
  return hash & ((1n << 63n) - 1n);
}

export class LockUnavailableError extends Error {
  readonly code = "LOCK_UNAVAILABLE";
  constructor(message = "Another operation holds the lock for this resource") {
    super(message);
    this.name = "LockUnavailableError";
  }
}

/**
 * Run `fn` while holding a transaction-scoped advisory lock for `resourceId`.
 * Transaction-scoped means COMMIT/ROLLBACK releases it — a crashed worker never
 * leaves a project permanently locked.
 *
 * Returns `null` when the lock is already held; callers translate that into
 * HTTP 409.
 */
export async function withAdvisoryLock<T>(
  resourceId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
      [advisoryKey(resourceId).toString()],
    );
    if (!res.rows[0]?.locked) {
      await client.query("ROLLBACK");
      return null;
    }
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type PgError = { code?: string; constraint?: string; message?: string };

/**
 * The underlying node-postgres error. Drizzle (>= 0.44) wraps driver errors in a
 * DrizzleQueryError whose own message is "Failed query: …", with the real error on
 * `.cause` — so the SQLSTATE and constraint name have to be read from there.
 */
export function pgError(err: unknown): PgError | null {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as PgError & { cause?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    cur = e.cause;
  }
  return null;
}

/** True when a pg error is a unique-constraint violation on `constraint`. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = pgError(err);
  if (e?.code !== "23505") return false;
  return constraint ? e.constraint === constraint : true;
}

/** True when a database guard (append-only ledger, approval trigger) refused a write. */
export function isGuardViolation(err: unknown): boolean {
  return pgError(err)?.code === "23001"; // restrict_violation
}

/**
 * Run `fn` in a transaction that is allowed to delete from the append-only
 * ledgers. This is the only supported way to erase history — a retention job or
 * an account-erasure request — and it is deliberately explicit so that such a
 * delete is greppable in the codebase.
 */
export async function withPurgeAllowed<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL seo.allow_purge = 'on'");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Erase an organization and everything that cascades from it, ledgers included. */
export async function purgeOrganization(orgId: string): Promise<void> {
  await withPurgeAllowed(async (client) => {
    await client.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  });
}
