// Applies Drizzle migrations, then the job store, as the owner role. Pure (no server-only) — used by
// scripts/db-migrate.ts and the test-database reset.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { setupJobStore } from "../jobs/setup";
import { MIGRATIONS_FOLDER } from "./migrations-info";

export async function runMigrations(ownerUrl: string, folder = MIGRATIONS_FOLDER): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: "sitesync-migrate" });
  await client.connect();
  try {
    const who = await client.query<{ current_user: string }>("SELECT current_user");
    if (who.rows[0]?.current_user === "sitesync_app") {
      throw new Error("Migrations must run as sitesync_owner, not the runtime role (check DATABASE_OWNER_URL).");
    }
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
  // pg-boss owns its schema; it is installed/upgraded here, as the owner (decision 0009).
  await setupJobStore(ownerUrl);
}
