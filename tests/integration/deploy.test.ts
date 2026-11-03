// Phase 4: the production deployment gate (spec §8.6), against mocked providers.
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { auditEvents, deployments, productionApprovals, websites } from "@/server/db/schema";
import {
  approveRelease,
  confirmAndExecute,
  dispatchDeployment,
  executeApproval,
  expireApprovals,
  revokeApproval,
} from "@/server/deploy/approvals";
import { checkRelease, evaluateRelease } from "@/server/deploy/confirm";
import { buildPreflight, type PreflightRequest } from "@/server/deploy/preflight";
import { syncRepositoryLink } from "@/server/integrations/github-sync";
import { archiveHostingLink, createHostingLink, syncHostingLink } from "@/server/integrations/hosting-sync";
import { createRepositoryLink } from "@/server/integrations/repo-links";
import { createIntegration } from "@/server/integrations/service";
import { createGitHubAdapter } from "@/server/providers/github";
import { createCloudflareAdapter, createNetlifyAdapter } from "@/server/providers/hosting";
import type { FetchImpl } from "@/server/providers/fetch";
import type { Actor } from "@/server/records/actor";
import { listChecklist, setChecklistItemChecked } from "@/server/records/checklist";
import { completeTask, createTask } from "@/server/records/tasks";
import { currentStage } from "@/server/stages/machine";
import { loadStages } from "@/server/stages/service";
import { commitJson, fakeGitHub, healthyRepo, sha, type FakeReply } from "../support/fake-github";
import { createAdmin, makeProject } from "../support/factories";
import { appDb, ownerClient, resetTestDatabase } from "../support/test-db";

let db: Db;
let pool: pg.Pool;
let owner: pg.Client;
let actor: Actor;

const PASSWORD = "a long enough test passphrase";
const NETLIFY_VAR = "TEST_NETLIFY_TOKEN";
const CF_VAR = "TEST_CLOUDFLARE_TOKEN";
const GH_VAR = "TEST_GITHUB_TOKEN";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  await resetTestDatabase();
  ({ db, pool } = appDb());
  owner = await ownerClient();
  actor = await createAdmin(db);
  process.env[NETLIFY_VAR] = "netlify-test-token";
  process.env[CF_VAR] = "cf-test-token";
  process.env[GH_VAR] = "gh-test-token";
});

afterAll(async () => {
  for (const name of [NETLIFY_VAR, CF_VAR, GH_VAR]) delete process.env[name];
  await pool?.end();
  await owner?.end();
});

const noSleep = { sleep: async () => undefined, random: () => 0 };

// --- A stateful fake Netlify site "site" -----------------------------------------

type NetlifyDeploy = { id: string; commit: string; context?: string; state?: string; publishedAt?: string | null; updated?: string };

function netlifyWorld(init: { published: string; deploys: NetlifyDeploy[] }) {
  const world = { published: init.published, deploys: init.deploys, restores: [] as string[], restoreReply: null as FakeReply | null };
  const json = (d: NetlifyDeploy) => ({
    id: d.id,
    state: d.state ?? "ready",
    context: d.context ?? "production",
    branch: d.context === "deploy-preview" ? "feature" : "main",
    commit_ref: d.commit,
    deploy_ssl_url: `https://${d.id}--site.netlify.app`,
    created_at: "2026-11-03T10:00:00Z",
    updated_at: d.updated ?? "2026-11-03T10:05:00Z",
    published_at: d.publishedAt ?? null,
  });
  const routes: Record<string, () => FakeReply> = {
    "GET /api/v1/sites/site": () => ({
      body: { id: "site", name: "site", ssl_url: "https://site.netlify.app", published_deploy: { id: world.published, locked: true } },
    }),
    "GET /api/v1/sites/site/deploys": () => ({ body: world.deploys.map(json) }),
  };
  for (const d of init.deploys) {
    routes[`GET /api/v1/sites/site/deploys/${d.id}`] = () => ({ body: json(world.deploys.find((x) => x.id === d.id)!) });
    routes[`POST /api/v1/sites/site/deploys/${d.id}/restore`] = () => {
      world.restores.push(d.id);
      if (world.restoreReply) return world.restoreReply;
      world.published = d.id;
      const deploy = world.deploys.find((x) => x.id === d.id)!;
      deploy.publishedAt = "2026-11-03T11:00:00Z";
      deploy.updated = "2026-11-03T11:00:00Z";
      return { status: 201, body: json(deploy) };
    };
  }
  const fake = fakeGitHub(routes);
  const factory = (token: string, onRateLimit: Parameters<typeof createNetlifyAdapter>[0]["onRateLimit"]) =>
    createNetlifyAdapter({ token, fetchImpl: fake.fetchImpl, onRateLimit, ...noSleep });
  return { world, fake, factory };
}

