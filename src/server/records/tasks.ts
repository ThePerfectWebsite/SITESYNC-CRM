// Tasks (spec §3.14). `done` is reached only through completeTask and left
// only through reopenTask, so status = 'done' ⇔ completed_at is set (also a DB check).
import { and, asc, desc, eq, gte, inArray, isNull, lte, lt, notInArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx, Tx } from "../db/client";
import { clients, projects, projectStages, TASK_PRIORITIES, tasks, type TaskStatus } from "../db/schema";
import { auditActor, type Actor } from "./actor";
import { DomainError, invalidField, notFound, parseInput, type RawInput } from "./errors";
import { optionalDate, optionalText, requiredText } from "./fields";

/** Statuses an operator can set directly. `done` comes from completing a task. */
export const EDITABLE_TASK_STATUSES = ["open", "in_progress", "blocked", "cancelled"] as const;
export const OPEN_TASK_STATUSES: TaskStatus[] = ["open", "in_progress", "blocked"];

const optionalUrl = z
  .string()
  .trim()
  .max(2048, "Keep the link to 2,048 characters.")
  .nullish()
  .transform((value) => (value ? value : null))
  .refine((value) => value === null || (/^https?:\/\//i.test(value) && URL.canParse(value)), {
    message: "Enter a full link starting with https:// (or http://).",
  });

const optionalId = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value ? value : null))
  .pipe(z.uuid({ message: "Choose a stage." }).nullable());

export const taskSchema = z.object({
  title: requiredText("a title", 300),
  description: optionalText(20000),
  status: z.enum(EDITABLE_TASK_STATUSES, { message: "Choose a status." }).default("open"),
  priority: z.enum(TASK_PRIORITIES, { message: "Choose a priority." }).default("normal"),
  dueDate: optionalDate,
  referenceUrl: optionalUrl,
  projectStageId: optionalId,
});

export type TaskInput = RawInput<typeof taskSchema>;
type TaskRow = typeof tasks.$inferSelect;

function snapshot(row: TaskRow) {
  return {
    title: row.title,
    status: row.status,
    priority: row.priority,
    dueDate: row.dueDate,
    referenceUrl: row.referenceUrl,
    projectStageId: row.projectStageId,
  };
}

/** Locks the project; work items of an archived project are read-only. */
export async function requireLiveProject(tx: Tx, projectId: string) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("share");
  if (!project) throw notFound("Project");
  if (project.archivedAt) throw new DomainError("conflict", "This project is archived. Restore it first.");
  return project;
}

async function checkStage(tx: Tx, projectId: string, stageId: string | null) {
  if (!stageId) return;
  const [stage] = await tx
    .select({ id: projectStages.id })
    .from(projectStages)
    .where(and(eq(projectStages.id, stageId), eq(projectStages.projectId, projectId)));
  if (!stage) throw invalidField("projectStageId", "Choose one of this project's stages.");
}

async function lockTask(tx: Tx, id: string) {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
  if (!row) throw notFound("Task");
  return row;
}

function audit(tx: Tx, actor: Actor, project: typeof projects.$inferSelect, action: string, task: TaskRow, summary: string, extra: { before?: unknown; after?: unknown } = {}) {
  return writeAudit(tx, {
    actor: auditActor(actor),
    action,
    subjectType: "task",
    subjectId: task.id,
    clientId: project.clientId,
    websiteId: project.websiteId,
    projectId: project.id,
    summary,
    ...extra,
    requestId: actor.requestId,
  });
}

export async function createTask(db: Db, actor: Actor, projectId: string, input: TaskInput): Promise<string> {
  const data = parseInput(taskSchema, input);
  if (data.status === "cancelled") throw invalidField("status", "A new task can't start cancelled.");
  return db.transaction(async (tx) => {
    const project = await requireLiveProject(tx, projectId);
    await checkStage(tx, projectId, data.projectStageId);
    const [row] = await tx.insert(tasks).values({ projectId, ...data }).returning();
    await audit(tx, actor, project, "task.created", row!, `Task “${row!.title}” added to ${project.name}`, {
      after: snapshot(row!),
    });
    return row!.id;
  });
}

