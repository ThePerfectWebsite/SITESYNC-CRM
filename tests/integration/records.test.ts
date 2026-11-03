import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { auditEvents, contacts } from "@/server/db/schema";
import { listActivity } from "@/server/records/activity";
import type { Actor } from "@/server/records/actor";
import {
  archiveClient,
  createClient,
  getClient,
  listClients,
  restoreClient,
  updateClient,
} from "@/server/records/clients";
import { archiveContact, createContact, listContacts, updateContact } from "@/server/records/contacts";
import { DomainError } from "@/server/records/errors";
import { searchRecords } from "@/server/records/search";
import { archiveWebsite, createWebsite, getWebsite, restoreWebsite } from "@/server/records/websites";
import { transitionStage, loadStages } from "@/server/stages/service";
import { createAdmin, makeClient, makeProject } from "../support/factories";
import { appDb, resetTestDatabase } from "../support/test-db";

let db: Db;
let pool: pg.Pool;
let actor: Actor;

beforeAll(async () => {
  await resetTestDatabase();
  ({ db, pool } = appDb());
  actor = await createAdmin(db);
});

afterAll(async () => {
  await pool?.end();
});

const auditFor = (subjectId: string) =>
  db.select().from(auditEvents).where(eq(auditEvents.subjectId, subjectId));

describe("clients", () => {
  it("validates input and reports field errors", async () => {
    await expect(createClient(db, actor, { name: "  " })).rejects.toMatchObject({
      code: "invalid",
      fieldErrors: { name: "Enter a name." },
    });
    await expect(createClient(db, actor, { name: "Ok", slug: "Not A Slug" })).rejects.toMatchObject({
      fieldErrors: { slug: expect.any(String) },
    });
    await expect(createClient(db, actor, { name: "Ok", status: "bogus" as never })).rejects.toMatchObject({
      fieldErrors: { status: "Choose a status." },
    });
  });

  it("derives a unique slug from the name, and refuses a duplicate explicit slug", async () => {
    const first = await createClient(db, actor, { name: "Acme Café Ltd" });
    const second = await createClient(db, actor, { name: "Acme Cafe ltd" });
    expect((await getClient(db, first))?.slug).toBe("acme-cafe-ltd");
    expect((await getClient(db, second))?.slug).toBe("acme-cafe-ltd-2");
    await expect(createClient(db, actor, { name: "Other", slug: "acme-cafe-ltd" })).rejects.toMatchObject({
      fieldErrors: { slug: "Another client uses this slug." },
    });
  });

  it("writes redacted audit events with before/after for create and update", async () => {
    const id = await createClient(db, actor, { name: "Audited", notes: "api_key=abc123" });
    await updateClient(db, actor, id, { name: "Audited Ltd", status: "paused" });
    const events = await auditFor(id);
    expect(events.map((e) => e.action).sort()).toEqual(["client.created", "client.updated"]);
    const update = events.find((e) => e.action === "client.updated")!;
    expect(update).toMatchObject({
      actorType: "user",
      actorUserId: actor.userId,
      clientId: id,
      before: { name: "Audited", status: "active" },
      after: { name: "Audited Ltd", status: "paused" },
    });
  });

  it("archive hides the client by default; restore brings it back; both are audited", async () => {
    const id = await makeClient(db, actor, "Archivable");
    await archiveClient(db, actor, id);
    expect((await listClients(db)).map((c) => c.id)).not.toContain(id);
    expect((await listClients(db, { includeArchived: true })).map((c) => c.id)).toContain(id);
    await expect(updateClient(db, actor, id, { name: "Edited" })).rejects.toMatchObject({ code: "conflict" });
    await restoreClient(db, actor, id);
    expect((await listClients(db)).map((c) => c.id)).toContain(id);
    expect((await auditFor(id)).map((e) => e.action)).toEqual(
      expect.arrayContaining(["client.archived", "client.restored"]),
    );
  });

  it("refuses to archive a client with live websites or projects", async () => {
    const { clientId } = await makeProject(db, actor);
    await expect(archiveClient(db, actor, clientId)).rejects.toMatchObject({
      code: "conflict",
      message: "Archive this client's projects first.",
    });
  });

  it("filters by search text and status", async () => {
    await createClient(db, actor, { name: "Zebra Studios", status: "prospect" });
    expect((await listClients(db, { q: "zebra" })).map((c) => c.name)).toEqual(["Zebra Studios"]);
    expect((await listClients(db, { q: "zebra", status: "active" }))).toEqual([]);
    expect((await listClients(db, { q: "100%" }))).toEqual([]);
  });
});

