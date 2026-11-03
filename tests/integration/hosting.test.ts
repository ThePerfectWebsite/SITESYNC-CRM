import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { auditEvents, deployments, hostingLinks, stageHistory } from "@/server/db/schema";
import {
  archiveHostingLink,
  createHostingLink,
  deploymentAlerts,
  hostingLinksDueForPoll,
  liveAndLatestPreview,
  syncHostingLink,
  upsertDeployments,
} from "@/server/integrations/hosting-sync";
import { createIntegration, getIntegration } from "@/server/integrations/service";
import { runHostingPollJob } from "@/server/jobs/handlers";
import { createCloudflareAdapter, type NormalizedDeployment } from "@/server/providers/hosting";
import type { Actor } from "@/server/records/actor";
import { listChecklist, setChecklistItemChecked } from "@/server/records/checklist";
import { DomainError } from "@/server/records/errors";
import { computeReadiness, waiveBlocker } from "@/server/records/readiness";
import { databaseDeploymentFacts } from "@/server/stages/deployment-facts";
import { confirmLiveFromProviderDeploy, loadStages, transitionStage } from "@/server/stages/service";
import { fakeGitHub, sha, type FakeReply } from "../support/fake-github";
import { createAdmin, makeClient, makeManualProductionHost, makeProject, makeWebsite } from "../support/factories";
import { appDb, ownerClient, resetTestDatabase } from "../support/test-db";

let db: Db;
let pool: pg.Pool;
let owner: pg.Client;
let actor: Actor;

const TOKEN_VAR = "TEST_CLOUDFLARE_TOKEN";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  await resetTestDatabase();
  ({ db, pool } = appDb());
  owner = await ownerClient();
  actor = await createAdmin(db);
  process.env[TOKEN_VAR] = "cf-test-token-value";
});

afterAll(async () => {
  delete process.env[TOKEN_VAR];
  await pool?.end();
  await owner?.end();
});

type FakeDeploy = { id: string; environment: "production" | "preview"; stage: [string, string]; modified?: string; commit?: string };

/** A fake Cloudflare Pages project `site` with the given deployments and canonical deployment. */
function fakeCloudflare(options: { canonical: string | null; deploys: FakeDeploy[]; autoProduction?: boolean; status?: number }) {
  const project: FakeReply = options.status
    ? { status: options.status, body: { success: false, errors: [{ message: "nope" }] } }
    : {
        body: {
          success: true,
          result: {
            id: "p1",
            name: "site",
            subdomain: "site.pages.dev",
            domains: ["site.pages.dev"],
            canonical_deployment: options.canonical ? { id: options.canonical } : null,
            source: { type: "github", config: { production_deployments_enabled: options.autoProduction ?? true } },
          },
        },
      };
  return fakeGitHub({
    [`GET /client/v4/accounts/${ACCOUNT}/pages/projects/site`]: project,
    [`GET /client/v4/accounts/${ACCOUNT}/pages/projects/site/deployments`]: {
      body: {
        success: true,
        result: options.deploys.map((d) => ({
          id: d.id,
          environment: d.environment,
          url: `https://${d.id}.site.pages.dev`,
          created_on: "2026-11-03T10:00:00Z",
          modified_on: d.modified ?? "2026-11-03T10:05:00Z",
          latest_stage: { name: d.stage[0], status: d.stage[1] },
          deployment_trigger: { type: "github:push", metadata: { branch: d.environment === "production" ? "main" : "feature", commit_hash: d.commit ?? sha(1) } },
        })),
        result_info: { page: 1, total_pages: 1 },
      },
    },
  });
}

const factoryFor = (fetchImpl: Parameters<typeof createCloudflareAdapter>[0]["fetchImpl"]) => (token: string, onRateLimit: Parameters<typeof createCloudflareAdapter>[0]["onRateLimit"]) =>
  createCloudflareAdapter({ token, accountRef: ACCOUNT, fetchImpl, onRateLimit, sleep: async () => undefined, random: () => 0 });

