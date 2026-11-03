// Hosting adapters (spec §7.1), read side: Netlify and Vercel. Endpoints, fields
// and state names were checked against each provider's official API reference
// on 2026-11-03 (decision 0010). Every response is Zod-parsed; unknown fields drop.
import { z } from "zod";
import type { AutoPublish, DeploymentState, Environment } from "../db/schema";
import type { FetchImpl } from "./fetch";
import { createHttpClient, hasNextPage, type RateLimit } from "./http";
import type { Page } from "./github";

export type NormalizedDeployment = {
  providerDeploymentId: string;
  environment: Environment;
  state: DeploymentState;
  providerState: string;
  commitSha: string | null;
  branch: string | null;
  deployUrl: string | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  readyAt: Date | null;
  publishedAt: Date | null;
  errorSummary: string | null;
  snapshot: Record<string, unknown>;
};

export type HostingProjectInfo = {
  providerProjectId: string;
  name: string;
  productionDomain: string | null;
  autoPublish: AutoPublish;
  /** The provider's current production deployment, if it says. */
  currentProductionDeploymentId: string | null;
};

export interface HostingAdapter {
  testConnection(): Promise<{ login: string }>;
  getProject(providerProjectId: string): Promise<HostingProjectInfo>;
  /** Most recent deployments first, at most `limit` (one page). */
  listDeployments(providerProjectId: string, options: { limit: number }): Promise<Page<NormalizedDeployment>>;
}

export type HostingAdapterOptions = {
  token: string;
  /** Vercel team ID (the integration's account reference); unused for Netlify. */
  accountRef?: string | null;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRateLimit?: (rateLimit: RateLimit) => void;
};

const SHA = /^[0-9a-f]{40}$/;
const sha = (value: unknown) => (typeof value === "string" && SHA.test(value) ? value : null);
const clip = (value: string | null | undefined, max: number) => (value ? value.slice(0, max) : null);
const https = (value: string | null | undefined) =>
  value && value.startsWith("https://") && value.length <= 2048 ? value : null;
const isoDate = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const msDate = (value: number | null | undefined) => (typeof value === "number" && value > 0 ? new Date(value) : null);
const hostname = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

// --- Netlify ---------------------------------------------------------------------

/**
 * Netlify deploy `state` (swagger enum) → §5.2. `isCurrent`: it is the site's
 * `published_deploy`. A production deploy that was published before but isn't
 * now has been superseded.
 */
export function mapNetlifyState(
  state: string,
  context: { isCurrent: boolean; publishedAt: Date | null; skipped: boolean; production: boolean },
): DeploymentState {
  if (context.isCurrent) return "published";
  if (context.skipped) return "canceled";
  switch (state) {
    case "new":
    case "pending_review":
    case "accepted":
    case "enqueued":
    case "retrying":
      return "queued";
    case "building":
    case "uploading":
    case "uploaded":
    case "preparing":
    case "prepared":
    case "processing":
    case "processed":
      return "building";
    case "ready":
      return context.production && context.publishedAt ? "superseded" : "ready";
    case "error":
      return "failed";
    case "rejected":
      return "canceled";
    default:
      return "unknown";
  }
}

const netlifyDeploySchema = z.object({
  id: z.string(),
  state: z.string(),
  context: z.string().nullish(),
  branch: z.string().nullish(),
  commit_ref: z.string().nullish(),
  commit_url: z.string().nullish(),
  deploy_ssl_url: z.string().nullish(),
  error_message: z.string().nullish(),
  skipped: z.boolean().nullish(),
  locked: z.boolean().nullish(),
  title: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  published_at: z.string().nullish(),
});

const netlifySiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().nullish(),
  ssl_url: z.string().nullish(),
  custom_domain: z.string().nullish(),
  published_deploy: z.object({ id: z.string(), locked: z.boolean().nullish() }).nullish(),
  build_settings: z.object({ stop_builds: z.boolean().nullish() }).nullish(),
});

/**
 * §1.1 for Netlify: "Lock to stop auto publishing" locks the published deploy
 * (new deploys build but aren't published); "stop builds" stops them entirely.
 */
