import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { auditEvents, readinessWaivers, releaseChecklistItems, tasks } from "@/server/db/schema";
import type { Actor } from "@/server/records/actor";
import { createChange, listChanges, updateChange } from "@/server/records/changes";
import {
  addChecklistFromTemplate,
  archiveChecklistItem,
  getChecklistTemplate,
  listChecklist,
  saveChecklistTemplate,
  setChecklistItemChecked,
} from "@/server/records/checklist";
import { createContact } from "@/server/records/contacts";
import { appToday, TIME_ZONE_SETTING } from "@/server/records/dates";
import { DomainError } from "@/server/records/errors";
import { computeReadiness, revokeWaiver, waiveBlocker } from "@/server/records/readiness";
import { searchRecords } from "@/server/records/search";
import {
  archiveTask,
  completeTask,
  createTask,
  getTask,
  listTasks,
  overdueTasks,
  reopenTask,
  tasksDueBetween,
  updateTask,
} from "@/server/records/tasks";
import { loadStages, transitionStage } from "@/server/stages/service";
import { createAdmin, makeClient, makeProject } from "../support/factories";
import { appDb, ownerClient, resetTestDatabase } from "../support/test-db";

let db: Db;
let pool: pg.Pool;
let owner: pg.Client;
let actor: Actor;

beforeAll(async () => {
  await resetTestDatabase();
  ({ db, pool } = appDb());
  owner = await ownerClient();
  actor = await createAdmin(db);
});

afterAll(async () => {
  await pool?.end();
  await owner?.end();
});

const actions = async (subjectId: string) =>
  (await db.select().from(auditEvents).where(eq(auditEvents.subjectId, subjectId))).map((e) => e.action);

async function archiveProject(projectId: string) {
  const current = (await loadStages(db, projectId)).find((s) => s.status === "current")!;
  await transitionStage(db, actor, {
    projectId,
    expectedCurrentStageId: current.id,
    request: { kind: "archive", reason: "Test archive" },
  });
}

