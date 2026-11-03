// npm run db:restore -- <backups/file.dump>
// Restores into a NEW database (sitesync_restore_<timestamp>), verifies it, prints
// a report, then — after typed confirmation — tells the operator how to switch.
// It never edits env files and never drops the current database (spec §10).
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import pg from "pg";
import { migrationStatus } from "../src/server/db/migrations-info";
import { describeError } from "../src/server/redact";
import { composeExec, utcStamp, withDatabase } from "./docker-db";
import { loadEnv, requireVar } from "./load-env";

loadEnv();
const file = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!file || !existsSync(file)) {
  console.error("Usage: npm run db:restore -- <path to .dump file>");
  process.exit(1);
}
const superuser = requireVar("POSTGRES_USER");
const ownerUrl = requireVar("DATABASE_OWNER_URL");
const appUrl = requireVar("DATABASE_URL");
const target = `sitesync_restore_${utcStamp().toLowerCase()}`;

async function verify(): Promise<boolean> {
  const client = new pg.Client({ connectionString: withDatabase(ownerUrl, target) });
  await client.connect();
  try {
    const migrations = await migrationStatus(client);
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const counts: [string, number][] = [];
    for (const { table_name } of tables.rows) {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${pg.escapeIdentifier(table_name)}`,
      );
      counts.push([table_name, result.rows[0]?.n ?? 0]);
    }
    const triggers = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'public.audit_events'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    const triggerNames = triggers.rows.map((row) => row.tgname);
    const auditProtected =
      triggerNames.includes("audit_events_reject_update_delete") &&
      triggerNames.includes("audit_events_reject_truncate");

    console.log(`\nRestore report — database ${target}`);
    console.log(`  Migrations: ${migrations.applied.length}/${migrations.total} applied` +
      (migrations.pending.length ? `, PENDING: ${migrations.pending.join(", ")}` : "") +
      (migrations.unknown ? `, ${migrations.unknown} unknown` : ""));
    console.log("  Row counts:");
    for (const [name, n] of counts) console.log(`    ${name.padEnd(28)} ${n}`);
    console.log(`  Audit append-only triggers: ${auditProtected ? "present" : "MISSING"} (${triggerNames.join(", ") || "none"})`);

    const ok = migrations.pending.length === 0 && migrations.unknown === 0 && auditProtected;
    console.log(`  Verification: ${ok ? "PASSED" : "FAILED"}\n`);
    return ok;
  } finally {
    await client.end();
  }
}

try {
  console.log(`Creating ${target} and restoring ${file} …`);
  await composeExec(["createdb", "-U", superuser, "-O", "sitesync_owner", target]);
  await composeExec([
    "psql", "-v", "ON_ERROR_STOP=1", "-U", superuser, "-d", target, "-c",
    `REVOKE ALL ON DATABASE ${target} FROM PUBLIC; GRANT CONNECT ON DATABASE ${target} TO sitesync_app;`,
  ]);
  await composeExec(["pg_restore", "--exit-on-error", "-U", superuser, "-d", target], { stdinFile: file });

  const ok = await verify();
  if (!ok) {
    console.error(`Verification failed. ${target} was left in place for inspection; nothing was switched.`);
    process.exit(2);
  }

  if (!process.stdin.isTTY) {
    console.log(`Non-interactive run: not switching. Restored database: ${target}`);
    process.exit(0);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type "switch to ${target}" to see how to point the app at it: `);
  rl.close();
  if (answer.trim() !== `switch to ${target}`) {
    console.log(`Not switching. ${target} remains available.`);
    process.exit(0);
  }
  console.log(`
To switch, stop the app and edit .env yourself (this script does not change it):
  DATABASE_URL=${withDatabase(appUrl, target).replace(/:[^:@/]+@/, ":<SITESYNC_APP_PASSWORD>@")}
  DATABASE_OWNER_URL=${withDatabase(ownerUrl, target).replace(/:[^:@/]+@/, ":<SITESYNC_OWNER_PASSWORD>@")}
Then start the app and check /health. The previous database was not dropped.
Note: db:backup dumps POSTGRES_DB — set POSTGRES_DB=${target} too if this becomes permanent.`);
} catch (error) {
  console.error(`Restore failed: ${describeError(error)}`);
  process.exit(1);
}