const done = async (projectId: string) => {
  for (const item of await listChecklist(db, projectId)) await setChecklistItemChecked(db, actor, item.id, true);
};

let n = 0;
/** A project at Ready to Deploy on a Netlify-hosted website: d1 live, d2 built and waiting (auto-publish locked). */
async function netlifyRelease() {
  n++;
  const integrationId = await createIntegration(db, actor, { provider: "netlify", name: `Netlify ${n}`, tokenEnvVar: NETLIFY_VAR });
  const { projectId, websiteId } = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
  await done(projectId);
  const linkId = await createHostingLink(db, actor, websiteId, { integrationId, providerProjectId: "site", environment: "production" });
  // Provider deploy IDs are globally unique, so each test gets its own.
  const ids = { d1: `d1-${n}`, d2: `d2-${n}`, p1: `p1-${n}` };
  const provider = netlifyWorld({
    published: ids.d1,
    deploys: [
      { id: ids.d2, commit: sha(2) },
      { id: ids.d1, commit: sha(1), publishedAt: "2026-11-02T10:00:00Z" },
      { id: ids.p1, commit: sha(3), context: "deploy-preview" },
    ],
  });
  expect(await syncHostingLink(db, linkId, { factory: provider.factory })).toMatchObject({ status: "ok" });
  const rows = await db.select().from(deployments).where(eq(deployments.hostingLinkId, linkId));
  const byId = (id: string) => rows.find((r) => r.providerDeploymentId === id)!;
  return { integrationId, projectId, websiteId, linkId, provider, ids, d1: byId(ids.d1), d2: byId(ids.d2), p1: byId(ids.p1) };
}

async function approve(projectId: string, request: PreflightRequest, reason = "Release approved in test") {
  const preflight = await buildPreflight(db, projectId, request);
  return approveRelease(db, actor, projectId, { ...request, preflightHash: preflight!.hash, reason });
}

const approvalRow = async (id: string) => (await db.select().from(productionApprovals).where(eq(productionApprovals.id, id)))[0]!;
const stageRole = async (projectId: string) => currentStage(await loadStages(db, projectId)).role;

