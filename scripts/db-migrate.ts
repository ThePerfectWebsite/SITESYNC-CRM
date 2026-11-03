// npm run db:migrate [-- --test]  — applies migrations as sitesync_owner.
import { runMigrations } from "../src/server/db/migrate";
import { describeError } from "../src/server/redact";
import { loadEnv, requireVar } from "./load-env";

loadEnv();
const useTest = process.argv.includes("--test");
const url = requireVar(useTest ? "DATABASE_OWNER_URL_TEST" : "DATABASE_OWNER_URL");

try {
  await runMigrations(url);
  console.log(`Migrations applied to ${useTest ? "test" : "app"} database.`);
} catch (error) {
  console.error(`Migration failed: ${describeError(error)}`);
  process.exit(1);
}
