// Starts every E2E run from an empty (but fully migrated) test database.
import pg from "pg";
import { runMigrations } from "../src/server/db/migrate";

export default async function globalSetup() {
  const owner = process.env.DATABASE_OWNER_URL_TEST;
  if (!owner || !/\/[^/]*_test(\?|$)/.test(owner)) {
    throw new Error("DATABASE_OWNER_URL_TEST must point at a database whose name ends in _test.");
  }
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
}
