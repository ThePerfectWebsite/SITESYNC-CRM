import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { appSettings, auditEvents, users } from "@/server/db/schema";
import {
  hasAnyUser,
  resetUserCacheForTests,
  SetupAlreadyCompletedError,
  setupFirstAdmin,
  setupSchema,
} from "@/server/auth/service";
import { appDb, resetTestDatabase } from "../support/test-db";

const admin = setupSchema.parse({
  email: "Operator@Example.test",
  displayName: "Operator",
  password: "a sufficiently long passphrase",
  confirmPassword: "a sufficiently long passphrase",
});

let db: Db;
let pool: pg.Pool;

beforeEach(async () => {
  await pool?.end();
  await resetTestDatabase();
  ({ db, pool } = appDb());
});

afterAll(async () => {
  await pool?.end();
});

describe("first-run setup", () => {
  it("creates exactly one admin, records first run and audits it", async () => {
    expect(await hasAnyUser(db)).toBe(false);
    const { userId } = await setupFirstAdmin(db, admin, { requestId: crypto.randomUUID() });

    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: userId, role: "admin", displayName: "Operator" });
    expect(rows[0]!.passwordHash).not.toContain("passphrase");

    const [setting] = await db.select().from(appSettings).where(eq(appSettings.key, "app.first_run_completed_at"));
    expect(setting).toBeDefined();

    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "auth.setup_completed"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: "user", actorUserId: userId, subjectId: userId });
    expect(JSON.stringify(events[0])).not.toContain("passphrase");
  });

  it("refuses a second setup", async () => {
    await setupFirstAdmin(db, admin);
    await expect(
      setupFirstAdmin(db, { ...admin, email: "someone-else@example.test" }),
    ).rejects.toBeInstanceOf(SetupAlreadyCompletedError);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("refuses a second setup even when the in-process cache says no users", async () => {
    await setupFirstAdmin(db, admin);
    resetUserCacheForTests();
    await expect(setupFirstAdmin(db, { ...admin, email: "x@example.test" })).rejects.toBeInstanceOf(
      SetupAlreadyCompletedError,
    );
  });

  it("creates exactly one admin under concurrent submissions", async () => {
    const attempts = await Promise.allSettled(
      ["a", "b", "c", "d"].map((who) => setupFirstAdmin(db, { ...admin, email: `${who}@example.test` })),
    );
    const fulfilled = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(SetupAlreadyCompletedError);
    }
    expect(await db.select().from(users)).toHaveLength(1);
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.action, "auth.setup_completed")),
    ).toHaveLength(1);
  });

  it("validates input: email, name, policy and confirmation", () => {
    const result = setupSchema.safeParse({
      email: "not-an-email",
      displayName: "",
      password: "password1234",
      confirmPassword: "different",
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((issue) => issue.path[0]);
    expect(paths).toEqual(expect.arrayContaining(["email", "displayName", "password", "confirmPassword"]));
  });
});
