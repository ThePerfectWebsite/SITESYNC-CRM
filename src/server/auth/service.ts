// Auth use-cases (spec §4): first-run setup, login, logout. Takes the db as a
// parameter so integration tests can run against the test database.
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db } from "../db/client";
import { appSettings, users } from "../db/schema";
import {
  checkPasswordPolicy,
  dummyPasswordRecord,
  hashPassword,
  needsRehash,
  verifyPassword,
  PASSWORD_MAX,
} from "./password";
import { getSessionPolicy } from "./policy";
import { createSession, revokeSession, type SessionMeta } from "./session";
import { checkLoginThrottle, hashEmail, recordLoginAttempt } from "./throttle";

export type RequestMeta = SessionMeta & { requestId?: string };

const email = z
  .string()
  .trim()
  .min(3, "Enter your email address.")
  .max(254, "Email is too long.")
  .pipe(z.email({ message: "Enter a valid email address." }));

export const setupSchema = z
  .object({
    email,
    displayName: z.string().trim().min(1, "Enter your name.").max(200, "Name is too long."),
    password: z.string().max(PASSWORD_MAX * 4),
    confirmPassword: z.string().max(PASSWORD_MAX * 4),
  })
  .superRefine((input, ctx) => {
    const problem = checkPasswordPolicy(input.password);
    if (problem) ctx.addIssue({ code: "custom", path: ["password"], message: problem });
    if (input.password !== input.confirmPassword) {
      ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: "Passwords don't match." });
    }
  });

export type SetupInput = z.input<typeof setupSchema>;

export class SetupAlreadyCompletedError extends Error {
  constructor() {
    super("Setup has already been completed.");
    this.name = "SetupAlreadyCompletedError";
  }
}

// Users are never deleted, so once one exists the answer can be cached for the process.
let knownToHaveUsers = false;

