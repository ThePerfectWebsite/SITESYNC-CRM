// Test database helpers. The schema is dropped and re-migrated rather than
// truncated, because audit_events refuses TRUNCATE/DELETE by design.
import pg from "pg";
import { createDb, createPool, type Db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetUserCacheForTests } from "@/server/auth/service";

export function testUrls() {
  return {
    app: process.env.DATABASE_URL_TEST!,
    owner: process.env.DATABASE_OWNER_URL_TEST!,
  };
}

export async function resetTestDatabase(): Promise<void> {
  const { owner } = testUrls();
  const client = new pg.Client({ connectionString: owner });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
  await runMigrations(owner);
  resetUserCacheForTests();
}

/** A Drizzle client connected as the runtime role (sitesync_app). */
export function appDb(): { db: Db; pool: pg.Pool } {
  const pool = createPool(testUrls().app, 5);
  return { db: createDb(pool), pool };
}

/** A raw client connected as the owner role (for trigger tests that bypass grants). */
export async function ownerClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: testUrls().owner });
  await client.connect();
  return client;
}
