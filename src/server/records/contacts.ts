// Contacts (spec §3.7). At most one live primary contact per client: making a
// contact primary clears the flag on the others in the same transaction.
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx, Tx } from "../db/client";
import { clients, contacts } from "../db/schema";
import { auditActor, type Actor } from "./actor";
import { DomainError, notFound, parseInput, type RawInput } from "./errors";
import { optionalText, requiredText } from "./fields";

export const contactSchema = z.object({
  name: requiredText("a name", 200),
  email: z
    .string()
    .trim()
    .max(254, "Email is too long.")
    .nullish()
    .transform((value) => (value ? value : null))
    .refine((value) => value === null || z.email().safeParse(value).success, {
      message: "Enter a valid email address.",
    }),
  phone: optionalText(50),
  roleTitle: optionalText(200),
  isPrimary: z
    .union([z.boolean(), z.literal("on"), z.literal("true"), z.literal(""), z.null()])
    .optional()
    .transform((value) => value === true || value === "on" || value === "true"),
  notes: optionalText(5000),
});

export type ContactInput = RawInput<typeof contactSchema>;

type ContactRow = typeof contacts.$inferSelect;

function snapshot(row: ContactRow) {
  return {
    name: row.name,
    email: row.email,
    phone: row.phone,
    roleTitle: row.roleTitle,
    isPrimary: row.isPrimary,
    notes: row.notes,
  };
}

async function clearOtherPrimaries(tx: Tx, clientId: string, keepId: string | null) {
  await tx
    .update(contacts)
    .set({ isPrimary: false })
    .where(
      and(
        eq(contacts.clientId, clientId),
        eq(contacts.isPrimary, true),
        isNull(contacts.archivedAt),
        keepId ? ne(contacts.id, keepId) : undefined,
      ),
    );
}

async function lockLiveClient(tx: Tx, clientId: string) {
  const [client] = await tx.select().from(clients).where(eq(clients.id, clientId)).for("update");
  if (!client) throw notFound("Client");
  if (client.archivedAt) throw new DomainError("conflict", "This client is archived.");
  return client;
}

export async function createContact(db: Db, actor: Actor, clientId: string, input: ContactInput) {
  const data = parseInput(contactSchema, input);
  return db.transaction(async (tx) => {
    const client = await lockLiveClient(tx, clientId);
    if (data.isPrimary) await clearOtherPrimaries(tx, clientId, null);
    const [row] = await tx
      .insert(contacts)
      .values({ clientId, ...data })
      .returning();
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "contact.created",
      subjectType: "contact",
      subjectId: row!.id,
      clientId,
      summary: `Contact ${row!.name} added to ${client.name}`,
      after: snapshot(row!),
      requestId: actor.requestId,
    });
    return row!.id;
  });
}

export async function updateContact(db: Db, actor: Actor, id: string, input: ContactInput) {
  const data = parseInput(contactSchema, input);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(contacts).where(eq(contacts.id, id)).for("update");
    if (!before) throw notFound("Contact");
    await lockLiveClient(tx, before.clientId);
    if (before.archivedAt) throw new DomainError("conflict", "Restore this contact before editing it.");
    if (data.isPrimary) await clearOtherPrimaries(tx, before.clientId, id);
    const [after] = await tx.update(contacts).set(data).where(eq(contacts.id, id)).returning();
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "contact.updated",
      subjectType: "contact",
      subjectId: id,
      clientId: before.clientId,
      summary: `Contact ${after!.name} updated`,
      before: snapshot(before),
      after: snapshot(after!),
      requestId: actor.requestId,
    });
  });
}

async function setArchived(db: Db, actor: Actor, id: string, archived: boolean) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(contacts).where(eq(contacts.id, id)).for("update");
    if (!row) throw notFound("Contact");
    if (Boolean(row.archivedAt) === archived) return;
    if (!archived) await lockLiveClient(tx, row.clientId);
    await tx
      .update(contacts)
      .set(
        archived
          ? { archivedAt: new Date(), archivedBy: actor.userId, isPrimary: false }
          : { archivedAt: null, archivedBy: null },
      )
      .where(eq(contacts.id, id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: archived ? "contact.archived" : "contact.restored",
      subjectType: "contact",
      subjectId: id,
      clientId: row.clientId,
      summary: `Contact ${row.name} ${archived ? "archived" : "restored"}`,
      requestId: actor.requestId,
    });
  });
}

export const archiveContact = (db: Db, actor: Actor, id: string) => setArchived(db, actor, id, true);
export const restoreContact = (db: Db, actor: Actor, id: string) => setArchived(db, actor, id, false);

export async function listContacts(db: DbOrTx, clientId: string, includeArchived = false) {
  return db
    .select()
    .from(contacts)
    .where(and(eq(contacts.clientId, clientId), includeArchived ? undefined : isNull(contacts.archivedAt)))
    .orderBy(desc(contacts.isPrimary), asc(contacts.name));
}
