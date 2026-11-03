// Login throttling (spec §3.3). After 5 failures for an email within 15 minutes
// (since its last success), each further attempt must wait 1 s, 2 s, 4 s … capped at 60 s
// after the previous failure. Stored in login_attempts so it survives restarts.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { loginAttempts } from "../db/schema";

export const THROTTLE_WINDOW_MINUTES = 15;
export const FREE_FAILURES = 5;
export const MAX_DELAY_SECONDS = 60;

export function hashEmail(email: string): Buffer {
  return createHash("sha256").update(email.trim().toLowerCase()).digest();
}

/** Delay required after `failures` recent failures (0 while under the free allowance). */
export function requiredDelaySeconds(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(MAX_DELAY_SECONDS, 2 ** (failures - FREE_FAILURES));
}

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export async function checkLoginThrottle(
  db: DbOrTx,
  emailHash: Buffer,
  now = new Date(),
): Promise<ThrottleDecision> {
  const windowStart = new Date(now.getTime() - THROTTLE_WINDOW_MINUTES * 60_000);
  const result = await db.execute<{ failures: number; last_failure: Date | string | null }>(sql`
    WITH last_success AS (
      SELECT max(created_at) AS at FROM login_attempts
      WHERE email_hash = ${emailHash} AND succeeded
    )
    SELECT count(*)::int AS failures, max(created_at) AS last_failure
    FROM login_attempts
    WHERE email_hash = ${emailHash}
      AND NOT succeeded
      AND created_at > ${windowStart.toISOString()}::timestamptz
      AND created_at > coalesce((SELECT at FROM last_success), '-infinity'::timestamptz)
  `);
  const row = result.rows[0];
  const delay = requiredDelaySeconds(row?.failures ?? 0);
  if (delay === 0 || !row?.last_failure) return { allowed: true };
  const waitUntil = new Date(row.last_failure).getTime() + delay * 1000;
  if (now.getTime() >= waitUntil) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.ceil((waitUntil - now.getTime()) / 1000) };
}

export async function recordLoginAttempt(
  db: DbOrTx,
  emailHash: Buffer,
  succeeded: boolean,
  ip: string | null,
  now = new Date(),
): Promise<void> {
  await db.insert(loginAttempts).values({ emailHash, succeeded, ip, createdAt: now, updatedAt: now });
}

/** Operational table, not audit: rows older than 30 days are pruned (scheduled from Phase 3a). */
export async function pruneLoginAttempts(db: DbOrTx, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 3_600_000);
  const result = await db.execute(
    sql`DELETE FROM login_attempts WHERE created_at < ${cutoff.toISOString()}::timestamptz`,
  );
  return result.rowCount ?? 0;
}
