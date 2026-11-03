// Deployment preflight (spec §8.2, decision 0011). Everything the approval screen
// shows is computed here, server-side, from SiteSync's synced data. The snapshot
// is hashed; Approve recomputes it and refuses if the hash differs, so what was
// approved is exactly what was on screen.
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import {
  clients,
  deployments,
  hostingLinks,
  integrations,
  productionApprovals,
  projects,
  repositoryEvents,
  repositoryLinks,
  websites,
  type ApprovalAction,
} from "../db/schema";
import { latestChecksForCommit } from "../integrations/repo-links";
import { HOSTING_CAPABILITIES } from "../providers/hosting";
import { computeReadiness, type ReadinessReport } from "../records/readiness";
import { currentStage, linearStages, type StageView } from "../stages/machine";
import { loadStages } from "../stages/service";

/** Data older than this disables Approve (spec §8.2). */
export const FRESHNESS_MS = 5 * 60 * 1000;
export const APPROVAL_TTL_MINUTES = 30;

export const ACTION_LABELS: Record<ApprovalAction, string> = {
  promote: "Promote a built deploy",
  rollback: "Roll back",
  build_from_ref: "Build and release the production branch",
};

export type PreflightRequest = { action: ApprovalAction; targetDeploymentId?: string | null };

type DeploymentRow = typeof deployments.$inferSelect;

export type PreflightDeploy = {
  deploymentId: string;
  providerDeploymentId: string | null;
  commitSha: string | null;
  branch: string | null;
  deployUrl: string | null;
  state: string;
  environment: string;
  publishedAt: Date | null;
  lastConfirmedAt: Date | null;
};

export type Preflight = {
  request: PreflightRequest;
  project: { id: string; name: string; code: string | null; stageName: string; clientName: string; websiteId: string; websiteName: string };
  link: {
    id: string;
    provider: "netlify" | "vercel" | "cloudflare" | "other";
    providerProjectId: string | null;
    providerProjectName: string | null;
    domain: string | null;
    autoPublish: string;
    integrationId: string | null;
    integrationName: string | null;
    integrationHealth: string | null;
    lastSyncedAt: Date | null;
  } | null;
  current: PreflightDeploy | null;
  /** For promote/rollback: the deploy to make live. */
  target: PreflightDeploy | null;
  /** The commit that would go live, and (build_from_ref) the branch built. */
  targetCommitSha: string | null;
  productionBranch: string | null;
  repository: { id: string; fullName: string; lastSyncedAt: Date | null; htmlUrl: string | null } | null;
  compareUrl: string | null;
  checks: { name: string; state: string; conclusion: string | null; htmlUrl: string | null }[];
  openPullRequests: { number: string; title: string | null; htmlUrl: string | null }[];
  readiness: ReadinessReport;
  /** Why Approve is disabled, apart from readiness blockers. */
  problems: string[];
  stale: boolean;
  awaitingApprovalId: string | null;
  canApprove: boolean;
  snapshot: Record<string, unknown>;
  /** Hex SHA-256 of the canonical snapshot. */
  hash: string;
};

/** JSON with object keys sorted at every level, so equal data always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function hashSnapshot(snapshot: Record<string, unknown>): Buffer {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest();
}

const view = (row: DeploymentRow | null | undefined): PreflightDeploy | null =>
  row
    ? {
        deploymentId: row.id,
        providerDeploymentId: row.providerDeploymentId,
        commitSha: row.commitSha,
        branch: row.branch,
        deployUrl: row.deployUrl,
        state: row.state,
        environment: row.environment,
        publishedAt: row.publishedAt,
        lastConfirmedAt: row.lastConfirmedAt,
      }
    : null;

/** Stage rule (spec §8.5): release work starts at Ready to Deploy (or later, for a re-deploy). */
export function releaseStageProblem(stages: StageView[]): string | null {
  const current = currentStage(stages);
  if (current.kind !== "linear") return `The project is ${current.name}.`;
  const rtd = linearStages(stages).find((s) => s.role === "ready_to_deploy");
  if (rtd && current.position < rtd.position) return `The project is at ${current.name}. Move it to ${rtd.name} first.`;
  return null;
}

