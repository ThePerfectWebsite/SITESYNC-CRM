// Hosting links and deployment sync (spec §3.21–§3.22, §5.2, §7.2). Providers
// are authoritative: each sync re-reads the project (auto-publish, current
// production deploy) and the last 50 deployments, upserts them order-tolerantly,
// and moves "published" to whatever the provider says is current.
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx, Tx } from "../db/client";
import { deployments, HOSTING_PROVIDERS, hostingLinks, integrations, repositoryLinks, websites } from "../db/schema";
import type { HostingAdapter, NormalizedDeployment } from "../providers/hosting";
import { ProviderError } from "../providers/http";
import { redact } from "../redact";
import { auditActor, type Actor } from "../records/actor";
import { DomainError, invalidField, isUniqueViolation, notFound, parseInput, type RawInput } from "../records/errors";
import { optionalDomain, optionalText } from "../records/fields";
import { rateLimitLow } from "./github-sync";
import { hostingAdapterFactory, withIntegrationAdapter, type AdapterFactory } from "./service";

export const INITIAL_DEPLOYMENTS = 50;

const optionalId = (message: string) =>
  z
    .string()
    .trim()
    .nullish()
    .transform((value) => (value ? value : null))
    .pipe(z.uuid({ message }).nullable());

export const hostingLinkSchema = z
  .object({
    integrationId: optionalId("Choose an integration."),
    /** Only for a manual record (no integration): which host it is. */
    provider: z
      .union([z.enum(HOSTING_PROVIDERS, { message: "Choose a host." }), z.literal("")])
      .optional()
      .transform((value) => value || "other"),
    providerProjectId: optionalText(200),
    providerProjectName: optionalText(200),
    environment: z
      .union([z.enum(["production", "preview", "staging"], { message: "Choose an environment." }), z.literal("")])
      .optional()
      .transform((value) => value || "production"),
    domain: optionalDomain,
    repositoryLinkId: optionalId("Choose a repository."),
  })
  .superRefine((value, ctx) => {
    if (value.integrationId && !value.providerProjectId) {
      ctx.addIssue({
        code: "custom",
        path: ["providerProjectId"],
        message: "Enter the project on the provider (Cloudflare Pages project name, Netlify site ID or Vercel project ID).",
      });
    }
  });

export type HostingLinkInput = RawInput<typeof hostingLinkSchema>;

export async function createHostingLink(db: Db, actor: Actor, websiteId: string, input: HostingLinkInput): Promise<string> {
  const data = parseInput(hostingLinkSchema, input);
  try {
    return await db.transaction(async (tx) => {
      const [website] = await tx.select().from(websites).where(eq(websites.id, websiteId)).for("share");
      if (!website) throw notFound("Website");
      if (website.archivedAt) throw new DomainError("conflict", "This website is archived.");
      let provider = data.provider;
      if (data.integrationId) {
        const [integration] = await tx.select().from(integrations).where(eq(integrations.id, data.integrationId));
        if (!integration || integration.archivedAt || integration.provider === "github") {
          throw invalidField("integrationId", "Choose a Netlify or Vercel integration.");
        }
        provider = integration.provider;
      }
      if (data.repositoryLinkId) {
        const [repo] = await tx.select().from(repositoryLinks).where(eq(repositoryLinks.id, data.repositoryLinkId));
        if (!repo || repo.websiteId !== websiteId || repo.archivedAt) {
          throw invalidField("repositoryLinkId", "Choose one of this website's repositories.");
        }
      }
      const [row] = await tx
        .insert(hostingLinks)
        .values({ websiteId, ...data, provider })
        .returning();
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "hosting_link.created",
        subjectType: "hosting_link",
        subjectId: row!.id,
        clientId: website.clientId,
        websiteId,
        summary: `${row!.environment} host (${provider}${data.integrationId ? "" : ", manual record"}) linked to ${website.name}`,
        after: { provider, environment: row!.environment, providerProjectId: row!.providerProjectId, domain: row!.domain },
        requestId: actor.requestId,
      });
      return row!.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, "hosting_links_one_production_key")) {
      throw invalidField("environment", "This website already has a production host. Unlink it first (one per website).");
    }
    if (isUniqueViolation(error, "hosting_links_provider_project_key")) {
      throw invalidField("providerProjectId", "That site/project is already linked for this environment.");
    }
    throw error;
  }
}