describe("preflight and approve", () => {
  it("shows live vs proposed and computes a stable hash; approving with a stale hash is refused", async () => {
    const { projectId, d1, d2, ids } = await netlifyRelease();
    const request = { action: "promote" as const, targetDeploymentId: d2.id };
    const preflight = (await buildPreflight(db, projectId, request))!;
    expect(preflight).toMatchObject({ canApprove: true, current: { deploymentId: d1.id }, target: { deploymentId: d2.id }, targetCommitSha: sha(2) });
    expect((await buildPreflight(db, projectId, request))!.hash).toBe(preflight.hash);

    await expect(
      approveRelease(db, actor, projectId, { ...request, preflightHash: "0".repeat(64), reason: "Looks good" }),
    ).rejects.toMatchObject({ code: "stale" });

    // Data changing after the page was rendered changes the hash.
    await createTask(db, actor, projectId, { title: "Minor follow-up", priority: "low" });
    const { id } = { id: await approve(projectId, request) };
    expect(await approvalRow(id)).toMatchObject({ status: "awaiting_confirmation", targetCommitSha: sha(2), expectedCurrentProviderDeploymentId: ids.d1 });
    const row = await approvalRow(id);
    expect(row.expiresAt.getTime() - row.approvedAt.getTime()).toBe(30 * 60 * 1000);
  });

  it("refuses to approve with an unwaived blocker, stale data (> 5 min), or a second awaiting approval", async () => {
    const { projectId, linkId, d2 } = await netlifyRelease();
    const request = { action: "promote" as const, targetDeploymentId: d2.id };

    const taskId = await createTask(db, actor, projectId, { title: "Fix the footer", priority: "critical" });
    let preflight = (await buildPreflight(db, projectId, request))!;
    expect(preflight.canApprove).toBe(false);
    await expect(approve(projectId, request)).rejects.toMatchObject({ message: expect.stringMatching(/blocked/) });
    await completeTask(db, actor, taskId);

    await owner.query("UPDATE hosting_links SET last_synced_at = now() - interval '6 minutes' WHERE id = $1", [linkId]);
    preflight = (await buildPreflight(db, projectId, request))!;
    expect(preflight).toMatchObject({ stale: true, canApprove: false });
    await expect(approve(projectId, request)).rejects.toMatchObject({ message: expect.stringMatching(/5 minutes/) });
    await owner.query("UPDATE hosting_links SET last_synced_at = now() WHERE id = $1", [linkId]);

    await approve(projectId, request);
    await expect(approve(projectId, request)).rejects.toMatchObject({ message: expect.stringMatching(/waiting for confirmation/) });
  });

  it("preview deploys are never released: they need no approval and can't be promoted", async () => {
    const { projectId, p1 } = await netlifyRelease();
    expect(p1).toMatchObject({ environment: "preview", state: "ready", origin: "provider_observed", approvalId: null });
    const preflight = (await buildPreflight(db, projectId, { action: "promote", targetDeploymentId: p1.id }))!;
    expect(preflight.canApprove).toBe(false);
    expect(preflight.problems.join()).toMatch(/Previews are never promoted/);
  });

  it("a manual host or a project before Ready to Deploy can't be released", async () => {
    const { projectId, websiteId } = await makeProject(db, actor);
    await createHostingLink(db, actor, websiteId, { provider: "other", environment: "production" });
    const preflight = (await buildPreflight(db, projectId, { action: "build_from_ref" }))!;
    expect(preflight.canApprove).toBe(false);
    expect(preflight.problems.join()).toMatch(/manual record/);
    expect(preflight.problems.join()).toMatch(/Move it to/);
  });
});

