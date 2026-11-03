import packageJson from "../../../package.json";
import { pool } from "@/server/db";
import { migrationStatus } from "@/server/db/migrations-info";

// Spec §9 screen 3: version, DB reachability, migration state. No auth, no secrets.
export const dynamic = "force-dynamic";

export async function GET() {
  const body: {
    status: "ok" | "degraded" | "error";
    version: string;
    database: { reachable: boolean };
    migrations: { total: number; applied: number; pending: string[]; unknown: number } | null;
  } = { status: "ok", version: packageJson.version, database: { reachable: false }, migrations: null };

  try {
    const client = await pool().connect();
    try {
      await client.query("SELECT 1");
      body.database.reachable = true;
      const status = await migrationStatus(client);
      body.migrations = {
        total: status.total,
        applied: status.applied.length,
        pending: status.pending,
        unknown: status.unknown,
      };
      if (status.pending.length > 0 || status.unknown > 0) body.status = "degraded";
    } finally {
      client.release();
    }
  } catch {
    body.status = "error";
  }

  return Response.json(body, {
    status: body.status === "error" ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}