export function netlifyAutoPublish(site: z.output<typeof netlifySiteSchema>): AutoPublish {
  if (site.build_settings?.stop_builds === true) return "disabled";
  if (!site.published_deploy) return "unknown";
  if (site.published_deploy.locked === true) return "locked";
  if (site.published_deploy.locked === false) return "enabled";
  return "unknown";
}

export function normalizeNetlifyDeploy(
  deploy: z.output<typeof netlifyDeploySchema>,
  currentId: string | null,
): NormalizedDeployment {
  const production = deploy.context === "production";
  const publishedAt = isoDate(deploy.published_at);
  return {
    providerDeploymentId: deploy.id,
    environment: production ? "production" : "preview",
    state: mapNetlifyState(deploy.state, {
      isCurrent: deploy.id === currentId,
      publishedAt,
      skipped: deploy.skipped === true,
      production,
    }),
    providerState: deploy.state.slice(0, 50),
    commitSha: sha(deploy.commit_ref),
    branch: clip(deploy.branch, 255),
    deployUrl: https(deploy.deploy_ssl_url),
    providerCreatedAt: isoDate(deploy.created_at),
    providerUpdatedAt: isoDate(deploy.updated_at) ?? isoDate(deploy.created_at),
    readyAt: deploy.state === "ready" ? isoDate(deploy.updated_at) : null,
    publishedAt,
    errorSummary: clip(deploy.error_message, 2000),
    snapshot: {
      id: deploy.id,
      state: deploy.state,
      context: deploy.context ?? null,
      title: clip(deploy.title, 300),
      locked: deploy.locked ?? null,
    },
  };
}

export function createNetlifyAdapter(options: HostingAdapterOptions): HostingAdapter {
  const client = createHttpClient({
    baseUrl: "https://api.netlify.com",
    headers: { Authorization: `Bearer ${options.token}`, "User-Agent": "SiteSync-Control-Centre", Accept: "application/json" },
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    random: options.random,
    now: options.now,
    onRateLimit: options.onRateLimit,
  });
  const sitePath = (id: string) => `/api/v1/sites/${encodeURIComponent(id)}`;
  let currentCache: { siteId: string; currentId: string | null } | null = null;

  return {
    async testConnection() {
      const { data } = await client.getJson(
        "/api/v1/user",
        z.object({ email: z.string().nullish(), full_name: z.string().nullish(), slug: z.string().nullish() }),
      );
      return { login: data.full_name || data.email || data.slug || "Netlify user" };
    },

    async getProject(providerProjectId) {
      const { data } = await client.getJson(sitePath(providerProjectId), netlifySiteSchema);
      const currentId = data.published_deploy?.id ?? null;
      currentCache = { siteId: providerProjectId, currentId };
      return {
        providerProjectId: data.id,
        name: data.name,
        productionDomain: data.custom_domain?.toLowerCase() || hostname(data.ssl_url ?? data.url),
        autoPublish: netlifyAutoPublish(data),
        currentProductionDeploymentId: currentId,
      };
    },

    async listDeployments(providerProjectId, { limit }) {
      const perPage = Math.min(Math.max(limit, 1), 100);
      const { data, response } = await client.getJson(`${sitePath(providerProjectId)}/deploys`, z.array(netlifyDeploySchema), {
        per_page: perPage,
        page: 1,
      });
      const currentId = currentCache?.siteId === providerProjectId ? currentCache.currentId : null;
      return {
        items: data.slice(0, perPage).map((deploy) => normalizeNetlifyDeploy(deploy, currentId)),
        truncated: hasNextPage(response.headers),
      };
    },
  };
}

// --- Vercel ---------------------------------------------------------------------

/**
 * Vercel `readyState` → §5.2. `isCurrent`: it's the project's current production
 * deployment. A READY production deployment that has seen production traffic
 * (`readySubstate` PROMOTED) but isn't current has been superseded; STAGED ones
 * (auto-assign of domains off) are ready, awaiting promotion.
 */
export function mapVercelState(
  readyState: string,
  context: { isCurrent: boolean; production: boolean; readySubstate: string | null },
): DeploymentState {
  if (context.isCurrent) return "published";
  switch (readyState) {
    case "QUEUED":
    case "INITIALIZING":
    case "BLOCKED":
      return "queued";
    case "BUILDING":
      return "building";
    case "READY":
      return context.production && context.readySubstate === "PROMOTED" ? "superseded" : "ready";
    case "ERROR":
      return "failed";
    case "CANCELED":
    case "DELETED":
      return "canceled";
    default:
      return "unknown";
  }
}

