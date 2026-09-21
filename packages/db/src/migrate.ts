/**
 * Migration runner. Idempotent: drizzle's migrator keeps a `__drizzle_migrations`
 * table and skips anything already applied, so this is safe to run on every
 * release (it is wired into the Railway release step, not the build step).
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { db, closeDb, pingDb, pool, advisoryKey } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../migrations");

async function main(): Promise<void> {
  const started = Date.now();
  await pingDb();

  // Session-level advisory lock: a second replica waits here until the first
  // has finished, then finds nothing left to apply.
  const lock = await pool.connect();
  const key = advisoryKey("seo-table:migrations").toString();
  try {
    await lock.query("SELECT pg_advisory_lock($1::bigint)", [key]);
    console.log(`[migrate] applying migrations from ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    console.log(`[migrate] done in ${Date.now() - started}ms`);
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1::bigint)", [key]).catch(() => {});
    lock.release();
  }
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("[migrate] failed:", err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
