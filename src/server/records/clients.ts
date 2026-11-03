// Clients (spec §3.6): create, update, archive, restore, list, detail.
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { DbOrTx, Db } from "../db/client";
import { CLIENT_STATUSES, clients, projects, websites, type ClientStatus } from "../db/schema";
import { auditActor, type Actor } from "./actor";
import { DomainError, invalidField, isUniqueViolation, notFound, parseInput, type RawInput } from "./errors";
import { escapeLike, optionalText, requiredText, SLUG, slugify } from "./fields";

export const clientSchema = z.object({
  name: requiredText("a name", 200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(100, "Keep the slug to 100 characters.")
    .nullish()
    .transform((value) => (value ? value : null))
    .refine((value) => value === null || SLUG.test(value), {
      message: "Use lower-case letters, numbers and single hyphens.",
    }),
  status: z.enum(CLIENT_STATUSES, { message: "Choose a status." }).default("active"),
  notes: optionalText(20000),
});

export type ClientInput = RawInput<typeof clientSchema>;

const SLUG_KEY = "clients_slug_live_key";

function snapshot(row: { name: string; slug: string; status: string; notes: string | null }) {
  return { name: row.name, slug: row.slug, status: row.status, notes: row.notes };
}

async function lockClient(db: DbOrTx, id: string) {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).for("update");
  if (!row) throw notFound("Client");
  return row;
}

/** A free slug: the requested one, or the name's slug with a numeric suffix if taken. */
async function freeSlug(db: DbOrTx, base: string, excludeId?: string): Promise<string> {
  const root = base || "client";
  const taken = await db
    .select({ slug: clients.slug })
    .from(clients)
    .where(
      and(
        isNull(clients.archivedAt),
        or(eq(clients.slug, root), ilike(clients.slug, `${escapeLike(root)}-%`)),
        excludeId ? sql`${clients.id} <> ${excludeId}` : undefined,
      ),
    );
  const used = new Set(taken.map((r) => r.slug));
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root.slice(0, 95)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export async function createClient(db: Db, actor: Actor, input: ClientInput): Promise<string> {
  const data = parseInput(clientSchema, input);
  try {
    return await db.transaction(async (tx) => {
      const slug = data.slug ?? (await freeSlug(tx, slugify(data.name)));
      const [row] = await tx
        .insert(clients)
        .values({ name: data.name, slug, status: data.status, notes: data.notes })
        .returning();
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "client.created",
        subjectType: "client",
        subjectId: row!.id,
        clientId: row!.id,
        summary: `Client ${row!.name} created`,
        after: snapshot(row!),
        requestId: actor.requestId,
      });
      return row!.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, SLUG_KEY)) throw invalidField("slug", "Another client uses this slug.");
    throw error;
  }
}

export async function updateClient(db: Db, actor: Actor, id: string, input: ClientInput): Promise<void> {
  const data = parseInput(clientSchema, input);
  try {
    await db.transaction(async (tx) => {
      const before = await lockClient(tx, id);
      if (before.archivedAt) throw new DomainError("conflict", "Restore this client before editing it.");
      const [after] = await tx
        .update(clients)
        .set({ name: data.name, slug: data.slug ?? before.slug, status: data.status, notes: data.notes })
        .where(eq(clients.id, id))
        .returning();
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "client.updated",
        subjectType: "client",
        subjectId: id,
        clientId: id,
        summary: `Client ${after!.name} updated`,
        before: snapshot(before),
        after: snapshot(after!),
        requestId: actor.requestId,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, SLUG_KEY)) throw invalidField("slug", "Another client uses this slug.");
    throw error;
  }
}

export async function archiveClient(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockClient(tx, id);
    if (row.archivedAt) return;
    const openProjects = await tx.$count(
      projects,
      and(eq(projects.clientId, id), isNull(projects.archivedAt)),
    );
    const openWebsites = await tx.$count(
      websites,
      and(eq(websites.clientId, id), isNull(websites.archivedAt)),
    );
    if (openProjects > 0 || openWebsites > 0) {
      throw new DomainError(
        "conflict",
        `Archive this client's ${openProjects > 0 ? "projects" : "websites"} first.`,
      );
    }
    const now = new Date();
    await tx.update(clients).set({ archivedAt: now, archivedBy: actor.userId }).where(eq(clients.id, id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "client.archived",
      subjectType: "client",
      subjectId: id,
      clientId: id,
      summary: `Client ${row.name} archived`,
      requestId: actor.requestId,
    });
  });
}

export async function restoreClient(db: Db, actor: Actor, id: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const row = await lockClient(tx, id);
      if (!row.archivedAt) return;
      await tx.update(clients).set({ archivedAt: null, archivedBy: null }).where(eq(clients.id, id));
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "client.restored",
        subjectType: "client",
        subjectId: id,
        clientId: id,
        summary: `Client ${row.name} restored`,
        requestId: actor.requestId,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, SLUG_KEY)) {
      throw new DomainError("conflict", "Another client now uses this client's slug. Change one of them first.");
    }
    throw error;
  }
}

export type ClientFilters = { q?: string | null; status?: ClientStatus | null; includeArchived?: boolean };

export async function listClients(db: DbOrTx, filters: ClientFilters = {}) {
  const conditions: SQL[] = [];
  if (!filters.includeArchived) conditions.push(isNull(clients.archivedAt));
  if (filters.status) conditions.push(eq(clients.status, filters.status));
  const q = filters.q?.trim();
  if (q) {
    conditions.push(
      or(ilike(clients.name, `%${escapeLike(q)}%`), ilike(clients.slug, `%${escapeLike(q)}%`))!,
    );
  }
  return db
    .select({
      id: clients.id,
      name: clients.name,
      slug: clients.slug,
      status: clients.status,
      archivedAt: clients.archivedAt,
      websiteCount: sql<number>`(SELECT count(*)::int FROM ${websites} WHERE ${websites.clientId} = ${clients.id} AND ${websites.archivedAt} IS NULL)`,
      projectCount: sql<number>`(SELECT count(*)::int FROM ${projects} WHERE ${projects.clientId} = ${clients.id} AND ${projects.archivedAt} IS NULL)`,
    })
    .from(clients)
    .where(and(...conditions))
    .orderBy(asc(clients.name))
    .limit(500);
}

export async function getClient(db: DbOrTx, id: string) {
  const [row] = await db.select().from(clients).where(eq(clients.id, id));
  return row ?? null;
}

/** Live clients for pickers (e.g. the new website and project forms). */
export async function clientOptions(db: DbOrTx) {
  return db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(isNull(clients.archivedAt))
    .orderBy(asc(clients.name));
}