describe("contacts", () => {
  it("keeps at most one primary contact per client", async () => {
    const clientId = await makeClient(db, actor);
    const a = await createContact(db, actor, clientId, { name: "Ann", isPrimary: "on" });
    const b = await createContact(db, actor, clientId, { name: "Bob", email: "BOB@Example.com", isPrimary: "on" });
    let rows = await listContacts(db, clientId);
    expect(rows.filter((c) => c.isPrimary).map((c) => c.id)).toEqual([b]);

    await updateContact(db, actor, a, { name: "Ann", isPrimary: true });
    rows = await listContacts(db, clientId);
    expect(rows.filter((c) => c.isPrimary).map((c) => c.id)).toEqual([a]);

    // The database backs this up.
    await expect(
      pool.query("UPDATE contacts SET is_primary = true WHERE id = $1", [b]),
    ).rejects.toMatchObject({ code: "23505", constraint: "contacts_one_primary_key" });
  });

  it("validates email and archives without deleting", async () => {
    const clientId = await makeClient(db, actor);
    await expect(createContact(db, actor, clientId, { name: "X", email: "not-an-email" })).rejects.toMatchObject({
      fieldErrors: { email: "Enter a valid email address." },
    });
    const id = await createContact(db, actor, clientId, { name: "Cat", isPrimary: true });
    await archiveContact(db, actor, id);
    expect(await listContacts(db, clientId)).toEqual([]);
    const [row] = await db.select().from(contacts).where(and(eq(contacts.id, id)));
    expect(row).toMatchObject({ isPrimary: false, archivedBy: actor.userId });
  });
});

describe("websites", () => {
  it("normalizes and validates the domain, unique among live websites", async () => {
    const clientId = await makeClient(db, actor);
    const id = await createWebsite(db, actor, { clientId, name: "Main", primaryDomain: "  WWW.Example.COM. " });
    expect((await getWebsite(db, id))?.website.primaryDomain).toBe("www.example.com");
    await expect(
      createWebsite(db, actor, { clientId, name: "Dup", primaryDomain: "www.example.com" }),
    ).rejects.toMatchObject({ fieldErrors: { primaryDomain: "Another website already uses this domain." } });
    for (const bad of ["https://example.com", "example.com/path", "localhost", "-bad-.com"]) {
      await expect(createWebsite(db, actor, { clientId, name: "Bad", primaryDomain: bad })).rejects.toMatchObject({
        fieldErrors: { primaryDomain: expect.any(String) },
      });
    }
  });

  it("can't be created for an archived client, or archived while it has live projects", async () => {
    const archived = await makeClient(db, actor);
    await archiveClient(db, actor, archived);
    await expect(createWebsite(db, actor, { clientId: archived, name: "Nope" })).rejects.toMatchObject({
      fieldErrors: { clientId: "This client is archived." },
    });

    const { websiteId, projectId } = await makeProject(db, actor);
    await expect(archiveWebsite(db, actor, websiteId)).rejects.toBeInstanceOf(DomainError);
    const current = (await loadStages(db, projectId)).find((s) => s.status === "current")!;
    await transitionStage(db, actor, {
      projectId,
      expectedCurrentStageId: current.id,
      request: { kind: "archive", reason: "Done" },
    });
    await archiveWebsite(db, actor, websiteId);
    expect((await getWebsite(db, websiteId))?.website.archivedAt).toBeInstanceOf(Date);
    await restoreWebsite(db, actor, websiteId);
    expect((await getWebsite(db, websiteId))?.website.archivedAt).toBeNull();
  });
});

describe("search", () => {
  it("finds clients, websites and projects by name, code or domain, including near misses", async () => {
    const clientId = await createClient(db, actor, { name: "Harbourside Bakery" });
    const websiteId = await createWebsite(db, actor, { clientId, name: "Bakery shop", primaryDomain: "harbourbakes.co.uk" });
    const { projectId } = await makeProject(db, actor, { clientId, websiteId, name: "Spring relaunch", code: "HB-2026-01" });

    const ids = async (q: string) => (await searchRecords(db, q)).map((h) => h.id);
    expect(await ids("harbourside")).toContain(clientId);
    expect(await ids("harbourbakes")).toContain(websiteId);
    expect(await ids("HB-2026")).toContain(projectId);
    expect(await ids("Harborside Bakery")).toContain(clientId); // trigram typo match
    expect(await searchRecords(db, "a")).toEqual([]);
    expect(await ids("%")).toEqual([]);
  });

  it("leaves archived records out", async () => {
    const id = await createClient(db, actor, { name: "Quokka Archive Co" });
    await archiveClient(db, actor, id);
    expect((await searchRecords(db, "Quokka")).map((h) => h.id)).not.toContain(id);
  });
});

describe("activity", () => {
  it("scopes audit events to a project with the actor's name", async () => {
    const { projectId } = await makeProject(db, actor, { name: "Activity project" });
    const events = await listActivity(db, { projectId });
    expect(events[0]).toMatchObject({ action: "project.created", actorName: "Test Operator", projectId });
  });
});