describe("tasks", () => {
  it("validates input", async () => {
    const { projectId } = await makeProject(db, actor);
    await expect(createTask(db, actor, projectId, { title: "" })).rejects.toMatchObject({ fieldErrors: { title: "Enter a title." } });
    await expect(createTask(db, actor, projectId, { title: "T", referenceUrl: "javascript:alert(1)" })).rejects.toMatchObject({
      fieldErrors: { referenceUrl: expect.any(String) },
    });
    await expect(createTask(db, actor, projectId, { title: "T", status: "done" })).rejects.toMatchObject({
      fieldErrors: { status: "Choose a status." },
    });
    await expect(createTask(db, actor, projectId, { title: "T", priority: "urgent" })).rejects.toBeInstanceOf(DomainError);
  });

  it("complete and reopen keep status and completion in step, with audit", async () => {
    const { projectId } = await makeProject(db, actor);
    const id = await createTask(db, actor, projectId, { title: "Write copy", status: "in_progress" });
    await completeTask(db, actor, id);
    expect(await getTask(db, id)).toMatchObject({ status: "done", completedBy: actor.userId, completedAt: expect.any(Date) });

    // Editing a done task can't sneak it out of done.
    await updateTask(db, actor, id, { title: "Write copy v2", status: "open" });
    expect(await getTask(db, id)).toMatchObject({ title: "Write copy v2", status: "done" });

    await reopenTask(db, actor, id);
    expect(await getTask(db, id)).toMatchObject({ status: "open", completedAt: null, completedBy: null });
    await expect(reopenTask(db, actor, id)).rejects.toMatchObject({ code: "conflict" });
    expect(await actions(id)).toEqual(
      expect.arrayContaining(["task.created", "task.completed", "task.updated", "task.reopened"]),
    );
  });

  it("the database enforces done ⇔ completed_at", async () => {
    const { projectId } = await makeProject(db, actor);
    const id = await createTask(db, actor, projectId, { title: "Check" });
    await expect(pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [id])).rejects.toMatchObject({
      code: "23514",
      constraint: "tasks_completed_check",
    });
    await completeTask(db, actor, id);
    await expect(pool.query("UPDATE tasks SET status = 'open' WHERE id = $1", [id])).rejects.toMatchObject({
      constraint: "tasks_completed_check",
    });
  });

  it("a task's stage must be one of its project's stages (service and composite FK)", async () => {
    const a = await makeProject(db, actor);
    const b = await makeProject(db, actor);
    const stageOfB = (await loadStages(db, b.projectId))[0]!;
    await expect(createTask(db, actor, a.projectId, { title: "X", projectStageId: stageOfB.id })).rejects.toMatchObject({
      fieldErrors: { projectStageId: expect.any(String) },
    });
    const id = await createTask(db, actor, a.projectId, { title: "Y" });
    await expect(
      pool.query("UPDATE tasks SET project_stage_id = $1 WHERE id = $2", [stageOfB.id, id]),
    ).rejects.toMatchObject({ code: "23503", constraint: "tasks_stage_same_project_fk" });
  });

  it("tasks of an archived project are read-only", async () => {
    const { projectId } = await makeProject(db, actor);
    const id = await createTask(db, actor, projectId, { title: "Frozen" });
    await archiveProject(projectId);
    await expect(completeTask(db, actor, id)).rejects.toMatchObject({ code: "conflict" });
    await expect(createTask(db, actor, projectId, { title: "New" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("lists open tasks by priority, and hides done/cancelled/archived unless asked", async () => {
    const { projectId } = await makeProject(db, actor);
    const low = await createTask(db, actor, projectId, { title: "Low", priority: "low" });
    const critical = await createTask(db, actor, projectId, { title: "Critical", priority: "critical" });
    const done = await createTask(db, actor, projectId, { title: "Done" });
    await completeTask(db, actor, done);
    const archived = await createTask(db, actor, projectId, { title: "Archived" });
    await archiveTask(db, actor, archived);

    expect((await listTasks(db, projectId)).map((r) => r.task.id)).toEqual([critical, low]);
    expect((await listTasks(db, projectId, { includeClosed: true })).map((r) => r.task.id)).toContain(done);
    expect((await listTasks(db, projectId, { includeClosed: true, includeArchived: true })).map((r) => r.task.id)).toContain(
      archived,
    );
  });

  it("overdue and upcoming deadlines use calendar dates, excluding closed work and archived projects", async () => {
    const { projectId } = await makeProject(db, actor);
    const yesterday = await createTask(db, actor, projectId, { title: "Yesterday", dueDate: "2026-11-02" });
    const today = await createTask(db, actor, projectId, { title: "Today", dueDate: "2026-11-03" });
    const in14 = await createTask(db, actor, projectId, { title: "In 14 days", dueDate: "2026-11-17" });
    const in15 = await createTask(db, actor, projectId, { title: "In 15 days", dueDate: "2026-11-18" });
    const doneLate = await createTask(db, actor, projectId, { title: "Done late", dueDate: "2026-11-01" });
    await completeTask(db, actor, doneLate);

    const overdue = (await overdueTasks(db, "2026-11-03")).map((t) => t.id);
    expect(overdue).toContain(yesterday);
    expect(overdue).not.toContain(today);
    expect(overdue).not.toContain(doneLate);

    const upcoming = (await tasksDueBetween(db, "2026-11-03", "2026-11-17")).map((t) => t.id);
    expect(upcoming).toEqual(expect.arrayContaining([today, in14]));
    expect(upcoming).not.toContain(in15);
    expect(upcoming).not.toContain(yesterday);

    await archiveProject(projectId);
    expect((await overdueTasks(db, "2026-11-03")).map((t) => t.id)).not.toContain(yesterday);
  });

  it("today follows the app.time_zone setting", async () => {
    const lateUtc = new Date("2026-11-03T23:30:00Z");
    await owner.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, '"Pacific/Auckland"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [TIME_ZONE_SETTING],
    );
    expect(await appToday(db, lateUtc)).toBe("2026-11-04");
    await owner.query(`UPDATE app_settings SET value = '"Not/AZone"' WHERE key = $1`, [TIME_ZONE_SETTING]);
    expect(await appToday(db, lateUtc)).toMatch(/^\d{4}-\d{2}-\d{2}$/); // falls back to the server's zone
    await owner.query(`UPDATE app_settings SET value = '"Europe/London"' WHERE key = $1`, [TIME_ZONE_SETTING]);
    expect(await appToday(db, lateUtc)).toBe("2026-11-03");
  });

  it("tasks are searchable", async () => {
    const { projectId } = await makeProject(db, actor);
    const id = await createTask(db, actor, projectId, { title: "Configure Zephyr newsletter" });
    expect((await searchRecords(db, "zephyr")).find((h) => h.id === id)).toMatchObject({
      type: "task",
      href: `/projects/${projectId}/tasks/${id}`,
    });
  });
});

describe("changes", () => {
  it("the requesting contact must belong to the project's client", async () => {
    const { projectId, clientId } = await makeProject(db, actor);
    const own = await createContact(db, actor, clientId, { name: "Own" });
    const otherClient = await makeClient(db, actor);
    const stranger = await createContact(db, actor, otherClient, { name: "Stranger" });
    await expect(
      createChange(db, actor, projectId, { title: "C", category: "feature", requestedByContactId: stranger }),
    ).rejects.toMatchObject({ fieldErrors: { requestedByContactId: expect.any(String) } });
    const id = await createChange(db, actor, projectId, { title: "C", category: "feature", requestedByContactId: own });
    expect((await listChanges(db, projectId))[0]).toMatchObject({ change: { id }, contactName: "Own" });
  });

  it("the linked task must be in the same project (service and composite FK)", async () => {
    const a = await makeProject(db, actor);
    const b = await makeProject(db, actor);
    const taskOfB = await createTask(db, actor, b.projectId, { title: "B's task" });
    await expect(
      createChange(db, actor, a.projectId, { title: "C", category: "fix", taskId: taskOfB }),
    ).rejects.toMatchObject({ fieldErrors: { taskId: expect.any(String) } });
    const id = await createChange(db, actor, a.projectId, { title: "C", category: "fix" });
    await expect(pool.query("UPDATE changes SET task_id = $1 WHERE id = $2", [taskOfB, id])).rejects.toMatchObject({
      code: "23503",
      constraint: "changes_task_same_project_fk",
    });
  });

  it("updates are audited with before/after", async () => {
    const { projectId } = await makeProject(db, actor);
    const id = await createChange(db, actor, projectId, { title: "New hero", category: "design" });
    await updateChange(db, actor, id, { title: "New hero", category: "design", status: "accepted" });
    const [event] = await db.select().from(auditEvents).where(eq(auditEvents.action, "change.updated"));
    expect(event).toMatchObject({ before: { status: "proposed" }, after: { status: "accepted" } });
  });
});

describe("release checklist", () => {
  it("new projects get the template's items", async () => {
    const template = await getChecklistTemplate(db);
    expect(template.map((i) => i.key)).toContain("client_signoff");
    const { projectId } = await makeProject(db, actor);
    expect((await listChecklist(db, projectId)).map((i) => i.key)).toEqual(template.map((i) => i.key));
  });

  it("adding from the template skips keys the project already has", async () => {
    const { projectId } = await makeProject(db, actor);
    const before = await getChecklistTemplate(db);
    await saveChecklistTemplate(db, actor, [
      ...before.map((i) => ({ ...i })),
      { label: "Cookie banner reviewed", required: false },
    ]);
    expect(await addChecklistFromTemplate(db, actor, projectId)).toBe(1);
    expect(await addChecklistFromTemplate(db, actor, projectId)).toBe(0);
    const items = await listChecklist(db, projectId);
    expect(items.at(-1)).toMatchObject({ key: "cookie_banner_reviewed", required: false });
    // Restore the default template for the other tests.
    await saveChecklistTemplate(db, actor, before);
  });

  it("template edits keep existing keys and refuse duplicates", async () => {
    const before = await getChecklistTemplate(db);
    await expect(
      saveChecklistTemplate(db, actor, [
        { key: "dns_ssl", label: "One", required: true },
        { key: "dns_ssl", label: "Two", required: true },
      ]),
    ).rejects.toBeInstanceOf(DomainError);
    await saveChecklistTemplate(db, actor, before.map((i, n) => (n === 0 ? { ...i, label: "DNS and SSL checked" } : i)));
    expect((await getChecklistTemplate(db))[0]).toMatchObject({ key: before[0]!.key, label: "DNS and SSL checked" });
    await saveChecklistTemplate(db, actor, before);
  });

  it("check/uncheck records who and when, together (DB check too)", async () => {
    const { projectId } = await makeProject(db, actor);
    const [item] = await listChecklist(db, projectId);
    await setChecklistItemChecked(db, actor, item!.id, true, { note: "Verified with SSL Labs" });
    const [checked] = await db.select().from(releaseChecklistItems).where(eq(releaseChecklistItems.id, item!.id));
    expect(checked).toMatchObject({ checkedBy: actor.userId, checkedAt: expect.any(Date), note: "Verified with SSL Labs" });
    await setChecklistItemChecked(db, actor, item!.id, false);
    await expect(
      pool.query("UPDATE release_checklist_items SET checked_at = now() WHERE id = $1", [item!.id]),
    ).rejects.toMatchObject({ constraint: "release_checklist_items_checked_check" });
  });
});

describe("readiness", () => {
  async function readyProject() {
    const { projectId } = await makeProject(db, actor);
    for (const item of await listChecklist(db, projectId)) await setChecklistItemChecked(db, actor, item.id, true);
    return projectId;
  }

  it("a fresh project is blocked by its required checklist items", async () => {
    const { projectId } = await makeProject(db, actor);
    const readiness = await computeReadiness(db, projectId);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.every((b) => b.type === "checklist_item")).toBe(true);
    expect(readiness.blockers).toHaveLength((await listChecklist(db, projectId)).length);
  });

  it("only open critical tasks block; completing, cancelling or archiving clears them", async () => {
    const projectId = await readyProject();
    expect((await computeReadiness(db, projectId)).ready).toBe(true);

    await createTask(db, actor, projectId, { title: "High but fine", priority: "high" });
    expect((await computeReadiness(db, projectId)).ready).toBe(true);

    const critical = await createTask(db, actor, projectId, { title: "Fix checkout", priority: "critical" });
    const blocked = await computeReadiness(db, projectId);
    expect(blocked.blockers.map((b) => b.key)).toEqual([`task:${critical}`]);

    await completeTask(db, actor, critical);
    expect((await computeReadiness(db, projectId)).ready).toBe(true);
    await reopenTask(db, actor, critical);
    await updateTask(db, actor, critical, { title: "Fix checkout", priority: "critical", status: "cancelled" });
    expect((await computeReadiness(db, projectId)).ready).toBe(true);

    const another = await createTask(db, actor, projectId, { title: "Another", priority: "critical" });
    await archiveTask(db, actor, another);
    expect((await computeReadiness(db, projectId)).ready).toBe(true);
  });

  it("non-required and archived checklist items never block", async () => {
    const { projectId } = await makeProject(db, actor);
    const items = await listChecklist(db, projectId);
    for (const item of items.slice(1)) await setChecklistItemChecked(db, actor, item.id, true);
    await archiveChecklistItem(db, actor, items[0]!.id);
    expect((await computeReadiness(db, projectId)).ready).toBe(true);
  });

  it("a waiver needs a reason, applies to that blocker only, and is audited and revocable", async () => {
    const { projectId } = await makeProject(db, actor);
    const items = await listChecklist(db, projectId);
    for (const item of items.slice(1)) await setChecklistItemChecked(db, actor, item.id, true);
    const key = `checklist:${items[0]!.key}`;

    await expect(waiveBlocker(db, actor, projectId, { blockerKey: key, reason: "" })).rejects.toMatchObject({
      fieldErrors: { reason: expect.any(String) },
    });
    await expect(waiveBlocker(db, actor, projectId, { blockerKey: "checklist:nope", reason: "Because" })).rejects.toMatchObject({
      code: "conflict",
    });

    const waiverId = await waiveBlocker(db, actor, projectId, { blockerKey: key, reason: "DNS handled by client's IT" });
    const readiness = await computeReadiness(db, projectId);
    expect(readiness.ready).toBe(true);
    expect(readiness.waived[0]).toMatchObject({ blocker: { key }, waiver: { reason: "DNS handled by client's IT" } });

    const [row] = await db.select().from(readinessWaivers).where(eq(readinessWaivers.id, waiverId));
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.id, row!.auditEventId));
    expect(audit).toMatchObject({ action: "readiness.waived", projectId, actorUserId: actor.userId });

    await expect(waiveBlocker(db, actor, projectId, { blockerKey: key, reason: "Again" })).rejects.toMatchObject({
      code: "conflict",
    });

    await revokeWaiver(db, actor, waiverId);
    expect((await computeReadiness(db, projectId)).ready).toBe(false);
    const [revoked] = await db.select().from(readinessWaivers).where(eq(readinessWaivers.id, waiverId));
    expect(revoked).toMatchObject({ revokedBy: actor.userId, revokedAt: expect.any(Date) });
    // Revoked, never deleted; a new waiver can be made after revoking.
    await waiveBlocker(db, actor, projectId, { blockerKey: key, reason: "Re-accepted" });
    await expect(pool.query("DELETE FROM readiness_waivers")).rejects.toThrow(/permission denied/);
  });

  it("a commit-scoped waiver only applies to that commit", async () => {
    const { projectId } = await makeProject(db, actor);
    const items = await listChecklist(db, projectId);
    for (const item of items.slice(1)) await setChecklistItemChecked(db, actor, item.id, true);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    await expect(
      waiveBlocker(db, actor, projectId, { blockerKey: `checklist:${items[0]!.key}`, reason: "Hotfix", commitSha: "abc123" }),
    ).rejects.toMatchObject({ fieldErrors: { commitSha: expect.any(String) } });
    await waiveBlocker(db, actor, projectId, {
      blockerKey: `checklist:${items[0]!.key}`,
      reason: "Hotfix only",
      commitSha: sha.toUpperCase(),
    });
    expect((await computeReadiness(db, projectId, { commitSha: sha })).ready).toBe(true);
    expect((await computeReadiness(db, projectId, { commitSha: "f".repeat(40) })).ready).toBe(false);
    expect((await computeReadiness(db, projectId)).ready).toBe(false);
  });

  it("waivers survive in the table only as history (no delete grant on work tables)", async () => {
    await expect(pool.query("DELETE FROM tasks")).rejects.toThrow(/permission denied/);
    await expect(pool.query("DELETE FROM changes")).rejects.toThrow(/permission denied/);
    await expect(pool.query("DELETE FROM release_checklist_items")).rejects.toThrow(/permission denied/);
    expect(await db.$count(tasks)).toBeGreaterThan(0);
  });
});
