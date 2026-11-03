// Session tokens (spec §3.2). The cookie holds a random 32-byte token; the DB
// stores only its SHA-256.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { sessions, users } from "../db/schema";
import type { SessionPolicy } from "./policy";

export const SESSION_COOKIE = "ss_session";
const TOKEN_BYTES = 32;
const IDLE_BUMP_INTERVAL_MS = 60_000;

export type SessionMeta = { userAgent?: string | null; ip?: string | null };

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
};

export type ValidSession = {
  sessionId: string;
  expiresAt: Date;
  user: SessionUser;
};

/** Decodes a cookie value to the hash stored in the DB, or null if malformed. */
export function hashSessionToken(token: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== TOKEN_BYTES) return null;
  return createHash("sha256").update(raw).digest();
}

export async function createSession(
  db: DbOrTx,
  userId: string,
  policy: SessionPolicy,
  meta: SessionMeta = {},
  now = new Date(),
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const raw = randomBytes(TOKEN_BYTES);
  const token = raw.toString("base64url");
  const expiresAt = new Date(now.getTime() + policy.absoluteHours * 3_600_000);
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + policy.idleMinutes * 60_000, expiresAt.getTime()),
  );
  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: createHash("sha256").update(raw).digest(),
      expiresAt,
      idleExpiresAt,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 512) : null,
      ip: meta.ip ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error("session insert returned no row");
  return { token, sessionId: row.id, expiresAt };
}

/**
 * Returns the session if it is unrevoked, inside both the absolute and idle
 * windows, and its user is enabled. Slides the idle window (at most once a minute).
 */
export async function validateSessionToken(
  db: DbOrTx,
  token: string,
  policy: SessionPolicy,
  now = new Date(),
): Promise<ValidSession | null> {
  const tokenHash = hashSessionToken(token);
  if (!tokenHash) return null;
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      idleExpiresAt: sessions.idleExpiresAt,
      revokedAt: sessions.revokedAt,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt || row.disabledAt) return null;
  if (now >= row.expiresAt || now >= row.idleExpiresAt) return null;

  const nextIdle = new Date(
    Math.min(now.getTime() + policy.idleMinutes * 60_000, row.expiresAt.getTime()),
  );
  if (nextIdle.getTime() - row.idleExpiresAt.getTime() >= IDLE_BUMP_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ idleExpiresAt: nextIdle })
      .where(and(eq(sessions.id, row.sessionId), isNull(sessions.revokedAt)));
  }

  return {
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
    user: { id: row.userId, email: row.email, displayName: row.displayName, role: row.role },
  };
}

export async function revokeSession(db: DbOrTx, sessionId: string, now = new Date()): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Used on password change (spec §3.2) and when disabling a user. */
export async function revokeAllSessionsForUser(
  db: DbOrTx,
  userId: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