const vercelDeploymentSchema = z.object({
  uid: z.string(),
  url: z.string().nullish(),
  created: z.number().nullish(),
  buildingAt: z.number().nullish(),
  ready: z.number().nullish(),
  readyState: z.string(),
  readySubstate: z.string().nullish(),
  target: z.string().nullish(),
  errorMessage: z.string().nullish(),
  inspectorUrl: z.string().nullish(),
  meta: z.record(z.string(), z.unknown()).nullish(),
});

const vercelProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  autoAssignCustomDomains: z.boolean().nullish(),
  // Not in Vercel's published schema (`targets` is untyped there), but it's how the
  // dashboard's "Current" production deployment is exposed; used when present.
  targets: z.object({ production: z.object({ id: z.string() }).nullish() }).nullish(),
  link: z.object({ productionBranch: z.string().nullish() }).nullish(),
});

/** §1.1 for Vercel: with "Auto-assign Custom Production Domains" off, production deploys are staged until promoted. */
export function vercelAutoPublish(project: z.output<typeof vercelProjectSchema>): AutoPublish {
  if (project.autoAssignCustomDomains === false) return "locked";
  if (project.autoAssignCustomDomains === true) return "enabled";
  return "unknown";
}

export function normalizeVercelDeployment(
  deployment: z.output<typeof vercelDeploymentSchema>,
  currentId: string | null,
): NormalizedDeployment {
  const production = deployment.target === "production";
  const meta = deployment.meta ?? {};
  const commit = meta.githubCommitSha ?? meta.gitlabCommitSha ?? meta.bitbucketCommitSha;
  const branch = meta.githubCommitRef ?? meta.gitlabCommitRef ?? meta.bitbucketCommitRef;
  const created = msDate(deployment.created);
  const ready = msDate(deployment.ready);
  const isCurrent = deployment.uid === currentId;
  return {
    providerDeploymentId: deployment.uid,
    environment: production ? "production" : deployment.target === "staging" ? "staging" : "preview",
    state: mapVercelState(deployment.readyState, { isCurrent, production, readySubstate: deployment.readySubstate ?? null }),
    providerState: [deployment.readyState, deployment.readySubstate].filter(Boolean).join("/").slice(0, 50),
    commitSha: sha(commit),
    branch: typeof branch === "string" ? branch.slice(0, 255) : null,
    deployUrl: deployment.url ? https(`https://${deployment.url}`) : null,
    providerCreatedAt: created,
    providerUpdatedAt: [ready, msDate(deployment.buildingAt), created].find(Boolean) ?? null,
    readyAt: ready,
    publishedAt: isCurrent ? ready : null,
    errorSummary: clip(deployment.errorMessage, 2000),
    snapshot: {
      uid: deployment.uid,
      readyState: deployment.readyState,
      readySubstate: deployment.readySubstate ?? null,
      target: deployment.target ?? null,
      inspectorUrl: https(deployment.inspectorUrl),
    },
  };
}

export function createVercelAdapter(options: HostingAdapterOptions): HostingAdapter {
  const client = createHttpClient({
    baseUrl: "https://api.vercel.com",
    headers: { Authorization: `Bearer ${options.token}`, "User-Agent": "SiteSync-Control-Centre", Accept: "application/json" },
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    random: options.random,
    now: options.now,
    onRateLimit: options.onRateLimit,
  });
  const team = options.accountRef ? { teamId: options.accountRef } : {};
  let currentCache: { projectId: string; currentId: string | null } | null = null;

  return {
    async testConnection() {
      const { data } = await client.getJson(
        "/v2/user",
        z.object({ user: z.object({ username: z.string().nullish(), email: z.string().nullish(), name: z.string().nullish() }) }),
      );
      return { login: data.user.username || data.user.name || data.user.email || "Vercel user" };
    },

    async getProject(providerProjectId) {
      const { data } = await client.getJson(`/v9/projects/${encodeURIComponent(providerProjectId)}`, vercelProjectSchema, team);
      const currentId = data.targets?.production?.id ?? null;
      currentCache = { projectId: providerProjectId, currentId };
      return {
        providerProjectId: data.id,
        name: data.name,
        productionDomain: null,
        autoPublish: vercelAutoPublish(data),
        currentProductionDeploymentId: currentId,
      };
    },

    async listDeployments(providerProjectId, { limit }) {
      const max = Math.min(Math.max(limit, 1), 100);
      const { data } = await client.getJson(
        "/v7/deployments",
        z.object({
          deployments: z.array(vercelDeploymentSchema),
          pagination: z.object({ next: z.number().nullish() }).nullish(),
        }),
        { projectId: providerProjectId, limit: max, ...team },
      );
      let currentId = currentCache?.projectId === providerProjectId ? currentCache.currentId : null;
      if (!currentId) {
        // Fallback when `targets.production` is absent: the newest READY production
        // deployment that has been served (not merely staged).
        currentId =
          data.deployments.find((d) => d.target === "production" && d.readyState === "READY" && d.readySubstate !== "STAGED")
            ?.uid ?? null;
      }
      return {
        items: data.deployments.slice(0, max).map((d) => normalizeVercelDeployment(d, currentId)),
        truncated: Boolean(data.pagination?.next),
      };
    },
  };
}