export async function archiveHostingLink(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [link] = await tx.select().from(hostingLinks).where(eq(hostingLinks.id, id)).for("update");
    if (!link) throw notFound("Hosting link");
    if (link.archivedAt) return;
    const [website] = await tx.select().from(websites).where(eq(websites.id, link.websiteId));
    await tx.update(hostingLinks).set({ archivedAt: new Date(), archivedBy: actor.userId }).where(eq(hostingLinks.id, id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "hosting_link.archived",
      subjectType: "hosting_link",
      subjectId: id,
      clientId: website?.clientId,
      websiteId: link.websiteId,
      summary: `${link.environment} host (${link.provider}) unlinked from ${website?.name ?? "website"}`,
      requestId: actor.requestId,
    });
  });
}

// --- Sync -------------------------------------------------------------------------

const SNAPSHOT_BUDGET = 60 * 1024;
const boundSnapshot = (snapshot: Record<string, unknown>) => {
  const redacted = redact(snapshot) as Record<string, unknown>;
  return Buffer.byteLength(JSON.stringify(redacted), "utf8") <= SNAPSHOT_BUDGET ? redacted : { _truncated: true };
};

type LinkRow = typeof hostingLinks.$inferSelect;

/**
 * Upserts provider deployments for a link. A row's fields change only when the
 * provider's timestamp isn't older than the stored one (out-of-order tolerant);
 * every row read is marked as just confirmed.
 */
export async function upsertDeployments(
  tx: DbOrTx,
  link: Pick<LinkRow, "id" | "websiteId" | "provider">,
  items: NormalizedDeployment[],
  now: Date,
): Promise<number> {
  if (!items.length) return 0;
  const unique = new Map(items.map((item) => [item.providerDeploymentId, item]));
  const rows = [...unique.values()].map((item) => ({
    hostingLinkId: link.id,
    websiteId: link.websiteId,
    provider: link.provider,
    providerDeploymentId: item.providerDeploymentId,
    environment: item.environment,
    origin: "provider_observed" as const,
    state: item.state,
    providerState: item.providerState,
    commitSha: item.commitSha,
    branch: item.branch,
    deployUrl: item.deployUrl,
    providerCreatedAt: item.providerCreatedAt,
    providerUpdatedAt: item.providerUpdatedAt,
    readyAt: item.readyAt,
    publishedAt: item.publishedAt,
    lastConfirmedAt: now,
    confirmationSource: "provider" as const,
    errorSummary: item.errorSummary,
    snapshot: boundSnapshot(item.snapshot),
  }));
  const written = await tx
    .insert(deployments)
    .values(rows)
    .onConflictDoUpdate({
      target: [deployments.provider, deployments.providerDeploymentId],
      targetWhere: sql`${deployments.providerDeploymentId} IS NOT NULL`,
      set: {
        state: sql`excluded.state`,
        providerState: sql`excluded.provider_state`,
        environment: sql`excluded.environment`,
        commitSha: sql`coalesce(excluded.commit_sha, ${deployments.commitSha})`,
        branch: sql`coalesce(excluded.branch, ${deployments.branch})`,
        deployUrl: sql`coalesce(excluded.deploy_url, ${deployments.deployUrl})`,
        providerUpdatedAt: sql`excluded.provider_updated_at`,
        readyAt: sql`coalesce(excluded.ready_at, ${deployments.readyAt})`,
        publishedAt: sql`coalesce(excluded.published_at, ${deployments.publishedAt})`,
        lastConfirmedAt: sql`excluded.last_confirmed_at`,
        errorSummary: sql`excluded.error_summary`,
        snapshot: sql`excluded.snapshot`,
      },
      // §5.2: never step back to an older provider view.
      setWhere: sql`${deployments.providerUpdatedAt} IS NULL OR excluded.provider_updated_at IS NULL
        OR excluded.provider_updated_at >= ${deployments.providerUpdatedAt}`,
    })
    .returning({ id: deployments.id });
  return written.length;
}

/**
 * Makes `currentProviderId` the link's one published deploy: it becomes
 * `published` (stamping published_at the first time) and any other deploy on
 * the link still marked published becomes `superseded`.
 */
