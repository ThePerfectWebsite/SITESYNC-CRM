import { and, eq, isNull } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "@/server/auth/password";
import { DEFAULT_SESSION_POLICY } from "@/server/auth/policy";
import { login, logout } from "@/server/auth/service";
import {
  createSession,
  revokeAllSessionsForUser,
  revokeSession,
  validateSessionToken,
} from "@/server/auth/session";
import { checkLoginThrottle, hashEmail, pruneLoginAttempts, recordLoginAttempt } from "@/server/auth/throttle";
import type { Db } from "@/server/db/client";
import { appSettings, auditEvents, loginAttempts, sessions, users } from "@/server/db/schema";
import { appDb, resetTestDatabase } from "../support/test-db";

const EMAIL = "operator@example.test";
const PASSWORD = "the operator passphrase";
const WEAK = { N: 1024, r: 8, p: 1, keylen: 64 };

let db: Db;
let pool: pg.Pool;
let userId: string;

async function createUser(params = WEAK) {
  const pw = await hashPassword(PASSWORD, params);
  const [row] = await db
    .insert(users)
    .values({
      email: EMAIL,
      displayName: "Operator",
      passwordHash: pw.hash,
      passwordSalt: pw.salt,
      passwordParams: pw.params,
      passwordChangedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
}

beforeEach(async () => {
  await pool?.end();
  await resetTestDatabase();
  ({ db, pool } = appDb());
  userId = await createUser();
});

afterAll(async () => {
  await pool?.end();
});

describe("login", () => {
  it("succeeds with the right password, creating a valid session and audit event", async () => {
    const result = await login(db, { email: "  OPERATOR@example.test ", password: PASSWORD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = await validateSessionToken(db, result.token, DEFAULT_SESSION_POLICY);
    expect(session?.user.id).toBe(userId);

    const stored = await db.select().from(sessions);
    expect(stored).toHaveLength(1);
    // Only the hash is stored, never the raw token.
    expect(stored[0]!.tokenHash.toString("base64url")).not.toBe(result.token);

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user!.lastLoginAt).not.toBeNull();
    expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "auth.login_succeeded"))).toHaveLength(1);
  });

  it("returns the same generic failure for a wrong password and an unknown email", async () => {
    const wrong = await login(db, { email: EMAIL, password: "not the passphrase" });
    const unknown = await login(db, { email: "nobody@example.test", password: PASSWORD });
    expect(wrong).toEqual({ ok: false, reason: "invalid" });
    expect(unknown).toEqual({ ok: false, reason: "invalid" });
    expect(await db.select().from(sessions)).toHaveLength(0);
    const failures = await db.select().from(auditEvents).where(eq(auditEvents.action, "auth.login_failed"));
    expect(failures).toHaveLength(2);
    expect(JSON.stringify(failures)).not.toContain("not the passphrase");
  });

  it("refuses disabled users", async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    expect(await login(db, { email: EMAIL, password: PASSWORD })).toEqual({ ok: false, reason: "invalid" });
  });

  it("rehashes a password stored with outdated params on successful login", async () => {
    await login(db, { email: EMAIL, password: PASSWORD });
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user!.passwordParams).toEqual({ N: 131072, r: 8, p: 1, keylen: 64 });
    // And the new hash still verifies.
    expect((await login(db, { email: EMAIL, password: PASSWORD })).ok).toBe(true);
  });

  it("rotates the session: the previous session is revoked on login", async () => {
    const first = await login(db, { email: EMAIL, password: PASSWORD });
    if (!first.ok) throw new Error("login failed");
    const firstSession = await validateSessionToken(db, first.token, DEFAULT_SESSION_POLICY);
    const second = await login(db, { email: EMAIL, password: PASSWORD }, {}, firstSession!.sessionId);
    if (!second.ok) throw new Error("login failed");
    expect(second.token).not.toBe(first.token);
    expect(await validateSessionToken(db, first.token, DEFAULT_SESSION_POLICY)).toBeNull();
    expect(await validateSessionToken(db, second.token, DEFAULT_SESSION_POLICY)).not.toBeNull();
  });
});