describe("executor (spec §8.4, §8.6)", () => {
  it("no approval → refused", async () => {
    await expect(executeApproval(db, actor, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
  });

  it("a promote dispatches once, the provider confirms, and the project goes Live", async () => {
    const { projectId, websiteId, linkId, provider, d2, ids } = await netlifyRelease();
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    const queued: string[] = [];
    const result = await confirmAndExecute(db, actor, approvalId, PASSWORD, {}, {
      hostingFactory: provider.factory,
      enqueueConfirm: async (id) => queued.push(id),
    });
    expect(result).toMatchObject({ status: "dispatched" });
    const deploymentId = (result as { deploymentId: string }).deploymentId;
    expect(queued).toEqual([deploymentId]);
    expect(provider.world.restores).toEqual([ids.d2]);
    expect(await approvalRow(approvalId)).toMatchObject({ status: "consumed" });
    const [pending] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
    expect(pending).toMatchObject({ origin: "sitesync_initiated", kind: "promote", dispatchState: "dispatched", targetDeploymentId: d2.id, approvalId });

    expect(await checkRelease(db, deploymentId, { factory: provider.factory })).toBe("confirmed_success");
    const [confirmed] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
    expect(confirmed).toMatchObject({ state: "published", confirmationSource: "provider" });
    expect(await stageRole(projectId)).toBe("live");
    expect((await db.select().from(websites).where(eq(websites.id, websiteId)))[0]!.status).toBe("live");

    // A later sync keeps the release record published while its target is live.
    await syncHostingLink(db, linkId, { factory: provider.factory });
    const [after] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
    expect(after!.state).toBe("published");
  });

  it("consumed replay → refused, with no second dispatch", async () => {
    const { projectId, provider, d2 } = await netlifyRelease();
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    await executeApproval(db, actor, approvalId, { hostingFactory: provider.factory });
    const replay = await executeApproval(db, actor, approvalId, { hostingFactory: provider.factory });
    expect(replay).toMatchObject({ status: "refused", reason: expect.stringMatching(/consumed/) });
    expect(provider.world.restores).toHaveLength(1);
  });

  it("concurrent double-submit → exactly one dispatch", async () => {
    const { projectId, provider, d2 } = await netlifyRelease();
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    const results = await Promise.all([
      executeApproval(db, actor, approvalId, { hostingFactory: provider.factory }),
      executeApproval(db, actor, approvalId, { hostingFactory: provider.factory }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["dispatched", "refused"]);
    expect(provider.fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(await db.$count(deployments, eq(deployments.approvalId, approvalId))).toBe(1);
  });

  it("wrong password → no dispatch, approval unchanged, attempt audited", async () => {
    const { projectId, provider, d2 } = await netlifyRelease();
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    const before = provider.fake.calls.length;
    const result = await confirmAndExecute(db, actor, approvalId, "not the password", {}, { hostingFactory: provider.factory });
    expect(result).toEqual({ status: "wrong_password" });
    expect(provider.fake.calls).toHaveLength(before);
    expect(await approvalRow(approvalId)).toMatchObject({ status: "awaiting_confirmation", consumedAt: null });
    const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "auth.reauth_failed"), eq(auditEvents.subjectId, approvalId)));
    expect(audits).toHaveLength(1);
    await revokeApproval(db, actor, approvalId);
    // Clear the failure so later tests aren't throttled.
    await owner.query("DELETE FROM login_attempts");
  });

  it("expired → refused and marked expired", async () => {
    const { projectId, provider, d2 } = await netlifyRelease();
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    await owner.query("ALTER TABLE production_approvals DISABLE TRIGGER production_approvals_guard");
    await owner.query(
      "UPDATE production_approvals SET approved_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute' WHERE id = $1",
      [approvalId],
    );
    await owner.query("ALTER TABLE production_approvals ENABLE TRIGGER production_approvals_guard");
    const before = provider.fake.calls.length;
    const result = await executeApproval(db, actor, approvalId, { hostingFactory: provider.factory });
    expect(result).toMatchObject({ status: "refused", reason: expect.stringMatching(/expired/) });
    expect(await approvalRow(approvalId)).toMatchObject({ status: "expired" });
    expect(provider.fake.calls).toHaveLength(before);
  });

  it("the sweeper expires lapsed approvals", async () => {
    const { projectId, d2 } = await netlifyRelease();
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    expect(await expireApprovals(db, new Date(Date.now() + 31 * 60 * 1000))).toBeGreaterThanOrEqual(1);
    expect(await approvalRow(approvalId)).toMatchObject({ status: "expired" });
  });

  it("live changed since approval → refused", async () => {
    const { projectId, provider, d2, ids } = await netlifyRelease();
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    provider.world.published = ids.p1; // something else went live on the provider
    const result = await executeApproval(db, actor, approvalId, { hostingFactory: provider.factory });
    expect(result).toMatchObject({ status: "refused", reason: expect.stringMatching(/live site changed/) });
    expect(await approvalRow(approvalId)).toMatchObject({ status: "refused", refusalReason: expect.stringMatching(/live site changed/) });
    expect(provider.world.restores).toHaveLength(0);
  });

  it("target mismatch → refused: the deploy's commit changed, or the host was unlinked", async () => {
    const first = await netlifyRelease();
    const a1 = await approve(first.projectId, { action: "promote", targetDeploymentId: first.d2.id });
    first.provider.world.deploys.find((d) => d.id === first.ids.d2)!.commit = sha(99);
    expect(await executeApproval(db, actor, a1, { hostingFactory: first.provider.factory })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/commit doesn't match/),
    });

    const second = await netlifyRelease();
    const a2 = await approve(second.projectId, { action: "promote", targetDeploymentId: second.d2.id });
    await archiveHostingLink(db, actor, second.linkId);
    expect(await executeApproval(db, actor, a2, { hostingFactory: second.provider.factory })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/unlinked/),
    });
    expect(second.provider.world.restores).toHaveLength(0);
  });

  it("unwaived blocker at execution → refused", async () => {
    const { projectId, provider, d2 } = await netlifyRelease();
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    await createTask(db, actor, projectId, { title: "Broken checkout", priority: "critical" });
    const result = await executeApproval(db, actor, approvalId, { hostingFactory: provider.factory });
    expect(result).toMatchObject({ status: "refused", reason: expect.stringMatching(/Broken checkout/) });
    expect(provider.world.restores).toHaveLength(0);
  });

  it("a provider error at dispatch is recorded as dispatch_failed and never retried; the project stays at Ready to Deploy", async () => {
    const { projectId, provider, d2 } = await netlifyRelease();
    provider.world.restoreReply = { status: 500, body: { message: "upstream exploded" } };
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    const result = await executeApproval(db, actor, approvalId, { hostingFactory: provider.factory });
    expect(result).toMatchObject({ status: "dispatch_failed", reason: expect.stringMatching(/500/) });
    expect(provider.world.restores).toHaveLength(1);
    const deploymentId = (result as { deploymentId: string }).deploymentId;
    const [row] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
    expect(row).toMatchObject({ dispatchState: "dispatch_failed", state: "failed" });
    expect(await dispatchDeployment(db, actor, deploymentId, { hostingFactory: provider.factory })).toMatchObject({ ok: false });
    expect(provider.world.restores).toHaveLength(1);
    expect(await stageRole(projectId)).toBe("ready_to_deploy");
  });

  it("a late confirmation after the timeout is still applied and audited", async () => {
    const { projectId, provider, d2, ids } = await netlifyRelease();
    provider.world.restoreReply = { status: 201, body: {} }; // accepted, but not live yet
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    const { deploymentId } = (await executeApproval(db, actor, approvalId, { hostingFactory: provider.factory })) as { deploymentId: string };
    expect(await checkRelease(db, deploymentId, { factory: provider.factory })).toBe("confirming");
    expect(await evaluateRelease(db, deploymentId, new Date(Date.now() + 21 * 60 * 1000))).toBe("timed_out");
    expect(await stageRole(projectId)).toBe("ready_to_deploy");

    provider.world.published = ids.d2;
    provider.world.deploys.find((d) => d.id === ids.d2)!.updated = "2026-11-03T12:00:00Z";
    expect(await checkRelease(db, deploymentId, { factory: provider.factory })).toBe("confirmed_success");
    expect(await stageRole(projectId)).toBe("live");
    const [audit] = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "deployment.confirmed_success"), eq(auditEvents.subjectId, deploymentId)));
    expect(audit!.metadata).toMatchObject({ late: true });
  });

  it("approvals are terminal once decided, and what was approved can't change (trigger)", async () => {
    const { projectId, d2 } = await netlifyRelease();
    const approvalId = await approve(projectId, { action: "promote", targetDeploymentId: d2.id });
    await expect(owner.query("UPDATE production_approvals SET target_commit_sha = $1 WHERE id = $2", [sha(7), approvalId])).rejects.toThrow(
      /cannot change/,
    );
    await revokeApproval(db, actor, approvalId);
    await expect(
      owner.query("UPDATE production_approvals SET status = 'awaiting_confirmation', revoked_at = NULL WHERE id = $1", [approvalId]),
    ).rejects.toThrow(/terminal/);
    // Approvals are history: the app role can't delete them.
    const denied = await db
      .delete(productionApprovals)
      .where(eq(productionApprovals.id, approvalId))
      .then(() => null, (error: { cause?: { message?: string } }) => error.cause?.message ?? String(error));
    expect(denied).toMatch(/permission denied/);
  });
});

