// Changes (spec §3.15): a log of scoped changes to a project. The linked task
// must be in the same project (composite FK) and the requesting contact must
// belong to the project's client (checked here).
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx, Tx } from "../db/client";
import { CHANGE_CATEGORIES, CHANGE_STATUSES, changes, contacts, tasks } from "../db/schema";
import { auditActor, type Actor } from "./actor";
import { DomainError, invalidField, notFound, parseInput, type RawInput } from "./errors";
import { optionalText, requiredText } from "./fields";
import { requireLiveProject } from "./tasks";

const optionalId = (message: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((value) => (value ? value : null))
    .pipe(z.uuid({ message }).nullable());

export const changeSchema = z.object({
  title: requiredText("a title", 300),
  description: optionalText(20000),
  category: z.enum(CHANGE_CATEGORIES, { message: "Choose a category." }),
  status: z.enum(CHANGE_STATUSES, { message: "Choose a status." }).default("proposed"),
  requestedByContactId: optionalId("Choose a contact."),
  taskId: optionalId("Choose a task."),
});

export type ChangeInput = RawInput<typeof changeSchema>;
type ChangeRow = typeof changes.$inferSelect;

function snapshot(row: ChangeRow) {
  return {
    title: row.title,
    category: row.category,
    status: row.status,
    requestedByContactId: row.requestedByContactId,
    taskId: row.taskId,
  };
}

async function checkLinks(tx: Tx, project: { id: string; clientId: string }, data: z.output<typeof changeSchema>) {
  if (data.requestedByContactId) {
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, data.requestedByContactId));
    if (!contact || contact.clientId !== project.clientId) {
      throw invalidField("requestedByContactId", "Choose one of this client's contacts.");
    }
  }
  if (data.taskId) {
    const [task] = await tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, data.taskId));
    if (!task || task.projectId !== project.id) throw invalidField("taskId", "Choose one of this project's tasks.");
  }
}

export async function createChange(db: Db, actor: Actor, projectId: string, input: ChangeInput): Promise<string> {
  const data = parseInput(changeSchema, input);
  return db.transaction(async (tx) => {
    const project = await requireLiveProject(tx, projectId);
    await checkLinks(tx, project, data);
    const [row] = await tx.insert(changes).values({ projectId, ...data }).returning();
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "change.created",
      subjectType: "change",
      subjectId: row!.id,
      clientId: project.clientId,
      websiteId: project.websiteId,
      projectId,
      summary: `Change “${row!.title}” logged for ${project.name}`,
      after: snapshot(row!),
      requestId: actor.requestId,
    });
    return row!.id;
  });
}

async function lockChange(tx: Tx, id: string) {
  const [row] = await tx.select().from(changes).where(eq(changes.id, id)).for("update");
  if (!row) throw notFound("Change");
  return row;
}

export async function updateChange(db: Db, actor: Actor, id: string, input: ChangeInput): Promise<void> {
  const data = parseInput(changeSchema, input);
  await db.transaction(async (tx) => {
    const before = await lockChange(tx, id);
    const project = await requireLiveProject(tx, before.projectId);
    if (before.archivedAt) throw new DomainError("conflict", "Restore this change before editing it.");
    await checkLinks(tx, project, data);
    const [after] = await tx.update(changes).set(data).where(eq(changes.id, id)).returning();
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "change.updated",
      subjectType: "change",
      subjectId: id,
      clientId: project.clientId,
      websiteId: project.websiteId,
      projectId: project.id,
      summary: `Change “${after!.title}” updated`,
      before: snapshot(before),
      after: snapshot(after!),
      requestId: actor.requestId,
    });
  });
}

async function setArchived(db: Db, actor: Actor, id: string, archived: boolean) {
  await db.transaction(async (tx) => {
    const row = await lockChange(tx, id);
    const project = await requireLiveProject(tx, row.projectId);
    if (Boolean(row.archivedAt) === archived) return;
    await tx
      .update(changes)
      .set(archived ? { archivedAt: new Date(), archivedBy: actor.userId } : { archivedAt: null, archivedBy: null })
      .where(eq(changes.id, id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: archived ? "change.archived" : "change.restored",
      subjectType: "change",
      subjectId: id,
      clientId: project.clientId,
      websiteId: project.websiteId,
      projectId: project.id,
      summary: `Change “${row.title}” ${archived ? "archived" : "restored"}`,
      requestId: actor.requestId,
    });
  });
}

export const archiveChange = (db: Db, actor: Actor, id: string) => setArchived(db, actor, id, true);
export const restoreChange = (db: Db, actor: Actor, id: string) => setArchived(db, actor, id, false);

export async function getChange(db: DbOrTx, id: string) {
  const [row] = await db.select().from(changes).where(eq(changes.id, id));
  return row ?? null;
}

export async function listChanges(db: DbOrTx, projectId: string, includeArchived = false) {
  const conditions: SQL[] = [eq(changes.projectId, projectId)];
  if (!includeArchived) conditions.push(isNull(changes.archivedAt));
  return db
    .select({ change: changes, contactName: contacts.name, taskTitle: tasks.title })
    .from(changes)
    .leftJoin(contacts, eq(contacts.id, changes.requestedByContactId))
    .leftJoin(tasks, eq(tasks.id, changes.taskId))
    .where(and(...conditions))
    .orderBy(desc(changes.createdAt));
}