/**
 * Builds the preflight for one release request. Reads only SiteSync's data; the
 * screen's "Refresh from provider" re-syncs first, and the executor re-checks
 * the provider itself (§8.4).
 */
export async function buildPreflight(
  db: DbOrTx,
  projectId: string,
  request: PreflightRequest,
  now: Date = new Date(),
): Promise<Preflight | null> {
  const [row] = await db
    .select({ project: projects, client: clients, website: websites })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .innerJoin(websites, eq(websites.id, projects.websiteId))
    .where(eq(projects.id, projectId));
  if (!row) return null;
  const { project, client, website } = row;
  const problems: string[] = [];
  if (project.archivedAt) problems.push("The project is archived.");

  const stages = await loadStages(db, projectId);
  const stageProblem = releaseStageProblem(stages);
  if (stageProblem) problems.push(stageProblem);

  const [linkRow] = await db
    .select({ link: hostingLinks, integration: integrations })
    .from(hostingLinks)
    .leftJoin(integrations, eq(integrations.id, hostingLinks.integrationId))
    .where(and(eq(hostingLinks.websiteId, website.id), eq(hostingLinks.environment, "production"), isNull(hostingLinks.archivedAt)));
  const link = linkRow?.link ?? null;
  const integration = linkRow?.integration ?? null;

  if (!link) {
    problems.push("The website has no production host.");
  } else if (!integration || link.provider === "other") {
    problems.push("The production host is a manual record. SiteSync can only release through a connected provider.");
  } else {
    if (integration.archivedAt) problems.push(`The ${integration.name} integration is archived.`);
    else if (["disabled", "unconfigured", "error"].includes(integration.health)) {
      problems.push(`The ${integration.name} integration is ${integration.health}: ${integration.healthDetail ?? "fix it on the Integrations page"}.`);
    }
    const capabilities = HOSTING_CAPABILITIES[link.provider as "netlify" | "vercel" | "cloudflare"];
    const supported =
      request.action === "promote" ? capabilities.promote : request.action === "rollback" ? capabilities.rollback : capabilities.buildFromRef;
    if (!supported) {
      problems.push(
        request.action === "build_from_ref"
          ? "This host releases a specific built deploy instead: choose one to promote."
          : request.action === "promote"
            ? "Cloudflare Pages can't promote a preview. Release the production branch instead."
            : "This host can't roll back from SiteSync.",
      );
    }
  }

  const current = link?.currentDeploymentId
    ? ((await db.select().from(deployments).where(eq(deployments.id, link.currentDeploymentId)))[0] ?? null)
    : null;

  // Target deploy (promote/rollback).
  let target: DeploymentRow | null = null;
  if (request.action !== "build_from_ref") {
    if (!request.targetDeploymentId) problems.push("Choose the deploy to release.");
    else {
      target = (await db.select().from(deployments).where(eq(deployments.id, request.targetDeploymentId)))[0] ?? null;
      if (!target || !link || target.hostingLinkId !== link.id) {
        problems.push("That deploy isn't on this website's production host.");
        target = null;
      }
    }
    if (target) {
      if (target.environment !== "production") problems.push("Only production deploys can be released. Previews are never promoted (spec §8.1).");
      if (current && target.id === current.id) problems.push("That deploy is already live.");
      if (request.action === "promote" && target.state !== "ready") {
        problems.push(`Only a built deploy that isn't live yet can be promoted (this one is ${target.state}).`);
      }
      if (request.action === "rollback" && target.state !== "superseded") {
        problems.push(`Only a deploy that was live before can be rolled back to (this one is ${target.state}).`);
      }
      if (!target.commitSha) problems.push("The provider didn't report which commit that deploy was built from.");
      if (target.projectId && target.projectId !== projectId && request.action === "promote") {
        problems.push("That deploy is attributed to another project.");
      }
    }
  }

  // Repository: the hosting link's own, else the website's primary one.
  const [repoRow] = await db
    .select({ repo: repositoryLinks, integration: integrations })
    .from(repositoryLinks)
    .innerJoin(integrations, eq(integrations.id, repositoryLinks.integrationId))
    .where(
      and(
        eq(repositoryLinks.websiteId, website.id),
        isNull(repositoryLinks.archivedAt),
        link?.repositoryLinkId ? eq(repositoryLinks.id, link.repositoryLinkId) : eq(repositoryLinks.isPrimary, true),
      ),
    );
  const repo = repoRow?.repo ?? null;

  let targetCommitSha: string | null = target?.commitSha ?? null;
  let productionBranch: string | null = null;
  if (request.action === "build_from_ref") {
    if (!repo) problems.push("Link the website's GitHub repository: SiteSync checks the production branch before building it.");
    else {
      productionBranch = repo.productionBranch;
      targetCommitSha = repo.syncCursor?.headSha ?? null;
      if (!targetCommitSha) problems.push(`SiteSync doesn't know the head of ${repo.productionBranch} yet. Refresh first.`);
      if (repoRow!.integration.archivedAt || ["disabled", "unconfigured", "error"].includes(repoRow!.integration.health)) {
        problems.push(`The ${repoRow!.integration.name} GitHub integration is ${repoRow!.integration.archivedAt ? "archived" : repoRow!.integration.health}.`);
      }
    }
  }

  // Freshness: the host always; the repository whenever it decides the target commit.
  const freshFor = (at: Date | null) => Boolean(at && now.getTime() - at.getTime() <= FRESHNESS_MS);
  let stale = false;
  if (link && integration && !freshFor(link.lastSyncedAt)) stale = true;
  if (request.action === "build_from_ref" && repo && !freshFor(repo.lastSyncedAt)) stale = true;
  if (stale) problems.push("The data is more than 5 minutes old. Refresh from the provider first.");

  // In-flight work on this target.
  const [awaiting] = link
    ? await db
        .select({ id: productionApprovals.id })
        .from(productionApprovals)
        .where(and(eq(productionApprovals.hostingLinkId, link.id), eq(productionApprovals.status, "awaiting_confirmation")))
    : [];
  if (awaiting) problems.push("Another approval for this host is waiting for confirmation. Confirm or revoke it first.");
  const [inFlight] = link
    ? await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.hostingLinkId, link.id),
            eq(deployments.origin, "sitesync_initiated"),
            inArray(deployments.dispatchState, ["pending", "dispatched", "confirming"]),
          ),
        )
    : [];
  if (inFlight) problems.push("A release on this host is still being confirmed.");

  // GitHub context for the target commit.
  const checks = repo && targetCommitSha ? await latestChecksForCommit(db, repo.id, targetCommitSha) : [];
  const pulls = repo
    ? await db
        .select()
        .from(repositoryEvents)
        .where(
          and(
            eq(repositoryEvents.repositoryLinkId, repo.id),
            eq(repositoryEvents.eventType, "pull_request"),
            eq(repositoryEvents.state, "open"),
            eq(repositoryEvents.ref, repo.productionBranch),
          ),
        )
        .orderBy(desc(repositoryEvents.providerUpdatedAt))
        .limit(20)
    : [];
  const repoUrl = repo ? `https://github.com/${repo.owner}/${repo.repo}` : null;
  const compareUrl =
    repoUrl && current?.commitSha && targetCommitSha && current.commitSha !== targetCommitSha
      ? `${repoUrl}/compare/${current.commitSha}...${targetCommitSha}`
      : null;

  const readiness = await computeReadiness(db, projectId, {
    commitSha: targetCommitSha,
    deploymentId: request.action === "promote" ? (target?.id ?? null) : null,
  });

  const checkViews = checks.map((c) => ({
    name: c.title ?? c.providerEventId,
    state: c.state ?? "unknown",
    conclusion: c.conclusion ?? null,
    htmlUrl: c.htmlUrl ?? null,
  }));
  const pullViews = pulls.map((p) => ({ number: p.providerEventId, title: p.title, htmlUrl: p.htmlUrl }));

  // The hashed snapshot: everything on screen that decides the release, without
  // times that change on every sync (freshness is checked separately).
  const snapshot: Record<string, unknown> = {
    action: request.action,
    project: { id: project.id, name: project.name, code: project.code, stage: currentStage(stages).name },
    client: { id: client.id, name: client.name },
    website: { id: website.id, name: website.name },
    host: link
      ? {
          id: link.id,
          provider: link.provider,
          providerProjectId: link.providerProjectId,
          domain: link.domain,
          autoPublish: link.autoPublish,
          integrationId: link.integrationId,
        }
      : null,
    current: current ? { id: current.id, providerDeploymentId: current.providerDeploymentId, commitSha: current.commitSha } : null,
    target: target
      ? { id: target.id, providerDeploymentId: target.providerDeploymentId, commitSha: target.commitSha, state: target.state, url: target.deployUrl }
      : null,
    targetCommitSha,
    productionBranch,
    checks: checkViews.map(({ name, state, conclusion }) => ({ name, state, conclusion })),
    openPullRequests: pullViews.map((p) => p.number),
    blockers: readiness.blockers.map((b) => b.key),
    waived: readiness.waived.map((w) => ({ blocker: w.blocker.key, waiver: w.waiver.id })),
    problems: problems.filter((p) => !p.startsWith("The data is more than")),
  };
  const hash = hashSnapshot(snapshot).toString("hex");

  return {
    request,
    project: {
      id: project.id,
      name: project.name,
      code: project.code,
      stageName: currentStage(stages).name,
      clientName: client.name,
      websiteId: website.id,
      websiteName: website.name,
    },
    link: link
      ? {
          id: link.id,
          provider: link.provider,
          providerProjectId: link.providerProjectId,
          providerProjectName: link.providerProjectName,
          domain: link.domain,
          autoPublish: link.autoPublish,
          integrationId: link.integrationId,
          integrationName: integration?.name ?? null,
          integrationHealth: integration?.health ?? null,
          lastSyncedAt: link.lastSyncedAt,
        }
      : null,
    current: view(current),
    target: view(target),
    targetCommitSha,
    productionBranch,
    repository: repo
      ? { id: repo.id, fullName: `${repo.owner}/${repo.repo}`, lastSyncedAt: repo.lastSyncedAt, htmlUrl: repoUrl }
      : null,
    compareUrl,
    checks: checkViews,
    openPullRequests: pullViews,
    readiness,
    problems,
    stale,
    awaitingApprovalId: awaiting?.id ?? null,
    canApprove: problems.length === 0 && readiness.ready && Boolean(targetCommitSha),
    snapshot,
    hash,
  };
}

/** The deploys a project could release now, for the overview's Release section. */
export async function releaseOptions(db: DbOrTx, websiteId: string) {
  const [row] = await db
    .select({ link: hostingLinks, integration: integrations })
    .from(hostingLinks)
    .leftJoin(integrations, eq(integrations.id, hostingLinks.integrationId))
    .where(and(eq(hostingLinks.websiteId, websiteId), eq(hostingLinks.environment, "production"), isNull(hostingLinks.archivedAt)));
  if (!row?.link || !row.integration || row.link.provider === "other") return null;
  const capabilities = HOSTING_CAPABILITIES[row.link.provider];
  const productionDeploys = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.hostingLinkId, row.link.id), eq(deployments.environment, "production")))
    .orderBy(desc(deployments.providerCreatedAt))
    .limit(25);
  return {
    linkId: row.link.id,
    provider: row.link.provider,
    capabilities,
    promotable: capabilities.promote ? productionDeploys.filter((d) => d.state === "ready" && d.commitSha).slice(0, 5) : [],
    rollbackTargets: capabilities.rollback ? productionDeploys.filter((d) => d.state === "superseded" && d.commitSha).slice(0, 5) : [],
  };
}