// --- Cloudflare Pages: build the production branch, and roll back ---------------

type CfDeploy = { id: string; environment: "production" | "preview"; stage: [string, string]; commit: string; modified?: string };

function cloudflareWorld(init: { canonical: string; deploys: CfDeploy[]; branchHead: string; tag: string }) {
  const world = { ...init, builds: 0, rollbacks: [] as string[] };
  const base = `/client/v4/accounts/${ACCOUNT}/pages/projects/site`;
  const json = (d: CfDeploy) => ({
    id: d.id,
    environment: d.environment,
    url: `https://${d.id}.site.pages.dev`,
    created_on: "2026-11-03T10:00:00Z",
    modified_on: d.modified ?? "2026-11-03T10:05:00Z",
    latest_stage: { name: d.stage[0], status: d.stage[1] },
    deployment_trigger: { type: "ad_hoc", metadata: { branch: "main", commit_hash: d.commit } },
  });
  const routes: Record<string, (url: URL, init: RequestInit) => FakeReply> = {
    [`GET ${base}`]: () => ({
      body: {
        success: true,
        result: { id: "p1", name: "site", subdomain: "site.pages.dev", canonical_deployment: { id: world.canonical }, source: { type: "github", config: { production_deployments_enabled: false } } },
      },
    }),
    [`GET ${base}/deployments`]: () => ({ body: { success: true, result: world.deploys.map(json), result_info: { page: 1, total_pages: 1 } } }),
    [`POST ${base}/deployments`]: (_url, request) => {
      world.builds++;
      const form = request.body as FormData;
      const id = `build-${world.builds}-${world.tag}`;
      const deploy: CfDeploy = { id, environment: "production", stage: ["build", "active"], commit: world.branchHead, modified: "2026-11-03T11:00:00Z" };
      expect(form.get("branch")).toBe("main");
      world.deploys.unshift(deploy);
      return { body: { success: true, result: json(deploy) } };
    },
  };
  for (const d of init.deploys) {
    routes[`GET ${base}/deployments/${d.id}`] = () => ({ body: { success: true, result: json(world.deploys.find((x) => x.id === d.id)!) } });
    routes[`POST ${base}/deployments/${d.id}/rollback`] = () => {
      world.rollbacks.push(d.id);
      world.canonical = d.id;
      return { body: { success: true, result: json(world.deploys.find((x) => x.id === d.id)!) } };
    };
  }
  const fake = fakeGitHub(routes);
  const factory = (token: string, onRateLimit: Parameters<typeof createCloudflareAdapter>[0]["onRateLimit"]) =>
    createCloudflareAdapter({ token, accountRef: ACCOUNT, fetchImpl: fake.fetchImpl, onRateLimit, ...noSleep });
  return { world, fake, factory };
}