export async function applyCurrentDeployment(tx: Tx, link: LinkRow, currentProviderId: string | null, now: Date) {
  let currentId: string | null = null;
  if (currentProviderId) {
    const [current] = await tx
      .update(deployments)
      .set({ state: "published", publishedAt: sql`coalesce(${deployments.publishedAt}, ${deployments.readyAt}, ${now})` })
      .where(
        and(
          eq(deployments.hostingLinkId, link.id),
          eq(deployments.provider, link.provider),
          eq(deployments.providerDeploymentId, currentProviderId),
        ),
      )
      .returning({ id: deployments.id });
    currentId = current?.id ?? null;
  }
  await tx
    .update(deployments)
    .set({ state: "superseded" })
    .where(
      and(
        eq(deployments.hostingLinkId, link.id),
        eq(deployments.state, "published"),
        currentId ? ne(deployments.id, currentId) : undefined,
        // A SiteSync promote/rollback record stays published while its target is live.
        currentId ? sql`${deployments.targetDeploymentId} IS DISTINCT FROM ${currentId}` : undefined,
      ),
    );
  return currentId;
}

/**
 * Serializes work on one hosting link's deployments: a sync's upserts and a
 * dispatch recording the provider's new deploy ID (Phase 4) never interleave.
 */
export async function lockHostingLinkWork(tx: Tx, linkId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hosting_link:${linkId}`}, 0))`);
}

export type HostingSyncResult =
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: unknown }
  | { status: "ok"; deployments: number; written: number; currentDeploymentId: string | null; autoPublish: string };

export async function syncHostingLink(
  db: Db,
  linkId: string,
  options: { factory?: AdapterFactory<HostingAdapter>; now?: Date } = {},
): Promise<HostingSyncResult> {
  const now = options.now ?? new Date();
  const [row] = await db
    .select({ link: hostingLinks, integration: integrations })
    .from(hostingLinks)
    .leftJoin(integrations, eq(integrations.id, hostingLinks.integrationId))
    .where(eq(hostingLinks.id, linkId));
  if (!row) return { status: "skipped", reason: "link not found" };
  const { link, integration } = row;
  if (link.archivedAt) return { status: "skipped", reason: "link archived" };
  if (!integration) return { status: "skipped", reason: "manual record" };
  if (integration.archivedAt) return { status: "skipped", reason: "integration archived" };
  if (integration.health === "disabled") return { status: "skipped", reason: "integration disabled" };

  await db.update(integrations).set({ lastSyncStartedAt: now }).where(eq(integrations.id, integration.id));
  const projectId = link.providerProjectId!;
  const result = await withIntegrationAdapter(
    db,
    integration,
    options.factory ?? hostingAdapterFactory(integration),
    async (adapter) => {
      const project = await adapter.getProject(projectId).catch((error) => {
        if (error instanceof ProviderError && error.kind === "not_found") {
          throw new ProviderError(
            "not_found",
            `${integration.name} can't see ${link.provider === "netlify" ? "site" : "project"} ${projectId}. Check the ID, and that the token has access to it.`,
            404,
          );
        }
        throw error;
      });
      const page = await adapter.listDeployments(projectId, { limit: INITIAL_DEPLOYMENTS });
      return { project, page };
    },
    { kind: "sync", now },
  );
  if (!result.ok) return { status: "failed", error: result.error };

  const { project, page } = result.value;
  // All of the provider project's deploys live on its link (each row has its own
  // environment): Phase 4 promotes previews, and the overview shows the latest one.
  const items = page.items;
  const outcome = await db.transaction(async (tx) => {
    await lockHostingLinkWork(tx, link.id);
    const written = await upsertDeployments(tx, link, items, now);
    const currentId =
      link.environment === "production" ? await applyCurrentDeployment(tx, link, project.currentProductionDeploymentId, now) : null;
    await tx
      .update(hostingLinks)
      .set({
        autoPublish: project.autoPublish,
        autoPublishCheckedAt: now,
        currentDeploymentId: link.environment === "production" ? currentId : link.currentDeploymentId,
        lastSyncedAt: now,
        providerProjectName: link.providerProjectName ?? project.name.slice(0, 200),
        domain: link.domain ?? project.productionDomain,
      })
      .where(eq(hostingLinks.id, link.id));
    return { written, currentId };
  });
  return {
    status: "ok",
    deployments: items.length,
    written: outcome.written,
    currentDeploymentId: outcome.currentId,
    autoPublish: project.autoPublish,
  };
}