// --- Cloudflare Pages ------------------------------------------------------------

/**
 * Cloudflare Pages `latest_stage` (name × status) → §5.2. `isCurrent`: it's the
 * project's `canonical_deployment`. Earlier successful production deploys have
 * been superseded.
 */
export function mapCloudflareState(
  stage: { name: string; status: string } | null,
  context: { isCurrent: boolean; production: boolean; skipped: boolean },
): DeploymentState {
  if (context.isCurrent) return "published";
  if (context.skipped || stage?.status === "skipped" || stage?.status === "canceled") return "canceled";
  if (!stage) return "unknown";
  if (stage.status === "failure") return "failed";
  if (stage.name === "deploy" && stage.status === "success") return context.production ? "superseded" : "ready";
  if (stage.name === "queued") return "queued";
  if (["initialize", "clone_repo", "build", "deploy"].includes(stage.name)) {
    // A stage that succeeded before "deploy" means the next one hasn't started yet: still building.
    if (stage.status === "idle" || stage.status === "active" || stage.status === "success") return "building";
  }
  return "unknown";
}

const cloudflareStageSchema = z.object({ name: z.string(), status: z.string() });

const cloudflareDeploymentSchema = z.object({
  id: z.string(),
  short_id: z.string().nullish(),
  environment: z.string().nullish(),
  url: z.string().nullish(),
  created_on: z.string().nullish(),
  modified_on: z.string().nullish(),
  is_skipped: z.boolean().nullish(),
  latest_stage: cloudflareStageSchema.nullish(),
  deployment_trigger: z
    .object({
      type: z.string().nullish(),
      metadata: z
        .object({ branch: z.string().nullish(), commit_hash: z.string().nullish(), commit_message: z.string().nullish() })
        .nullish(),
    })
    .nullish(),
});

const cloudflareProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  subdomain: z.string().nullish(),
  domains: z.array(z.string()).nullish(),
  canonical_deployment: z.object({ id: z.string() }).nullish(),
  source: z
    .object({
      type: z.string().nullish(),
      config: z
        .object({ production_deployments_enabled: z.boolean().nullish(), deployments_enabled: z.boolean().nullish() })
        .nullish(),
    })
    .nullish(),
});

/** Cloudflare's v4 envelope: `{ success, errors, result, result_info }`. */
const envelope = <S extends z.ZodType>(result: S) =>
  z.object({
    success: z.boolean(),
    result,
    result_info: z.object({ page: z.number().nullish(), total_pages: z.number().nullish() }).nullish(),
  });

/**
 * §1.1 for Cloudflare Pages: unticking "Enable automatic production branch
 * deployments" (`production_deployments_enabled: false`) means pushes don't
 * build production at all, so production only changes by an explicit deploy.
 * Projects with no Git source (direct upload) never deploy on push either.
 */
export function cloudflareAutoPublish(project: z.output<typeof cloudflareProjectSchema>): AutoPublish {
  const config = project.source?.config;
  if (!project.source) return "disabled";
  if (config?.production_deployments_enabled === false || config?.deployments_enabled === false) return "disabled";
  if (config?.production_deployments_enabled === true) return "enabled";
  return "unknown";
}