function githubFactory(fetchImpl: FetchImpl) {
  return (token: string, onRateLimit: Parameters<typeof createGitHubAdapter>[0]["onRateLimit"]) =>
    createGitHubAdapter({ token, fetchImpl, onRateLimit, ...noSleep });
}

async function cloudflareRelease() {
  n++;
  const cf = await createIntegration(db, actor, { provider: "cloudflare", name: `Cloudflare ${n}`, tokenEnvVar: CF_VAR, accountRef: ACCOUNT });
  const gh = await createIntegration(db, actor, { provider: "github", name: `GitHub ${n}`, tokenEnvVar: GH_VAR });
  const { projectId, websiteId } = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
  await done(projectId);
  const repoLinkId = await createRepositoryLink(db, actor, websiteId, { integrationId: gh, owner: "acme", repo: "site", productionBranch: "main", isPrimary: "on" });
  const linkId = await createHostingLink(db, actor, websiteId, { integrationId: cf, providerProjectId: "site", environment: "production", repositoryLinkId: repoLinkId });
  const tag = String(n);
  const provider = cloudflareWorld({
    tag,
    canonical: `c1-${tag}`,
    branchHead: sha(20),
    deploys: [
      { id: `c1-${tag}`, environment: "production", stage: ["deploy", "success"], commit: sha(10) },
      { id: `c0-${tag}`, environment: "production", stage: ["deploy", "success"], commit: sha(9), modified: "2026-11-01T10:00:00Z" },
    ],
  });
  let head = sha(20);
  const github = fakeGitHub({
    ...healthyRepo({ head: sha(20), commits: [commitJson(20)] }),
    "GET /repos/acme/site/branches/main": () => ({ body: { name: "main", commit: { sha: head } } }),
  });
  await syncRepositoryLink(db, repoLinkId, { factory: githubFactory(github.fetchImpl) });
  await syncHostingLink(db, linkId, { factory: provider.factory });
  const rows = await db.select().from(deployments).where(eq(deployments.hostingLinkId, linkId));
  return {
    projectId,
    linkId,
    provider,
    github,
    moveHead: (to: string) => {
      head = to;
    },
    deps: { hostingFactory: provider.factory, githubFactory: githubFactory(github.fetchImpl) },
    tag,
    c0: rows.find((r) => r.providerDeploymentId === `c0-${tag}`)!,
  };
}

