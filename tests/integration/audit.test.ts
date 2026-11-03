import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "@/server/audit";
import type { Db } from "@/server/db/client";
import { auditEvents } from "@/server/db/schema";
import { appDb, ownerClient, resetTestDatabase } from "../support/test-db";

let db: Db;
let pool: pg.Pool;
let owner: pg.Client;
let eventId: string;

beforeAll(async () => {
  await resetTestDatabase();
  ({ db, pool } = appDb());
  owner = await ownerClient();
  eventId = await writeAudit(db, {
    actor: { type: "system" },
    action: "test.event_written",
    subjectType: "test",
    summary: "An audit event",
    metadata: { apiKey: "should-not-be-stored", note: "fine" },
  });
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

describe("audit_events is append-only", () => {
  describe("as the owner role — the trigger rejects mutation", () => {
    it("rejects UPDATE", async () => {
      await expect(owner.query("UPDATE audit_events SET summary = 'changed' WHERE id = $1", [eventId])).rejects.toThrow(
        /append-only table: UPDATE is not permitted/,
      );
    });

    it("rejects DELETE", async () => {
      await expect(owner.query("DELETE FROM audit_events WHERE id = $1", [eventId])).rejects.toThrow(
        /append-only table: DELETE is not permitted/,
      );
    });

    it("rejects TRUNCATE", async () => {
      // CASCADE gets past the FK from stage_history, so the trigger is what refuses.
      await expect(owner.query("TRUNCATE audit_events CASCADE")).rejects.toThrow(
        /append-only table: TRUNCATE is not permitted/,
      );
      await expect(owner.query("TRUNCATE audit_events")).rejects.toThrow();
    });
  });

  describe("as the runtime role — no privilege to try", () => {
    it.each([
      ["UPDATE audit_events SET summary = 'changed'"],
      ["DELETE FROM audit_events"],
      ["TRUNCATE audit_events"],
    ])("%s is denied", async (statement) => {
      await expect(pool.query(statement)).rejects.toThrow(/permission denied/);
    });

    it("cannot alter the table or drop the trigger", async () => {
      await expect(pool.query("ALTER TABLE audit_events DISABLE TRIGGER ALL")).rejects.toThrow(/must be owner/);
      await expect(pool.query("DROP TRIGGER audit_events_reject_update_delete ON audit_events")).rejects.toThrow(
        /must be owner/,
      );
    });

    it("cannot truncate other tables either", async () => {
      await expect(pool.query("TRUNCATE sessions")).rejects.toThrow(/permission denied/);
    });
  });

  it("the event is still intact after all of that", async () => {
    const result = await owner.query("SELECT summary, metadata FROM audit_events WHERE id = $1", [eventId]);
    expect(result.rows[0]).toEqual({
      summary: "An audit event",
      metadata: { apiKey: "[REDACTED]", note: "fine" },
    });
  });
});

describe("audit_events constraints", () => {
  it("requires a user id when the actor is a user", async () => {
    await expect(
      db.insert(auditEvents).values({ actorType: "user", action: "test.bad_actor", subjectType: "test", summary: "x" }),
    ).rejects.toThrow();
  });

  it("rejects malformed action names", async () => {
    await expect(
      writeAudit(db, { actor: { type: "system" }, action: "NotDotted", subjectType: "test", summary: "x" }),
    ).rejects.toThrow(/Invalid audit action/);
    await expect(
      db.insert(auditEvents).values({ actorType: "system", action: "nodot", subjectType: "test", summary: "x" }),
    ).rejects.toThrow();
  });

  it("rejects oversized JSON at the database even if the app bound were bypassed", async () => {
    await expect(
      db.insert(auditEvents).values({
        actorType: "system",
        action: "test.too_big",
        subjectType: "test",
        summary: "x",
        metadata: { blob: "x".repeat(17_000) },
      }),
    ).rejects.toThrow();
  });
});