export function normalizeCloudflareDeployment(
  deployment: z.output<typeof cloudflareDeploymentSchema>,
  currentId: string | null,
): NormalizedDeployment {
  const production = deployment.environment === "production";
  const meta = deployment.deployment_trigger?.metadata;
  const isCurrent = deployment.id === currentId;
  const stage = deployment.latest_stage ?? null;
  const modified = isoDate(deployment.modified_on);
  return {
    providerDeploymentId: deployment.id,
    environment: production ? "production" : "preview",
    state: mapCloudflareState(stage, { isCurrent, production, skipped: deployment.is_skipped === true }),
    providerState: stage ? `${stage.name}/${stage.status}`.slice(0, 50) : "unknown",
    commitSha: sha(meta?.commit_hash),
    branch: clip(meta?.branch, 255),
    deployUrl: https(deployment.url),
    providerCreatedAt: isoDate(deployment.created_on),
    providerUpdatedAt: modified ?? isoDate(deployment.created_on),
    readyAt: stage?.name === "deploy" && stage.status === "success" ? modified : null,
    publishedAt: isCurrent ? modified : null,
    errorSummary: stage?.status === "failure" ? `Failed at the ${stage.name} stage.` : null,
    snapshot: {
      id: deployment.id,
      shortId: deployment.short_id ?? null,
      stage,
      trigger: deployment.deployment_trigger?.type ?? null,
      commitMessage: clip(meta?.commit_message?.split("\n", 1)[0], 300),
    },
  };
}

export function createCloudflareAdapter(options: HostingAdapterOptions): HostingAdapter {
  const accountId = options.accountRef?.trim();
  const client = createHttpClient({
    baseUrl: "https://api.cloudflare.com",
    headers: { Authorization: `Bearer ${options.token}`, "User-Agent": "SiteSync-Control-Centre", Accept: "application/json" },
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    random: options.random,
    now: options.now,
    onRateLimit: options.onRateLimit,
  });
  const base = () => {
    if (!accountId || !/^[0-9a-f]{32}$/i.test(accountId)) {
      throw new Error("Set the integration's account to your Cloudflare account ID (32 hex characters).");
    }
    return `/client/v4/accounts/${accountId}/pages/projects`;
  };
  const projectPath = (name: string) => `${base()}/${encodeURIComponent(name)}`;
  let currentCache: { project: string; currentId: string | null } | null = null;

  return {
    // Listing projects proves the token, the account ID and the Pages Read permission together.
    async testConnection() {
      await client.getJson(base(), envelope(z.array(z.object({ name: z.string() }))), { per_page: 1 });
      return { login: `account ${accountId!.slice(0, 6)}…` };
    },

    async getProject(name) {
      const { data } = await client.getJson(projectPath(name), envelope(cloudflareProjectSchema));
      const project = data.result;
      const currentId = project.canonical_deployment?.id ?? null;
      currentCache = { project: name, currentId };
      const custom = project.domains?.find((d) => !d.endsWith(".pages.dev")) ?? null;
      return {
        providerProjectId: project.name,
        name: project.name,
        productionDomain: (custom ?? project.subdomain ?? null)?.toLowerCase() ?? null,
        autoPublish: cloudflareAutoPublish(project),
        currentProductionDeploymentId: currentId,
      };
    },

    async listDeployments(name, { limit }) {
      const perPage = Math.min(Math.max(limit, 1), 25);
      const { data } = await client.getJson(`${projectPath(name)}/deployments`, envelope(z.array(cloudflareDeploymentSchema)), {
        per_page: perPage,
        page: 1,
      });
      const currentId = currentCache?.project === name ? currentCache.currentId : null;
      const pages = data.result_info?.total_pages ?? 1;
      return {
        items: data.result.slice(0, perPage).map((d) => normalizeCloudflareDeployment(d, currentId)),
        truncated: pages > 1,
      };
    },
  };
}

export function createHostingAdapter(
  provider: "netlify" | "vercel" | "cloudflare",
  options: HostingAdapterOptions,
): HostingAdapter {
  if (provider === "netlify") return createNetlifyAdapter(options);
  if (provider === "vercel") return createVercelAdapter(options);
  return createCloudflareAdapter(options);
}
