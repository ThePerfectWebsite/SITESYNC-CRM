// Release checklist (spec §3.16). The template lives in
// app_settings['release_checklist.template']; each project gets its own copy
// when created, or on demand ("Add checklist from template", existing keys skipped).
import { and, asc, eq, getTableColumns, isNull, max } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx, Tx } from "../db/client";
import { appSettings, releaseChecklistItems, users } from "../db/schema";
import { auditActor, type Actor } from "./actor";
import { DomainError, notFound, parseInput } from "./errors";
import { optionalText, slugify } from "./fields";
import { requireLiveProject } from "./tasks";

export const CHECKLIST_TEMPLATE_SETTING = "release_checklist.template";

const KEY = /^[a-z][a-z0-9_]{0,49}$/;

export const checklistTemplateSchema = z
  .array(
    z.object({
      key: z.string().regex(KEY, "Keys use lower-case letters, numbers and underscores."),
      label: z.string().trim().min(1, "Every item needs a label.").max(300, "Keep labels to 300 characters."),
      required: z.boolean(),
    }),
  )
  .max(50, "A checklist can have at most 50 items.")
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.key)) ctx.addIssue({ code: "custom", message: `Duplicate item key "${item.key}".` });
      seen.add(item.key);
    }
  });

export type ChecklistTemplate = z.output<typeof checklistTemplateSchema>;

export async function getChecklistTemplate(db: DbOrTx): Promise<ChecklistTemplate> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, CHECKLIST_TEMPLATE_SETTING));
  const parsed = checklistTemplateSchema.safeParse(row?.value ?? []);
  return parsed.success ? parsed.data : [];
}

/** A key for a new template item: the label's slug, unique within the template. */
export function keyForLabel(label: string, taken: Set<string>): string {
  let base = slugify(label).replace(/-/g, "_").slice(0, 40) || "item";
  if (/^[0-9]/.test(base)) base = `item_${base}`;
  if (!KEY.test(base)) base = "item";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

export type TemplateRowInput = { key?: string | null; label: string; required: boolean; remove?: boolean };

/**
 * Replaces the template. Existing rows keep their key (so projects that already
 * have the item aren't affected); new rows get a key from their label.
 */
export async function saveChecklistTemplate(db: Db, actor: Actor, rows: TemplateRowInput[]): Promise<void> {
  const kept = rows.filter((row) => !row.remove && (row.key || row.label.trim()));
  const taken = new Set(kept.map((row) => row.key).filter((key): key is string => Boolean(key)));
  const template = parseInput(
    checklistTemplateSchema,
    kept.map((row) => {
      const key = row.key || keyForLabel(row.label, taken);
      taken.add(key);
      return { key, label: row.label, required: row.required };
    }),
  );
  await db.transaction(async (tx) => {
    const before = await getChecklistTemplate(tx);
    await tx
      .insert(appSettings)
      .values({ key: CHECKLIST_TEMPLATE_SETTING, value: template, updatedBy: actor.userId })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: template, updatedBy: actor.userId } });
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "settings.checklist_template_updated",
      subjectType: "app_setting",
      summary: `Release checklist template updated (${template.length} item${template.length === 1 ? "" : "s"})`,
      before,
      after: template,
      requestId: actor.requestId,
    });
  });
}

/** Copies template items the project doesn't have yet. Returns how many were added. */
export async function instantiateChecklist(tx: Tx, projectId: string): Promise<number> {
  const template = await getChecklistTemplate(tx);
  if (!template.length) return 0;
  const existing = await tx
    .select({ key: releaseChecklistItems.key })
    .from(releaseChecklistItems)
    .where(eq(releaseChecklistItems.projectId, projectId));
  const have = new Set(existing.map((row) => row.key));
  const [{ last } = { last: null }] = await tx
    .select({ last: max(releaseChecklistItems.position) })
    .from(releaseChecklistItems)
    .where(eq(releaseChecklistItems.projectId, projectId));
  let position = (last ?? -1) + 1;
  const missing = template.filter((item) => !have.has(item.key));
  if (!missing.length) return 0;
  await tx.insert(releaseChecklistItems).values(
    missing.map((item) => ({ projectId, key: item.key, label: item.label, required: item.required, position: position++ })),
  );
  return missing.length;
}