let n = 0;
async function setup() {
  n++;
  const integrationId = await createIntegration(db, actor, {
    provider: "cloudflare",
    name: `Cloudflare ${n}`,
    tokenEnvVar: TOKEN_VAR,
    accountRef: ACCOUNT,
    pollEnabled: "on",
  });
  const { projectId, websiteId, clientId } = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
  const linkId = await createHostingLink(db, actor, websiteId, { integrationId, providerProjectId: "site", environment: "production" });
  return { integrationId, projectId, websiteId, clientId, linkId };
}

const linkDeployments = (linkId: string) => db.select().from(deployments).where(eq(deployments.hostingLinkId, linkId));
const stateOf = async (linkId: string) =>
  Object.fromEntries((await linkDeployments(linkId)).map((d) => [d.providerDeploymentId, d.state]));

describe("hosting links", () => {
  it("one production host per website, an integration needs a project ID, and GitHub isn't a host", async () => {
    const websiteId = await makeWebsite(db, actor, await makeClient(db, actor));
    const github = await createIntegration(db, actor, { provider: "github", name: "GH host?", tokenEnvVar: "SOME_TOKEN" });
    await expect(createHostingLink(db, actor, websiteId, { integrationId: github, providerProjectId: "x" })).rejects.toMatchObject({
      fieldErrors: { integrationId: expect.any(String) },
    });
    const cf = await createIntegration(db, actor, { provider: "cloudflare", name: "CF links", tokenEnvVar: TOKEN_VAR, accountRef: ACCOUNT });
    await expect(createHostingLink(db, actor, websiteId, { integrationId: cf })).rejects.toMatchObject({
      fieldErrors: { providerProjectId: expect.any(String) },
    });
    const first = await createHostingLink(db, actor, websiteId, { integrationId: cf, providerProjectId: "site-a" });
    await expect(makeManualProductionHost(db, actor, websiteId)).rejects.toMatchObject({
      fieldErrors: { environment: expect.stringMatching(/already has a production host/) },
    });
    await createHostingLink(db, actor, websiteId, { integrationId: cf, providerProjectId: "site-a", environment: "preview" });
    await archiveHostingLink(db, actor, first);
    await makeManualProductionHost(db, actor, websiteId);
  });

  it("accepts blank optional fields as a form submits them (hidden Host field, blank environment)", async () => {
    const websiteId = await makeWebsite(db, actor, await makeClient(db, actor));
    const cf = await createIntegration(db, actor, { provider: "cloudflare", name: "CF form", tokenEnvVar: TOKEN_VAR, accountRef: ACCOUNT });
    const id = await createHostingLink(db, actor, websiteId, {
      integrationId: cf,
      provider: "",
      providerProjectId: "form-site",
      environment: "",
      domain: "",
    });
    const [row] = await db.select().from(hostingLinks).where(eq(hostingLinks.id, id));
    expect(row).toMatchObject({ provider: "cloudflare", environment: "production", domain: null });
  });

  it("the database keeps a deployment on its link's website and a link's current deploy on that link", async () => {
    const a = await setup();
    const b = await setup();
    await syncHostingLink(db, a.linkId, { factory: factoryFor(fakeCloudflare({ canonical: "a1", deploys: [{ id: "a1", environment: "production", stage: ["deploy", "success"] }] }).fetchImpl) });
    const [deployment] = await linkDeployments(a.linkId);
    await expect(pool.query("UPDATE deployments SET website_id = $1 WHERE id = $2", [b.websiteId, deployment!.id])).rejects.toMatchObject({
      code: "23503",
      constraint: "deployments_link_same_website_fk",
    });
    await expect(pool.query("UPDATE hosting_links SET current_deployment_id = $1 WHERE id = $2", [deployment!.id, b.linkId])).rejects.toMatchObject({
      code: "23503",
      constraint: "hosting_links_current_deployment_fk",
    });
    await expect(pool.query("DELETE FROM deployments")).rejects.toThrow(/permission denied/);
  });
});