describe("login throttling", () => {
  const emailHash = hashEmail(EMAIL);

  async function failures(count: number, at: Date) {
    for (let i = 0; i < count; i += 1) await recordLoginAttempt(db, emailHash, false, null, at);
  }

  it("allows the first five failures without delay", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await login(db, { email: EMAIL, password: "wrong password!!" })).ok).toBe(false);
    }
    expect(await db.select().from(loginAttempts)).toHaveLength(5);
  });

  it("throttles after five failures, even with the right password, without checking it", async () => {
    await failures(5, new Date());
    const result = await login(db, { email: EMAIL, password: PASSWORD });
    expect(result).toMatchObject({ ok: false, reason: "throttled" });
    if (result.ok || result.reason !== "throttled") return;
    expect(result.retryAfterSeconds).toBe(1);
    // A throttled attempt is not recorded and creates no session.
    expect(await db.select().from(loginAttempts)).toHaveLength(5);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("grows the delay with each failure and caps it at 60 s", async () => {
    const now = new Date();
    await failures(8, now);
    expect(await checkLoginThrottle(db, emailHash, now)).toEqual({ allowed: false, retryAfterSeconds: 8 });
    await failures(20, now);
    expect(await checkLoginThrottle(db, emailHash, now)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("allows an attempt once the delay since the last failure has passed", async () => {
    await failures(7, new Date(Date.now() - 5_000)); // needs 4 s
    expect((await login(db, { email: EMAIL, password: PASSWORD })).ok).toBe(true);
  });

  it("ignores failures older than 15 minutes", async () => {
    await failures(10, new Date(Date.now() - 16 * 60_000));
    expect(await checkLoginThrottle(db, emailHash)).toEqual({ allowed: true });
  });

  it("resets after a successful login", async () => {
    await failures(6, new Date(Date.now() - 10_000));
    await recordLoginAttempt(db, emailHash, true, null, new Date(Date.now() - 5_000));
    await failures(1, new Date());
    expect(await checkLoginThrottle(db, emailHash)).toEqual({ allowed: true });
  });

  it("is per email: another address is unaffected", async () => {
    await failures(10, new Date());
    expect(await checkLoginThrottle(db, hashEmail("other@example.test"))).toEqual({ allowed: true });
  });

  it("prunes attempts older than 30 days", async () => {
    await failures(2, new Date(Date.now() - 31 * 24 * 3_600_000));
    await failures(1, new Date());
    expect(await pruneLoginAttempts(db)).toBe(2);
    expect(await db.select().from(loginAttempts)).toHaveLength(1);
  });
});

describe("sessions", () => {
  const policy = DEFAULT_SESSION_POLICY; // idle 2 h, absolute 12 h
  const hours = (n: number) => n * 3_600_000;

  it("expires after the idle window without activity", async () => {
    const t0 = new Date("2026-11-03T08:00:00Z");
    const { token } = await createSession(db, userId, policy, {}, t0);
    expect(await validateSessionToken(db, token, policy, new Date(t0.getTime() + hours(1.9)))).not.toBeNull();
    // That validation slid the idle window to 1.9 h + 2 h.
    expect(await validateSessionToken(db, token, policy, new Date(t0.getTime() + hours(3.8)))).not.toBeNull();
    expect(await validateSessionToken(db, token, policy, new Date(t0.getTime() + hours(5.81)))).toBeNull();
  });

  it("bumps the idle expiry at most once a minute", async () => {
    const t0 = new Date("2026-11-03T08:00:00Z");
    const { token, sessionId } = await createSession(db, userId, policy, {}, t0);
    const idleOf = async () =>
      (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0]!.idleExpiresAt.getTime();
    const initial = await idleOf();
    await validateSessionToken(db, token, policy, new Date(t0.getTime() + 30_000));
    expect(await idleOf()).toBe(initial);
    await validateSessionToken(db, token, policy, new Date(t0.getTime() + 90_000));
    expect(await idleOf()).toBe(initial + 90_000);
  });

  it("expires at the absolute limit even with constant activity", async () => {
    const t0 = new Date("2026-11-03T08:00:00Z");
    const { token } = await createSession(db, userId, policy, {}, t0);
    for (let h = 1; h < 12; h += 1) {
      expect(await validateSessionToken(db, token, policy, new Date(t0.getTime() + hours(h)))).not.toBeNull();
    }
    expect(await validateSessionToken(db, token, policy, new Date(t0.getTime() + hours(12)))).toBeNull();
  });

  it("never slides the idle expiry past the absolute expiry", async () => {
    const t0 = new Date("2026-11-03T08:00:00Z");
    const { token, sessionId, expiresAt } = await createSession(db, userId, policy, {}, t0);
    for (let h = 1; h <= 11; h += 1) {
      await validateSessionToken(db, token, policy, new Date(t0.getTime() + hours(h)));
    }
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row!.idleExpiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it("honours session lifetimes from app_settings", async () => {
    await db.insert(appSettings).values([
      { key: "session.idle_minutes", value: 30 },
      { key: "session.absolute_hours", value: 1 },
    ]);
    const result = await login(db, { email: EMAIL, password: PASSWORD });
    if (!result.ok) throw new Error("login failed");
    const [row] = await db.select().from(sessions);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(hours(1));
    expect(row!.idleExpiresAt.getTime() - row!.createdAt.getTime()).toBe(30 * 60_000);
  });

  it("rejects revoked sessions, and revoke-all revokes every active session", async () => {
    const a = await createSession(db, userId, policy);
    const b = await createSession(db, userId, policy);
    await revokeSession(db, a.sessionId);
    expect(await validateSessionToken(db, a.token, policy)).toBeNull();
    expect(await validateSessionToken(db, b.token, policy)).not.toBeNull();
    await revokeAllSessionsForUser(db, userId);
    expect(await validateSessionToken(db, b.token, policy)).toBeNull();
    expect(await db.select().from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))).toHaveLength(0);
  });

  it("rejects sessions of a disabled user", async () => {
    const { token } = await createSession(db, userId, policy);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    expect(await validateSessionToken(db, token, policy)).toBeNull();
  });

  it("rejects malformed and unknown tokens", async () => {
    expect(await validateSessionToken(db, "garbage", policy)).toBeNull();
    expect(await validateSessionToken(db, Buffer.alloc(32, 1).toString("base64url"), policy)).toBeNull();
  });

  it("logout revokes the session and writes an audit event", async () => {
    const { token, sessionId } = await createSession(db, userId, policy);
    await logout(db, { sessionId, userId, displayName: "Operator" });
    expect(await validateSessionToken(db, token, policy)).toBeNull();
    expect(await db.select().from(auditEvents).where(eq(auditEvents.action, "auth.logout"))).toHaveLength(1);
  });
});
