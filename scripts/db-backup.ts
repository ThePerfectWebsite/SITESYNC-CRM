// npm run db:backup — custom-format pg_dump of the app database into backups/
// (git-ignored), then records backup.last_run in app_settings (spec §10).
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { describeError } from "../src/server/redact";
import { composeExec, utcStamp } from "./docker-db";
import { loadEnv, requireVar } from "./load-env";

loadEnv();
const superuser = requireVar("POSTGRES_USER");
const database = requireVar("POSTGRES_DB");
const ownerUrl = requireVar("DATABASE_OWNER_URL");

mkdirSync("backups", { recursive: true });
const file = path.join("backups", `sitesync-${utcStamp()}.dump`);

try {
  await composeExec(["pg_dump", "-Fc", "-U", superuser, database], { stdoutFile: file });
  const bytes = statSync(file).size;
  if (bytes === 0) throw new Error("pg_dump produced an empty file");

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ('backup.last_run', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ at: new Date().toISOString(), file: path.basename(file), bytes })],
    );
  } finally {
    await client.end();
  }
  console.log(`Backup written: ${file} (${bytes} bytes)`);
} catch (error) {
  console.error(`Backup failed: ${describeError(error)}`);
  process.exit(1);
}