describe("hosting sync", () => {
  it("stores deployments, marks the canonical one published and records auto-publish and the domain", async () => {
    const { linkId, integrationId } = await setup();
    const fake = fakeCloudflare({
      canonical: "p2",
      autoProduction: false,
      deploys: [
        { id: "p2", environment: "production", stage: ["deploy", "success"] },
        { id: "p1", environment: "production", stage: ["deploy", "success"] },
        { id: "v1", environment: "preview", stage: ["build", "active"] },
        { id: "x1", environment: "production", stage: ["build", "failure"] },
      ],
    });
    const result = await syncHostingLink(db, linkId, { factory: factoryFor(fake.fetchImpl) });
    expect(result).toMatchObject({ status: "ok", deployments: 4, autoPublish: "disabled" });
    expect(await stateOf(linkId)).toEqual({ p2: "published", p1: "superseded", v1: "building", x1: "failed" });
    const [link] = await db.select().from(hostingLinks).where(eq(hostingLinks.id, linkId));
    const current = (await linkDeployments(linkId)).find((d) => d.providerDeploymentId === "p2")!;
    expect(link).toMatchObject({ autoPublish: "disabled", currentDeploymentId: current.id, domain: "site.pages.dev", providerProjectName: "site" });
    expect(current).toMatchObject({ origin: "provider_observed", confirmationSource: "provider", publishedAt: expect.any(Date), lastConfirmedAt: expect.any(Date) });
    expect(await getIntegration(db, integrationId)).toMatchObject({ health: "ok" });
  });

  it("supersedes the old live deploy when another becomes current", async () => {
    const { linkId } = await setup();
    const deploys: FakeDeploy[] = [
      { id: "old", environment: "production", stage: ["deploy", "success"] },
      { id: "new", environment: "production", stage: ["deploy", "success"], modified: "2026-11-03T11:00:00Z" },
    ];
    await syncHostingLink(db, linkId, { factory: factoryFor(fakeCloudflare({ canonical: "old", deploys }).fetchImpl) });
    expect(await stateOf(linkId)).toMatchObject({ old: "published" });
    await syncHostingLink(db, linkId, { factory: factoryFor(fakeCloudflare({ canonical: "new", deploys }).fetchImpl) });
    const states = await stateOf(linkId);
    expect(states).toEqual({ old: "superseded", new: "published" });
    expect((await db.select().from(deployments).where(and(eq(deployments.hostingLinkId, linkId), eq(deployments.state, "published"))))).toHaveLength(1);
  });

  it("an older provider view never overwrites a newer one (out-of-order updates)", async () => {
    const { linkId, websiteId } = await setup();
    const link = { id: linkId, websiteId, provider: "cloudflare" as const };
    const at = (iso: string, state: NormalizedDeployment["state"]): NormalizedDeployment => ({
      providerDeploymentId: "ooo",
      environment: "preview",
      state,
      providerState: state,
      commitSha: null,
      branch: null,
      deployUrl: null,
      providerCreatedAt: new Date("2026-11-03T09:00:00Z"),
      providerUpdatedAt: new Date(iso),
      readyAt: null,
      publishedAt: null,
      errorSummary: null,
      snapshot: {},
    });
    await upsertDeployments(db, link, [at("2026-11-03T10:10:00Z", "ready")], new Date());
    await upsertDeployments(db, link, [at("2026-11-03T10:01:00Z", "building")], new Date());
    expect((await stateOf(linkId)).ooo).toBe("ready");
    await upsertDeployments(db, link, [at("2026-11-03T10:20:00Z", "failed")], new Date());
    expect((await stateOf(linkId)).ooo).toBe("failed");
  });

  it("a project the token can't see says so, and degrades health; manual records are never synced", async () => {
    const { linkId, integrationId, websiteId } = await setup();
    const result = await syncHostingLink(db, linkId, { factory: factoryFor(fakeCloudflare({ canonical: null, deploys: [], status: 404 }).fetchImpl) });
    expect(result.status).toBe("failed");
    expect(await getIntegration(db, integrationId)).toMatchObject({ health: "degraded", healthDetail: expect.stringMatching(/can't see project site/) });
    const otherWebsite = await makeWebsite(db, actor, await makeClient(db, actor));
    const manual = await makeManualProductionHost(db, actor, otherWebsite);
    expect(await syncHostingLink(db, manual)).toEqual({ status: "skipped", reason: "manual record" });
    expect(websiteId).toBeTruthy();
  });

  it("the poll enqueues due integration-backed links only", async () => {
    const { linkId } = await setup();
    const queued: string[] = [];
    await runHostingPollJob(db, async (job) => void queued.push(job.linkId));
    expect(queued).toContain(linkId);
    await syncHostingLink(db, linkId, { factory: factoryFor(fakeCloudflare({ canonical: null, deploys: [] }).fetchImpl) });
    expect(await hostingLinksDueForPoll(db, 10)).not.toContain(linkId);
  });

  it("live vs latest preview, and dashboard alerts for failed or in-flight production deploys", async () => {
    const { linkId, websiteId } = await setup();
    await syncHostingLink(db, linkId, {
      factory: factoryFor(
        fakeCloudflare({
          canonical: "live1",
          deploys: [
            { id: "live1", environment: "production", stage: ["deploy", "success"] },
            { id: "prev1", environment: "preview", stage: ["deploy", "success"] },
            { id: "boom", environment: "production", stage: ["build", "failure"] },
          ],
        }).fetchImpl,
      ),
    });
    const { live, preview } = await liveAndLatestPreview(db, websiteId);
    expect(live?.providerDeploymentId).toBe("live1");
    expect(preview?.providerDeploymentId).toBe("prev1");
    const alerts = await deploymentAlerts(db, new Date("2026-11-05T00:00:00Z"));
    expect(alerts.map((a) => a.providerDeploymentId)).toContain("boom");
  });
});

describe("deployment facts now come from the database (decision 0007)", () => {
  it("skipping over Live is refused once the website has an integration-backed production host", async () => {
    const { projectId, websiteId } = await setup();
    const stages = Object.fromEntries((await loadStages(db, projectId)).map((s) => [s.key, s]));
    expect(await databaseDeploymentFacts.hasIntegrationBackedProductionLink(db, websiteId)).toBe(true);
    await expect(
      transitionStage(db, actor, {
        projectId,
        expectedCurrentStageId: stages.ready_to_deploy!.id,
        request: { kind: "skip_forward", targetId: stages.maintenance!.id, reason: "Deployed by hand" },
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/connected production host/) });
  });

  it("a manual host doesn't count as integration-backed, so skipping over Live stays possible", async () => {
    const { projectId, websiteId } = await makeProject(db, actor, { initialStageKey: "ready_to_deploy" });
    await makeManualProductionHost(db, actor, websiteId);
    expect(await databaseDeploymentFacts.hasIntegrationBackedProductionLink(db, websiteId)).toBe(false);
    const stages = Object.fromEntries((await loadStages(db, projectId)).map((s) => [s.key, s]));
    await transitionStage(db, actor, {
      projectId,
      expectedCurrentStageId: stages.ready_to_deploy!.id,
      request: { kind: "skip_forward", targetId: stages.maintenance!.id, reason: "Deployed by hand" },
    });
  });
});

describe("OQ-2: confirming Live from a provider-published deploy", () => {
  it("attributes the deploy, moves Ready to Deploy → Live as the system, and is audited", async () => {
    const { projectId, linkId } = await setup();
    await syncHostingLink(db, linkId, { factory: factoryFor(fakeCloudflare({ canonical: "auto1", deploys: [{ id: "auto1", environment: "production", stage: ["deploy", "success"] }] }).fetchImpl) });
    const [deployment] = await linkDeployments(linkId);
    expect(await confirmLiveFromProviderDeploy(db, actor, { projectId, deploymentId: deployment!.id })).toEqual({ moved: true });
    const stages = Object.fromEntries((await loadStages(db, projectId)).map((s) => [s.key, s.status]));
    expect(stages).toMatchObject({ ready_to_deploy: "completed", live: "current" });
    const [row] = await db.select().from(stageHistory).where(and(eq(stageHistory.projectId, projectId), eq(stageHistory.transition, "go_live")));
    expect(row).toMatchObject({ actorType: "system", deploymentId: deployment!.id });
    expect((await linkDeployments(linkId))[0]!.projectId).toBe(projectId);
    const actions = (await db.select().from(auditEvents).where(eq(auditEvents.projectId, projectId))).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["deployment.attributed", "project.stage_changed"]));
  });

  it("refuses a deploy that isn't the provider's published production deploy, or belongs elsewhere", async () => {
    const { projectId, linkId } = await setup();
    await syncHostingLink(db, linkId, {
      factory: factoryFor(
        fakeCloudflare({
          canonical: "live",
          deploys: [
            { id: "live", environment: "production", stage: ["deploy", "success"] },
            { id: "preview", environment: "preview", stage: ["deploy", "success"] },
          ],
        }).fetchImpl,
      ),
    });
    const rows = await linkDeployments(linkId);
    const preview = rows.find((d) => d.providerDeploymentId === "preview")!;
    await expect(confirmLiveFromProviderDeploy(db, actor, { projectId, deploymentId: preview.id })).rejects.toBeInstanceOf(DomainError);
    expect(Object.fromEntries((await loadStages(db, projectId)).map((s) => [s.key, s.status])).live).toBe("upcoming");
    // Rolled back: the refused attempt left no attribution behind.
    expect((await linkDeployments(linkId)).find((d) => d.id === preview.id)!.projectId).toBeNull();

    const other = await setup();
    const live = rows.find((d) => d.providerDeploymentId === "live")!;
    await expect(confirmLiveFromProviderDeploy(db, actor, { projectId: other.projectId, deploymentId: live.id })).rejects.toMatchObject({
      message: expect.stringMatching(/another website/),
    });
  });
});

describe("readiness: hosting blockers (spec §6)", () => {
  async function readyExceptHosting() {
    const { projectId, websiteId } = await makeProject(db, actor);
    for (const item of await listChecklist(db, projectId)) await setChecklistItemChecked(db, actor, item.id, true);
    return { projectId, websiteId };
  }

  it("no production host is an unwaivable blocker; any production host (even manual) clears it", async () => {
    const { projectId, websiteId } = await readyExceptHosting();
    const blocked = await computeReadiness(db, projectId);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers).toEqual([expect.objectContaining({ key: "hosting:missing", type: "no_production_target", waivable: false })]);
    await expect(waiveBlocker(db, actor, projectId, { blockerKey: "hosting:missing", reason: "Hosting is elsewhere" })).rejects.toMatchObject({
      message: "This blocker can't be waived.",
    });
    await makeManualProductionHost(db, actor, websiteId);
    expect((await computeReadiness(db, projectId)).ready).toBe(true);
  });

  it("a proposed deploy that isn't built blocks (waivable); a ready one doesn't", async () => {
    const { projectId, linkId } = await setup();
    for (const item of await listChecklist(db, projectId)) await setChecklistItemChecked(db, actor, item.id, true);
    await syncHostingLink(db, linkId, {
      factory: factoryFor(
        fakeCloudflare({
          canonical: null,
          deploys: [
            { id: "building", environment: "preview", stage: ["build", "active"] },
            { id: "built", environment: "preview", stage: ["deploy", "success"] },
          ],
        }).fetchImpl,
      ),
    });
    const rows = await linkDeployments(linkId);
    const building = rows.find((d) => d.providerDeploymentId === "building")!;
    const built = rows.find((d) => d.providerDeploymentId === "built")!;
    const notReady = await computeReadiness(db, projectId, { deploymentId: building.id });
    expect(notReady.blockers).toEqual([expect.objectContaining({ key: `preview:${building.id}`, type: "preview_not_ready", waivable: true })]);
    expect((await computeReadiness(db, projectId, { deploymentId: built.id })).ready).toBe(true);
  });
});
