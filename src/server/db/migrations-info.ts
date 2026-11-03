// Reads the Drizzle migration journal and the applied-migrations table.
// Pure (no server-only) so /health and scripts/db-status.ts share it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

type JournalEntry = { idx: number; tag: string; when: number };

export type MigrationStatus = {
  total: number;
  applied: string[];
  pending: string[];
  /** Applied rows whose hash doesn't match any migration file (edited after apply). */
  unknown: number;
};

export function readJournal(folder = MIGRATIONS_FOLDER): JournalEntry[] {
  const raw = readFileSync(path.join(folder, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function fileHash(folder: string, tag: string): string {
  // Drizzle stores sha256 of the raw migration file.
  return createHash("sha256").update(readFileSync(path.join(folder, `${tag}.sql`), "utf8")).digest("hex");
}

export async function migrationStatus(
  client: pg.Pool | pg.PoolClient | pg.Client,
  folder = MIGRATIONS_FOLDER,
): Promise<MigrationStatus> {
  const entries = readJournal(folder);
  const exists = await client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  const rows = exists.rows[0]?.present
    ? (await client.query<{ hash: string }>("SELECT hash FROM drizzle.__drizzle_migrations")).rows
    : [];
  const appliedHashes = new Set(rows.map((row) => row.hash));
  const applied: string[] = [];
  const pending: string[] = [];
  const known = new Set<string>();
  for (const entry of entries) {
    const hash = fileHash(folder, entry.tag);
    known.add(hash);
    (appliedHashes.has(hash) ? applied : pending).push(entry.tag);
  }
  const unknown = rows.filter((row) => !known.has(row.hash)).length;
  return { total: entries.length, applied, pending, unknown };
}