describe("Cloudflare Pages releases (decision 0011)", () => {
  it("builds the production branch head, confirms the built commit, and goes Live", async () => {
    const { projectId, provider, deps, tag } = await cloudflareRelease();
    const preflight = (await buildPreflight(db, projectId, { action: "build_from_ref" }))!;
    expect(preflight).toMatchObject({ canApprove: true, targetCommitSha: sha(20), productionBranch: "main" });
    expect(preflight.compareUrl).toBe(`https://github.com/acme/site/compare/${sha(10)}...${sha(20)}`);

    const approvalId = await approve(projectId, { action: "build_from_ref" });
    const result = (await executeApproval(db, actor, approvalId, deps)) as { status: string; deploymentId: string };
    expect(result.status).toBe("dispatched");
    expect(provider.world.builds).toBe(1);
    const [row] = await db.select().from(deployments).where(eq(deployments.id, result.deploymentId));
    expect(row).toMatchObject({ providerDeploymentId: `build-1-${tag}`, kind: "deploy", dispatchState: "dispatched" });

    expect(await checkRelease(db, result.deploymentId, { factory: provider.factory })).toBe("confirming");
    provider.world.deploys[0]!.stage = ["deploy", "success"];
    provider.world.deploys[0]!.modified = "2026-11-03T11:05:00Z";
    provider.world.canonical = `build-1-${tag}`;
    expect(await checkRelease(db, result.deploymentId, { factory: provider.factory })).toBe("confirmed_success");
    expect(await stageRole(projectId)).toBe("live");
    // The sync recorded the provider's deploy on SiteSync's own row, not a duplicate.
    expect(await db.$count(deployments, eq(deployments.providerDeploymentId, `build-1-${tag}`))).toBe(1);
  });

  it("ref/SHA mismatch → refused when the branch moved after approval", async () => {
    const { projectId, provider, deps, moveHead } = await cloudflareRelease();
    const approvalId = await approve(projectId, { action: "build_from_ref" });
    moveHead(sha(21));
    const result = await executeApproval(db, actor, approvalId, deps);
    expect(result).toMatchObject({ status: "refused", reason: expect.stringMatching(/has moved/) });
    expect(provider.world.builds).toBe(0);
  });

  it("a build of a different commit than approved (branch moved mid-release) is a failure, not Live", async () => {
    const { projectId, provider, deps, tag } = await cloudflareRelease();
    const approvalId = await approve(projectId, { action: "build_from_ref" });
    provider.world.branchHead = sha(22); // the provider builds whatever HEAD is when it starts
    const { deploymentId } = (await executeApproval(db, actor, approvalId, deps)) as { deploymentId: string };
    provider.world.deploys[0]!.stage = ["deploy", "success"];
    provider.world.deploys[0]!.modified = "2026-11-03T11:05:00Z";
    provider.world.canonical = `build-1-${tag}`;
    expect(await checkRelease(db, deploymentId, { factory: provider.factory })).toBe("confirmed_failure");
    const [row] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
    expect(row!.errorSummary).toMatch(/not the approved/);
    expect(await stageRole(projectId)).toBe("ready_to_deploy");
  });

  it("rollback goes through the same gate and returns production to the earlier deploy", async () => {
    const { projectId, provider, deps, c0, tag } = await cloudflareRelease();
    expect(c0.state).toBe("superseded");
    const approvalId = await approve(projectId, { action: "rollback", targetDeploymentId: c0.id }, "Roll back the broken release");
    const { deploymentId } = (await executeApproval(db, actor, approvalId, deps)) as { deploymentId: string };
    expect(provider.world.rollbacks).toEqual([`c0-${tag}`]);
    expect(await checkRelease(db, deploymentId, { factory: provider.factory })).toBe("confirmed_success");
    const [row] = await db.select().from(deployments).where(eq(deployments.id, deploymentId));
    expect(row).toMatchObject({ kind: "rollback", state: "published" });
    // A rollback confirms the live site; it doesn't move the project to Live.
    expect(await stageRole(projectId)).toBe("ready_to_deploy");
  });
});
