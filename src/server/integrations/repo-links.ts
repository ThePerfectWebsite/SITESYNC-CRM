// Repository links (spec §3.19): a website's GitHub repository and the branch
// that is production. One primary link per website.
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx } from "../db/client";
import { integrations, repositoryEvents, repositoryLinks, websites } from "../db/schema";
import { auditActor, type Actor } from "../records/actor";
import { DomainError, invalidField, isUniqueViolation, notFound, parseInput, type RawInput } from "../records/errors";
import { uuid } from "../records/fields";

const BRANCH_FORBIDDEN = /(\.\.|[\x00-\x1f\x7f ~^:?*[\\]|@\{|^\/|\/$|\.lock$|^-)/;

export const repositoryLinkSchema = z.object({
  integrationId: uuid("Choose a GitHub integration."),
  owner: z
    .string({ message: "Enter the repository owner." })
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "Enter a GitHub user or organisation name."),
  repo: z
    .string({ message: "Enter the repository name." })
    .trim()
    .transform((value) => value.replace(/\.git$/, ""))
    .pipe(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "Enter the repository name, e.g. marketing-site.")),
  productionBranch: z
    .string({ message: "Enter the production branch." })
    .trim()
    .min(1, "Enter the production branch.")
    .max(255, "Branch names are at most 255 characters.")
    .refine((value) => !BRANCH_FORBIDDEN.test(value), "That isn't a valid branch name."),
  isPrimary: z
    .union([z.boolean(), z.literal("on"), z.literal(""), z.null()])
    .optional()
    .transform((value) => value === true || value === "on"),
});

export type RepositoryLinkInput = RawInput<typeof repositoryLinkSchema>;

export async function createRepositoryLink(
  db: Db,
  actor: Actor,
  websiteId: string,
  input: RepositoryLinkInput,
): Promise<string> {
  const data = parseInput(repositoryLinkSchema, input);
  try {
    return await db.transaction(async (tx) => {
      const [website] = await tx.select().from(websites).where(eq(websites.id, websiteId)).for("share");
      if (!website) throw notFound("Website");
      if (website.archivedAt) throw new DomainError("conflict", "This website is archived.");
      const [integration] = await tx.select().from(integrations).where(eq(integrations.id, data.integrationId));
      if (!integration || integration.archivedAt || integration.provider !== "github") {
        throw invalidField("integrationId", "Choose a GitHub integration.");
      }
      const hasPrimary =
        (await tx.$count(
          repositoryLinks,
          and(eq(repositoryLinks.websiteId, websiteId), eq(repositoryLinks.isPrimary, true), isNull(repositoryLinks.archivedAt)),
        )) > 0;
      // The first link is primary; a new primary replaces the old one.
      const isPrimary = data.isPrimary || !hasPrimary;
      if (isPrimary && hasPrimary) {
        await tx
          .update(repositoryLinks)
          .set({ isPrimary: false })
          .where(and(eq(repositoryLinks.websiteId, websiteId), isNull(repositoryLinks.archivedAt)));
      }
      const [row] = await tx
        .insert(repositoryLinks)
        .values({ websiteId, ...data, isPrimary })
        .returning();
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "repository_link.created",
        subjectType: "repository_link",
        subjectId: row!.id,
        clientId: website.clientId,
        websiteId,
        summary: `Repository ${data.owner}/${data.repo} (${data.productionBranch}) linked to ${website.name}`,
        after: { owner: data.owner, repo: data.repo, productionBranch: data.productionBranch, isPrimary },
        requestId: actor.requestId,
      });
      return row!.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, "repository_links_repo_live_key")) {
      throw invalidField("repo", "This repository is already linked to this website.");
    }
    throw error;
  }
}