export async function addChecklistFromTemplate(db: Db, actor: Actor, projectId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const project = await requireLiveProject(tx, projectId);
    const added = await instantiateChecklist(tx, projectId);
    if (added) {
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "checklist.added_from_template",
        subjectType: "project",
        subjectId: projectId,
        clientId: project.clientId,
        websiteId: project.websiteId,
        projectId,
        summary: `${added} checklist item${added === 1 ? "" : "s"} added to ${project.name} from the template`,
        requestId: actor.requestId,
      });
    }
    return added;
  });
}

async function lockItem(tx: Tx, id: string) {
  const [row] = await tx.select().from(releaseChecklistItems).where(eq(releaseChecklistItems.id, id)).for("update");
  if (!row) throw notFound("Checklist item");
  return row;
}

const noteSchema = z.object({ note: optionalText(2000) });

export async function setChecklistItemChecked(
  db: Db,
  actor: Actor,
  id: string,
  checked: boolean,
  input: { note?: unknown } = {},
): Promise<void> {
  const { note } = parseInput(noteSchema, input);
  await db.transaction(async (tx) => {
    const item = await lockItem(tx, id);
    const project = await requireLiveProject(tx, item.projectId);
    if (item.archivedAt) throw new DomainError("conflict", "This checklist item is archived.");
    if (Boolean(item.checkedAt) === checked && note === item.note) return;
    await tx
      .update(releaseChecklistItems)
      .set(checked ? { checkedAt: item.checkedAt ?? new Date(), checkedBy: item.checkedBy ?? actor.userId, note } : { checkedAt: null, checkedBy: null, note })
      .where(eq(releaseChecklistItems.id, id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: checked ? "checklist.checked" : "checklist.unchecked",
      subjectType: "release_checklist_item",
      subjectId: id,
      clientId: project.clientId,
      websiteId: project.websiteId,
      projectId: project.id,
      summary: `Checklist “${item.label}” ${checked ? "checked" : "unchecked"} on ${project.name}`,
      metadata: { key: item.key, note },
      requestId: actor.requestId,
    });
  });
}

async function setItemArchived(db: Db, actor: Actor, id: string, archived: boolean) {
  await db.transaction(async (tx) => {
    const item = await lockItem(tx, id);
    const project = await requireLiveProject(tx, item.projectId);
    if (Boolean(item.archivedAt) === archived) return;
    await tx
      .update(releaseChecklistItems)
      .set(archived ? { archivedAt: new Date(), archivedBy: actor.userId } : { archivedAt: null, archivedBy: null })
      .where(eq(releaseChecklistItems.id, id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: archived ? "checklist.archived" : "checklist.restored",
      subjectType: "release_checklist_item",
      subjectId: id,
      clientId: project.clientId,
      websiteId: project.websiteId,
      projectId: project.id,
      summary: `Checklist “${item.label}” ${archived ? "removed from" : "restored to"} ${project.name}`,
      metadata: { key: item.key },
      requestId: actor.requestId,
    });
  });
}

export const archiveChecklistItem = (db: Db, actor: Actor, id: string) => setItemArchived(db, actor, id, true);
export const restoreChecklistItem = (db: Db, actor: Actor, id: string) => setItemArchived(db, actor, id, false);

export async function listChecklist(db: DbOrTx, projectId: string, includeArchived = false) {
  return db
    .select({ ...getTableColumns(releaseChecklistItems), checkedByName: users.displayName })
    .from(releaseChecklistItems)
    .leftJoin(users, eq(users.id, releaseChecklistItems.checkedBy))
    .where(
      and(
        eq(releaseChecklistItems.projectId, projectId),
        includeArchived ? undefined : isNull(releaseChecklistItems.archivedAt),
      ),
    )
    .orderBy(asc(releaseChecklistItems.position));
}
