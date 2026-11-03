// Websites (spec §3.8). A website's client never changes: projects reference
// (website, client) together (decision 0001).
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx, Tx } from "../db/client";
import { clients, projects, WEBSITE_STATUSES, websites } from "../db/schema";
import { auditActor, type Actor } from "./actor";
import { DomainError, invalidField, isUniqueViolation, notFound, parseInput, type RawInput } from "./errors";
import { optionalDomain, optionalText, requiredText, uuid } from "./fields";

export const websiteSchema = z.object({
  name: requiredText("a name", 200),
  primaryDomain: optionalDomain,
  status: z.enum(WEBSITE_STATUSES, { message: "Choose a status." }).default("planned"),
  notes: optionalText(20000),
});

export const newWebsiteSchema = websiteSchema.extend({ clientId: uuid("Choose a client.") });

export type WebsiteInput = RawInput<typeof websiteSchema>;
export type NewWebsiteInput = RawInput<typeof newWebsiteSchema>;

const DOMAIN_KEY = "websites_primary_domain_live_key";
const domainTaken = () => invalidField("primaryDomain", "Another website already uses this domain.");

type WebsiteRow = typeof websites.$inferSelect;

function snapshot(row: WebsiteRow) {
  return { name: row.name, primaryDomain: row.primaryDomain, status: row.status, notes: row.notes };
}

async function lockWebsite(tx: Tx, id: string) {
  const [row] = await tx.select().from(websites).where(eq(websites.id, id)).for("update");
  if (!row) throw notFound("Website");
  return row;
}

async function requireLiveClient(tx: Tx, clientId: string) {
  const [client] = await tx.select().from(clients).where(eq(clients.id, clientId)).for("share");
  if (!client) throw invalidField("clientId", "Choose a client.");
  if (client.archivedAt) throw invalidField("clientId", "This client is archived.");
  return client;
}

export async function createWebsite(db: Db, actor: Actor, input: NewWebsiteInput): Promise<string> {
  const data = parseInput(newWebsiteSchema, input);
  try {
    return await db.transaction(async (tx) => {
      const client = await requireLiveClient(tx, data.clientId);
      const [row] = await tx.insert(websites).values(data).returning();
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "website.created",
        subjectType: "website",
        subjectId: row!.id,
        clientId: data.clientId,
        websiteId: row!.id,
        summary: `Website ${row!.name} created for ${client.name}`,
        after: snapshot(row!),
        requestId: actor.requestId,
      });
      return row!.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, DOMAIN_KEY)) throw domainTaken();
    throw error;
  }
}

export async function updateWebsite(db: Db, actor: Actor, id: string, input: WebsiteInput): Promise<void> {
  const data = parseInput(websiteSchema, input);
  try {
    await db.transaction(async (tx) => {
      const before = await lockWebsite(tx, id);
      if (before.archivedAt) throw new DomainError("conflict", "Restore this website before editing it.");
      const [after] = await tx.update(websites).set(data).where(eq(websites.id, id)).returning();
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "website.updated",
        subjectType: "website",
        subjectId: id,
        clientId: before.clientId,
        websiteId: id,
        summary: `Website ${after!.name} updated`,
        before: snapshot(before),
        after: snapshot(after!),
        requestId: actor.requestId,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, DOMAIN_KEY)) throw domainTaken();
    throw error;
  }
}

export async function archiveWebsite(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockWebsite(tx, id);
    if (row.archivedAt) return;
    const openProjects = await tx.$count(
      projects,
      and(eq(projects.websiteId, id), isNull(projects.archivedAt)),
    );
    if (openProjects > 0) throw new DomainError("conflict", "Archive this website's projects first.");
    await tx
      .update(websites)
      .set({ archivedAt: new Date(), archivedBy: actor.userId })
      .where(eq(websites.id, id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "website.archived",
      subjectType: "website",
      subjectId: id,
      clientId: row.clientId,
      websiteId: id,
      summary: `Website ${row.name} archived`,
      requestId: actor.requestId,
    });
  });
}

export async function restoreWebsite(db: Db, actor: Actor, id: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const row = await lockWebsite(tx, id);
      if (!row.archivedAt) return;
      const client = await requireLiveClient(tx, row.clientId).catch(() => {
        throw new DomainError("conflict", "Restore this website's client first.");
      });
      await tx.update(websites).set({ archivedAt: null, archivedBy: null }).where(eq(websites.id, id));
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "website.restored",
        subjectType: "website",
        subjectId: id,
        clientId: client.id,
        websiteId: id,
        summary: `Website ${row.name} restored`,
        requestId: actor.requestId,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, DOMAIN_KEY)) {
      throw new DomainError("conflict", "Another website now uses this domain. Change one of them first.");
    }
    throw error;
  }
}

export async function getWebsite(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ website: websites, clientName: clients.name, clientArchivedAt: clients.archivedAt })
    .from(websites)
    .innerJoin(clients, eq(clients.id, websites.clientId))
    .where(eq(websites.id, id));
  return row ?? null;
}

export async function listWebsitesForClient(db: DbOrTx, clientId: string, includeArchived = false) {
  return db
    .select()
    .from(websites)
    .where(and(eq(websites.clientId, clientId), includeArchived ? undefined : isNull(websites.archivedAt)))
    .orderBy(asc(websites.name));
}

/** Live websites with their client, for the project form's picker. */
export async function websiteOptions(db: DbOrTx) {
  return db
    .select({ id: websites.id, name: websites.name, clientId: websites.clientId, domain: websites.primaryDomain })
    .from(websites)
    .where(isNull(websites.archivedAt))
    .orderBy(asc(websites.name));
}
