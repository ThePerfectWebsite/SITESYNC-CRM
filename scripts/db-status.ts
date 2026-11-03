// npm run db:status [-- --test]  — lists applied and pending migrations.
import pg from "pg";
import { migrationStatus } from "../src/server/db/migrations-info";
import { describeError } from "../src/server/redact";
import { loadEnv, requireVar } from "./load-env";

loadEnv();
const useTest = process.argv.includes("--test");
const client = new pg.Client({
  connectionString: requireVar(useTest ? "DATABASE_OWNER_URL_TEST" : "DATABASE_OWNER_URL"),
});

try {
  await client.connect();
  const status = await migrationStatus(client);
  for (const tag of status.applied) console.log(`  applied  ${tag}`);
  for (const tag of status.pending) console.log(`  PENDING  ${tag}`);
  console.log(`${status.applied.length}/${status.total} applied, ${status.pending.length} pending.`);
  if (status.unknown > 0) {
    console.log(`WARNING: ${status.unknown} applied migration(s) don't match any file (edited after apply?).`);
  }
  process.exitCode = status.pending.length > 0 || status.unknown > 0 ? 2 : 0;
} catch (error) {
  console.error(`Status check failed: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