/** Hosting links due a poll (same rules as repository links). */
export async function hostingLinksDueForPoll(db: DbOrTx, intervalMinutes: number, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - intervalMinutes * 60 * 1000);
  const rows = await db
    .select({ link: hostingLinks, integration: integrations })
    .from(hostingLinks)
    .innerJoin(integrations, eq(integrations.id, hostingLinks.integrationId))
    .where(
      and(
        isNull(hostingLinks.archivedAt),
        isNull(integrations.archivedAt),
        eq(integrations.pollEnabled, true),
        inArray(integrations.health, ["ok", "degraded", "unconfigured"]),
      ),
    );
  return rows
    .filter(({ link }) => !link.lastSyncedAt || link.lastSyncedAt <= cutoff)
    .filter(({ integration }) => !rateLimitLow(integration, now))
    .map(({ link }) => link.id);
}

// --- Queries ----------------------------------------------------------------------

export async function listHostingLinks(db: DbOrTx, websiteId: string) {
  return db
    .select({
      link: hostingLinks,
      integrationName: integrations.name,
      integrationHealth: integrations.health,
      integrationHealthDetail: integrations.healthDetail,
    })
    .from(hostingLinks)
    .leftJoin(integrations, eq(integrations.id, hostingLinks.integrationId))
    .where(and(eq(hostingLinks.websiteId, websiteId), isNull(hostingLinks.archivedAt)))
    .orderBy(sql`CASE ${hostingLinks.environment} WHEN 'production' THEN 0 WHEN 'staging' THEN 1 ELSE 2 END`, asc(hostingLinks.createdAt));
}

const deploymentColumns = {
  id: deployments.id,
  provider: deployments.provider,
  providerDeploymentId: deployments.providerDeploymentId,
  environment: deployments.environment,
  origin: deployments.origin,
  state: deployments.state,
  providerState: deployments.providerState,
  commitSha: deployments.commitSha,
  branch: deployments.branch,
  deployUrl: deployments.deployUrl,
  providerCreatedAt: deployments.providerCreatedAt,
  publishedAt: deployments.publishedAt,
  lastConfirmedAt: deployments.lastConfirmedAt,
  errorSummary: deployments.errorSummary,
  projectId: deployments.projectId,
  hostingLinkId: deployments.hostingLinkId,
};

export async function listDeploymentsForWebsite(db: DbOrTx, websiteId: string, limit = 25) {
  return db
    .select(deploymentColumns)
    .from(deployments)
    .where(eq(deployments.websiteId, websiteId))
    .orderBy(sql`coalesce(${deployments.providerCreatedAt}, ${deployments.createdAt}) DESC`)
    .limit(limit);
}

/** Current live production deploy and the latest preview for a website (overview, screen 9). */
export async function liveAndLatestPreview(db: DbOrTx, websiteId: string) {
  const [live] = await db
    .select(deploymentColumns)
    .from(deployments)
    .innerJoin(hostingLinks, eq(hostingLinks.currentDeploymentId, deployments.id))
    .where(and(eq(hostingLinks.websiteId, websiteId), eq(hostingLinks.environment, "production"), isNull(hostingLinks.archivedAt)))
    .limit(1);
  const [preview] = await db
    .select(deploymentColumns)
    .from(deployments)
    .where(and(eq(deployments.websiteId, websiteId), notInArray(deployments.environment, ["production"])))
    .orderBy(sql`coalesce(${deployments.providerCreatedAt}, ${deployments.createdAt}) DESC`)
    .limit(1);
  return { live: live ?? null, preview: preview ?? null };
}

/** Failed production deploys (last 7 days) and in-flight builds on live websites: dashboard alerts. */
export async function deploymentAlerts(db: DbOrTx, now: Date = new Date()) {
  const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  return db
    .select({ ...deploymentColumns, websiteId: websites.id, websiteName: websites.name })
    .from(deployments)
    .innerJoin(websites, eq(websites.id, deployments.websiteId))
    .where(
      and(
        isNull(websites.archivedAt),
        eq(deployments.environment, "production"),
        sql`(${deployments.state} IN ('queued','building') OR (${deployments.state} = 'failed' AND coalesce(${deployments.providerCreatedAt}, ${deployments.createdAt}) >= ${since}))`,
      ),
    )
    .orderBy(desc(sql`coalesce(${deployments.providerCreatedAt}, ${deployments.createdAt})`))
    .limit(20);
}