export async function hasAnyUser(db: Db): Promise<boolean> {
  if (knownToHaveUsers) return true;
  const result = await db.execute<{ present: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM users) AS present`,
  );
  knownToHaveUsers = result.rows[0]?.present === true;
  return knownToHaveUsers;
}

/** Test hook: the cache must not leak between tests that reset the database. */
export function resetUserCacheForTests(): void {
  knownToHaveUsers = false;
}

/**
 * Creates the first admin. Re-checks emptiness under an EXCLUSIVE lock on users,
 * so concurrent submissions create exactly one admin.
 */
export async function setupFirstAdmin(
  db: Db,
  input: z.output<typeof setupSchema>,
  meta: RequestMeta = {},
): Promise<{ userId: string }> {
  // Hash outside the transaction to keep the lock short.
  const password = await hashPassword(input.password);
  const now = new Date();
  const userId = await db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`);
    const existing = await tx.execute<{ present: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM users) AS present`,
    );
    if (existing.rows[0]?.present) throw new SetupAlreadyCompletedError();

    const [user] = await tx
      .insert(users)
      .values({
        email: input.email,
        displayName: input.displayName,
        role: "admin",
        passwordHash: password.hash,
        passwordSalt: password.salt,
        passwordParams: password.params,
        passwordChangedAt: now,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("user insert returned no row");

    await tx
      .insert(appSettings)
      .values({ key: "app.first_run_completed_at", value: now.toISOString(), updatedBy: user.id })
      .onConflictDoNothing({ target: appSettings.key });

    await writeAudit(tx, {
      actor: { type: "user", userId: user.id },
      action: "auth.setup_completed",
      subjectType: "user",
      subjectId: user.id,
      summary: `First admin account created for ${input.displayName}`,
      after: { email: input.email, displayName: input.displayName, role: "admin" },
      metadata: { userAgent: meta.userAgent ?? null, ip: meta.ip ?? null },
      requestId: meta.requestId,
    });
    return user.id;
  });
  knownToHaveUsers = true;
  return { userId };
}

export const loginSchema = z.object({
  email: z.string().trim().min(1, "Enter your email address.").max(254),
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX * 4),
});

export type LoginResult =
  | { ok: true; token: string; userId: string; expiresAt: Date }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "throttled"; retryAfterSeconds: number };

/**
 * Verifies credentials under throttling. Unknown emails and disabled users take
 * the same path (and time) as wrong passwords, and all return the same result.
 * `previousSessionId` (the cookie presented, if any) is revoked so login rotates the session.
 */
export async function login(
  db: Db,
  input: z.output<typeof loginSchema>,
  meta: RequestMeta = {},
  previousSessionId?: string | null,
): Promise<LoginResult> {
  const emailHash = hashEmail(input.email);
  const throttle = await checkLoginThrottle(db, emailHash);
  if (!throttle.allowed) {
    return { ok: false, reason: "throttled", retryAfterSeconds: throttle.retryAfterSeconds };
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email.trim()))
    .limit(1);

  const record = user
    ? { hash: user.passwordHash, salt: user.passwordSalt, params: user.passwordParams }
    : await dummyPasswordRecord();
  const passwordOk = await verifyPassword(input.password, record);
  const ok = Boolean(user && passwordOk && !user.disabledAt);

  if (!ok || !user) {
    await recordLoginAttempt(db, emailHash, false, meta.ip ?? null);
    await writeAudit(db, {
      actor: { type: "system" },
      action: "auth.login_failed",
      subjectType: "user",
      subjectId: user?.id ?? null,
      summary: "Failed sign-in attempt",
      metadata: {
        reason: !user ? "unknown_email" : user.disabledAt ? "user_disabled" : "wrong_password",
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
      requestId: meta.requestId,
    });
    return { ok: false, reason: "invalid" };
  }

  const policy = await getSessionPolicy(db);
  const rehash = needsRehash(user.passwordParams) ? await hashPassword(input.password) : null;

  const session = await db.transaction(async (tx) => {
    const now = new Date();
    if (previousSessionId) await revokeSession(tx, previousSessionId, now);
    await tx
      .update(users)
      .set({
        lastLoginAt: now,
        ...(rehash
          ? { passwordHash: rehash.hash, passwordSalt: rehash.salt, passwordParams: rehash.params }
          : {}),
      })
      .where(eq(users.id, user.id));
    await recordLoginAttempt(tx, emailHash, true, meta.ip ?? null, now);
    const created = await createSession(tx, user.id, policy, meta, now);
    await writeAudit(tx, {
      actor: { type: "user", userId: user.id },
      action: "auth.login_succeeded",
      subjectType: "user",
      subjectId: user.id,
      summary: `${user.displayName} signed in`,
      metadata: {
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        rehashed: Boolean(rehash),
      },
      requestId: meta.requestId,
    });
    return created;
  });

  return { ok: true, token: session.token, userId: user.id, expiresAt: session.expiresAt };
}

export async function logout(
  db: Db,
  current: { sessionId: string; userId: string; displayName: string },
  meta: RequestMeta = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await revokeSession(tx, current.sessionId);
    await writeAudit(tx, {
      actor: { type: "user", userId: current.userId },
      action: "auth.logout",
      subjectType: "user",
      subjectId: current.userId,
      summary: `${current.displayName} signed out`,
      requestId: meta.requestId,
    });
  });
}

export type ReauthResult = { ok: true } | { ok: false; reason: "invalid" } | { ok: false; reason: "throttled"; retryAfterSeconds: number };

/**
 * Re-enters the signed-in operator's password (spec §8.3 final confirmation).
 * Shares login's throttle: failures count toward it, and are audited.
 */
export async function verifyOperatorPassword(
  db: Db,
  userId: string,
  password: string,
  meta: RequestMeta & { purpose: string; subjectType?: string; subjectId?: string } = { purpose: "reauth" },
): Promise<ReauthResult> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.disabledAt) return { ok: false, reason: "invalid" };
  const emailHash = hashEmail(user.email);
  const throttle = await checkLoginThrottle(db, emailHash);
  if (!throttle.allowed) return { ok: false, reason: "throttled", retryAfterSeconds: throttle.retryAfterSeconds };
  const ok =
    password.length > 0 &&
    password.length <= PASSWORD_MAX &&
    (await verifyPassword(password, { hash: user.passwordHash, salt: user.passwordSalt, params: user.passwordParams }));
  await recordLoginAttempt(db, emailHash, ok, meta.ip ?? null);
  if (!ok) {
    await writeAudit(db, {
      actor: { type: "user", userId },
      action: "auth.reauth_failed",
      subjectType: meta.subjectType ?? "user",
      subjectId: meta.subjectId ?? userId,
      summary: `Wrong password at ${meta.purpose}`,
      metadata: { purpose: meta.purpose, ip: meta.ip ?? null },
      requestId: meta.requestId,
    });
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}