export async function updateTask(db: Db, actor: Actor, id: string, input: TaskInput): Promise<void> {
  const data = parseInput(taskSchema, input);
  await db.transaction(async (tx) => {
    const before = await lockTask(tx, id);
    const project = await requireLiveProject(tx, before.projectId);
    if (before.archivedAt) throw new DomainError("conflict", "Restore this task before editing it.");
    await checkStage(tx, before.projectId, data.projectStageId);
    // A done task keeps its status; reopening is a separate, audited step.
    const status = before.status === "done" ? "done" : data.status;
    const [after] = await tx.update(tasks).set({ ...data, status }).where(eq(tasks.id, id)).returning();
    await audit(tx, actor, project, "task.updated", after!, `Task “${after!.title}” updated`, {
      before: snapshot(before),
      after: snapshot(after!),
    });
  });
}

export async function completeTask(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await lockTask(tx, id);
    const project = await requireLiveProject(tx, before.projectId);
    if (before.archivedAt) throw new DomainError("conflict", "Restore this task first.");
    if (before.status === "done") return;
    const [after] = await tx
      .update(tasks)
      .set({ status: "done", completedAt: new Date(), completedBy: actor.userId })
      .where(eq(tasks.id, id))
      .returning();
    await audit(tx, actor, project, "task.completed", after!, `Task “${after!.title}” completed`, {
      before: { status: before.status },
      after: { status: "done" },
    });
  });
}

export async function reopenTask(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await lockTask(tx, id);
    const project = await requireLiveProject(tx, before.projectId);
    if (before.archivedAt) throw new DomainError("conflict", "Restore this task first.");
    if (before.status !== "done" && before.status !== "cancelled") {
      throw new DomainError("conflict", "Only done or cancelled tasks can be reopened.");
    }
    const [after] = await tx
      .update(tasks)
      .set({ status: "open", completedAt: null, completedBy: null })
      .where(eq(tasks.id, id))
      .returning();
    await audit(tx, actor, project, "task.reopened", after!, `Task “${after!.title}” reopened`, {
      before: { status: before.status },
      after: { status: "open" },
    });
  });
}

async function setArchived(db: Db, actor: Actor, id: string, archived: boolean) {
  await db.transaction(async (tx) => {
    const row = await lockTask(tx, id);
    const project = await requireLiveProject(tx, row.projectId);
    if (Boolean(row.archivedAt) === archived) return;
    const [after] = await tx
      .update(tasks)
      .set(archived ? { archivedAt: new Date(), archivedBy: actor.userId } : { archivedAt: null, archivedBy: null })
      .where(eq(tasks.id, id))
      .returning();
    await audit(
      tx,
      actor,
      project,
      archived ? "task.archived" : "task.restored",
      after!,
      `Task “${row.title}” ${archived ? "archived" : "restored"}`,
    );
  });
}

export const archiveTask = (db: Db, actor: Actor, id: string) => setArchived(db, actor, id, true);
export const restoreTask = (db: Db, actor: Actor, id: string) => setArchived(db, actor, id, false);

// --- Queries -----------------------------------------------------------------

export async function getTask(db: DbOrTx, id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row ?? null;
}

export type TaskFilters = { includeClosed?: boolean; includeArchived?: boolean };

export async function listTasks(db: DbOrTx, projectId: string, filters: TaskFilters = {}) {
  const conditions: SQL[] = [eq(tasks.projectId, projectId)];
  if (!filters.includeArchived) conditions.push(isNull(tasks.archivedAt));
  if (!filters.includeClosed) conditions.push(inArray(tasks.status, OPEN_TASK_STATUSES));
  return db
    .select({ task: tasks, stageName: projectStages.name })
    .from(tasks)
    .leftJoin(projectStages, eq(projectStages.id, tasks.projectStageId))
    .where(and(...conditions))
    .orderBy(
      sql`CASE ${tasks.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
      sql`${tasks.dueDate} ASC NULLS LAST`,
      desc(tasks.createdAt),
    );
}

/** Open tasks on live projects, with project and client, for dashboard lists. */
function openTasksQuery(db: DbOrTx, where: SQL) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      priority: tasks.priority,
      status: tasks.status,
      dueDate: tasks.dueDate,
      projectId: projects.id,
      projectName: projects.name,
      clientName: clients.name,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(
      and(
        notInArray(tasks.status, ["done", "cancelled"]),
        isNull(tasks.archivedAt),
        isNull(projects.archivedAt),
        where,
      ),
    )
    .orderBy(asc(tasks.dueDate), asc(tasks.title));
}

export function overdueTasks(db: DbOrTx, today: string) {
  return openTasksQuery(db, lt(tasks.dueDate, today));
}

/** Open tasks due from `from` to `to` inclusive. */
export function tasksDueBetween(db: DbOrTx, from: string, to: string) {
  return openTasksQuery(db, and(gte(tasks.dueDate, from), lte(tasks.dueDate, to))!);
}