export async function archiveRepositoryLink(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [link] = await tx.select().from(repositoryLinks).where(eq(repositoryLinks.id, id)).for("update");
    if (!link) throw notFound("Repository link");
    if (link.archivedAt) return;
    const [website] = await tx.select().from(websites).where(eq(websites.id, link.websiteId));
    await tx
      .update(repositoryLinks)
      .set({ archivedAt: new Date(), archivedBy: actor.userId, isPrimary: false })
      .where(eq(repositoryLinks.id, id));
    // Keep a primary if another live link remains.
    const [next] = await tx
      .select({ id: repositoryLinks.id })
      .from(repositoryLinks)
      .where(and(eq(repositoryLinks.websiteId, link.websiteId), isNull(repositoryLinks.archivedAt), ne(repositoryLinks.id, id)))
      .orderBy(asc(repositoryLinks.createdAt))
      .limit(1);
    if (link.isPrimary && next) await tx.update(repositoryLinks).set({ isPrimary: true }).where(eq(repositoryLinks.id, next.id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "repository_link.archived",
      subjectType: "repository_link",
      subjectId: id,
      clientId: website?.clientId,
      websiteId: link.websiteId,
      summary: `Repository ${link.owner}/${link.repo} unlinked`,
      requestId: actor.requestId,
    });
  });
}

export async function getRepositoryLink(db: DbOrTx, id: string) {
  const [row] = await db.select().from(repositoryLinks).where(eq(repositoryLinks.id, id));
  return row ?? null;
}

export async function listRepositoryLinks(db: DbOrTx, websiteId: string) {
  return db
    .select({
      link: repositoryLinks,
      integrationName: integrations.name,
      integrationHealth: integrations.health,
      integrationHealthDetail: integrations.healthDetail,
    })
    .from(repositoryLinks)
    .innerJoin(integrations, eq(integrations.id, repositoryLinks.integrationId))
    .where(and(eq(repositoryLinks.websiteId, websiteId), isNull(repositoryLinks.archivedAt)))
    .orderBy(desc(repositoryLinks.isPrimary), asc(repositoryLinks.owner), asc(repositoryLinks.repo));
}

/** The latest check run per name for one commit (re-runs replace earlier runs). */
export async function latestChecksForCommit(db: DbOrTx, linkId: string, commitSha: string) {
  const rows = await db
    .select()
    .from(repositoryEvents)
    .where(
      and(
        eq(repositoryEvents.repositoryLinkId, linkId),
        eq(repositoryEvents.eventType, "check_run"),
        eq(repositoryEvents.commitSha, commitSha),
      ),
    )
    .orderBy(desc(sql`coalesce(${repositoryEvents.providerUpdatedAt}, ${repositoryEvents.occurredAt})`), desc(repositoryEvents.occurredAt));
  const seen = new Set<string>();
  return rows.filter((row) => {
    const name = row.title ?? row.providerEventId;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** Recent activity for a link: commits on the production branch, open PRs into it, checks on its head. */
export async function repositorySummary(db: DbOrTx, link: typeof repositoryLinks.$inferSelect) {
  const [commits, pulls] = await Promise.all([
    db
      .select()
      .from(repositoryEvents)
      .where(and(eq(repositoryEvents.repositoryLinkId, link.id), eq(repositoryEvents.eventType, "commit")))
      .orderBy(desc(repositoryEvents.occurredAt))
      .limit(5),
    db
      .select()
      .from(repositoryEvents)
      .where(
        and(
          eq(repositoryEvents.repositoryLinkId, link.id),
          eq(repositoryEvents.eventType, "pull_request"),
          inArray(repositoryEvents.state, ["open"]),
        ),
      )
      .orderBy(desc(repositoryEvents.providerUpdatedAt))
      .limit(20),
  ]);
  const headSha = link.syncCursor?.headSha ?? null;
  const checks = headSha ? await latestChecksForCommit(db, link.id, headSha) : [];
  return {
    headSha,
    commits,
    pullsIntoProduction: pulls.filter((pr) => pr.ref === link.productionBranch),
    otherPulls: pulls.filter((pr) => pr.ref !== link.productionBranch),
    checks,
  };
}
