import { describe, expect, it } from "vitest";
import {
  cloudflareAutoPublish,
  createCloudflareAdapter,
  mapCloudflareState,
  mapNetlifyState,
  mapVercelState,
  netlifyAutoPublish,
  normalizeCloudflareDeployment,
  normalizeNetlifyDeploy,
  normalizeVercelDeployment,
  vercelAutoPublish,
} from "@/server/providers/hosting";
import { assertAllowedUrl } from "@/server/providers/fetch";
import { fakeGitHub, sha } from "../support/fake-github";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("§5.2 state mapping — Netlify (swagger `state` enum)", () => {
  const base = { isCurrent: false, publishedAt: null, skipped: false, production: true };
  it.each([
    ["new", "queued"],
    ["pending_review", "queued"],
    ["accepted", "queued"],
    ["enqueued", "queued"],
    ["retrying", "queued"],
    ["building", "building"],
    ["uploading", "building"],
    ["uploaded", "building"],
    ["preparing", "building"],
    ["prepared", "building"],
    ["processing", "building"],
    ["processed", "building"],
    ["ready", "ready"],
    ["error", "failed"],
    ["rejected", "canceled"],
    ["something_new", "unknown"],
  ])("%s → %s", (state, expected) => {
    expect(mapNetlifyState(state, base)).toBe(expected);
  });

  it("the site's published deploy is published; an earlier published production deploy is superseded", () => {
    expect(mapNetlifyState("ready", { ...base, isCurrent: true })).toBe("published");
    expect(mapNetlifyState("ready", { ...base, publishedAt: new Date() })).toBe("superseded");
    expect(mapNetlifyState("ready", { ...base, production: false, publishedAt: new Date() })).toBe("ready");
    expect(mapNetlifyState("ready", { ...base, skipped: true })).toBe("canceled");
  });

  it("normalizes a deploy: context → environment, full SHA only, https URL", () => {
    const deploy = normalizeNetlifyDeploy(
      {
        id: "d1",
        state: "ready",
        context: "deploy-preview",
        branch: "feature",
        commit_ref: sha(5),
        deploy_ssl_url: "https://d1--site.netlify.app",
        created_at: "2026-11-03T10:00:00Z",
        updated_at: "2026-11-03T10:05:00Z",
      },
      null,
    );
    expect(deploy).toMatchObject({ environment: "preview", state: "ready", commitSha: sha(5), deployUrl: "https://d1--site.netlify.app" });
    expect(normalizeNetlifyDeploy({ id: "d2", state: "ready", commit_ref: "abc123" }, null).commitSha).toBeNull();
  });

  it("auto-publish: locked published deploy → locked; stopped builds → disabled", () => {
    const site = { id: "s", name: "s" };
    expect(netlifyAutoPublish({ ...site, published_deploy: { id: "d", locked: true } })).toBe("locked");
    expect(netlifyAutoPublish({ ...site, published_deploy: { id: "d", locked: false } })).toBe("enabled");
    expect(netlifyAutoPublish({ ...site, build_settings: { stop_builds: true }, published_deploy: { id: "d", locked: false } })).toBe("disabled");
    expect(netlifyAutoPublish(site)).toBe("unknown");
  });
});

describe("§5.2 state mapping — Vercel (`readyState` enum)", () => {
  const base = { isCurrent: false, production: true, readySubstate: null };
  it.each([
    ["QUEUED", "queued"],
    ["INITIALIZING", "queued"],
    ["BLOCKED", "queued"],
    ["BUILDING", "building"],
    ["READY", "ready"],
    ["ERROR", "failed"],
    ["CANCELED", "canceled"],
    ["DELETED", "canceled"],
    ["SOMETHING", "unknown"],
  ])("%s → %s", (state, expected) => {
    expect(mapVercelState(state, base)).toBe(expected);
  });

  it("current → published; a PROMOTED production deploy that isn't current → superseded; STAGED → ready", () => {
    expect(mapVercelState("READY", { ...base, isCurrent: true })).toBe("published");
    expect(mapVercelState("READY", { ...base, readySubstate: "PROMOTED" })).toBe("superseded");
    expect(mapVercelState("READY", { ...base, readySubstate: "STAGED" })).toBe("ready");
  });

  it("target → environment, https URL, commit from Git metadata", () => {
    const d = normalizeVercelDeployment(
      { uid: "dpl_1", url: "site-abc.vercel.app", readyState: "READY", target: null, created: 1793000000000, meta: { githubCommitSha: sha(9), githubCommitRef: "main" } },
      null,
    );
    expect(d).toMatchObject({ environment: "preview", deployUrl: "https://site-abc.vercel.app", commitSha: sha(9), branch: "main" });
    expect(normalizeVercelDeployment({ uid: "x", readyState: "READY", target: "staging" }, null).environment).toBe("staging");
  });

  it("auto-publish: auto-assign of custom domains off → locked (deploys are staged)", () => {
    expect(vercelAutoPublish({ id: "p", name: "p", autoAssignCustomDomains: false })).toBe("locked");
    expect(vercelAutoPublish({ id: "p", name: "p", autoAssignCustomDomains: true })).toBe("enabled");
    expect(vercelAutoPublish({ id: "p", name: "p" })).toBe("unknown");
  });
});

describe("§5.2 state mapping — Cloudflare Pages (`latest_stage` name × status)", () => {
  const base = { isCurrent: false, production: false, skipped: false };
  it.each([
    [{ name: "queued", status: "idle" }, "queued"],
    [{ name: "queued", status: "active" }, "queued"],
    [{ name: "initialize", status: "active" }, "building"],
    [{ name: "clone_repo", status: "success" }, "building"],
    [{ name: "build", status: "active" }, "building"],
    [{ name: "deploy", status: "active" }, "building"],
    [{ name: "deploy", status: "success" }, "ready"],
    [{ name: "build", status: "failure" }, "failed"],
    [{ name: "build", status: "canceled" }, "canceled"],
    [{ name: "build", status: "skipped" }, "canceled"],
    [{ name: "mystery", status: "active" }, "unknown"],
  ])("%o → %s", (stage, expected) => {
    expect(mapCloudflareState(stage, base)).toBe(expected);
  });

  it("canonical → published; an older successful production deploy → superseded; is_skipped → canceled", () => {
    const done = { name: "deploy", status: "success" };
    expect(mapCloudflareState(done, { ...base, isCurrent: true })).toBe("published");
    expect(mapCloudflareState(done, { ...base, production: true })).toBe("superseded");
    expect(mapCloudflareState(done, { ...base, skipped: true })).toBe("canceled");
    expect(mapCloudflareState(null, base)).toBe("unknown");
  });

  it("normalizes a deployment from its trigger metadata", () => {
    const d = normalizeCloudflareDeployment(
      {
        id: "cf-1",
        environment: "production",
        url: "https://abc123.site.pages.dev",
        created_on: "2026-11-03T10:00:00Z",
        modified_on: "2026-11-03T10:03:00Z",
        latest_stage: { name: "deploy", status: "success" },
        deployment_trigger: { type: "github:push", metadata: { branch: "main", commit_hash: sha(4), commit_message: "Ship it\n\nbody" } },
      },
      "cf-1",
    );
    expect(d).toMatchObject({
      environment: "production",
      state: "published",
      commitSha: sha(4),
      branch: "main",
      deployUrl: "https://abc123.site.pages.dev",
      providerState: "deploy/success",
      snapshot: { commitMessage: "Ship it" },
    });
    expect(d.publishedAt).toEqual(new Date("2026-11-03T10:03:00Z"));
  });

  it("auto-publish: production deployments off, or no Git source → disabled", () => {
    const p = { id: "1", name: "site" };
    expect(cloudflareAutoPublish({ ...p, source: { type: "github", config: { production_deployments_enabled: true } } })).toBe("enabled");
    expect(cloudflareAutoPublish({ ...p, source: { type: "github", config: { production_deployments_enabled: false } } })).toBe("disabled");
    expect(cloudflareAutoPublish({ ...p, source: { type: "github", config: { deployments_enabled: false } } })).toBe("disabled");
    expect(cloudflareAutoPublish(p)).toBe("disabled");
    expect(cloudflareAutoPublish({ ...p, source: { type: "github" } })).toBe("unknown");
  });

  it("the adapter calls api.cloudflare.com with the account ID, and requires a valid one", async () => {
    expect(assertAllowedUrl("https://api.cloudflare.com/client/v4/x").hostname).toBe("api.cloudflare.com");
    const fake = fakeGitHub({
      [`GET /client/v4/accounts/${ACCOUNT}/pages/projects/site`]: {
        body: {
          success: true,
          result: {
            id: "p1",
            name: "site",
            subdomain: "site.pages.dev",
            domains: ["site.pages.dev", "www.example.com"],
            canonical_deployment: { id: "cf-2" },
            source: { type: "github", config: { production_deployments_enabled: false } },
          },
        },
      },
      [`GET /client/v4/accounts/${ACCOUNT}/pages/projects/site/deployments`]: {
        body: {
          success: true,
          result: [
            { id: "cf-2", environment: "production", latest_stage: { name: "deploy", status: "success" } },
            { id: "cf-1", environment: "production", latest_stage: { name: "deploy", status: "success" } },
          ],
          result_info: { page: 1, total_pages: 3 },
        },
      },
    });
    const adapter = createCloudflareAdapter({ token: "cf-token", accountRef: ACCOUNT, fetchImpl: fake.fetchImpl, sleep: async () => undefined });
    expect(await adapter.getProject("site")).toEqual({
      providerProjectId: "site",
      name: "site",
      productionDomain: "www.example.com",
      autoPublish: "disabled",
      currentProductionDeploymentId: "cf-2",
    });
    const page = await adapter.listDeployments("site", { limit: 50 });
    expect(page.items.map((d) => [d.providerDeploymentId, d.state])).toEqual([
      ["cf-2", "published"],
      ["cf-1", "superseded"],
    ]);
    expect(page.truncated).toBe(true);
    expect(fake.calls[1]!.url.searchParams.get("per_page")).toBe("25");
    expect(fake.calls[0]!.headers.get("authorization")).toBe("Bearer cf-token");

    const noAccount = createCloudflareAdapter({ token: "t", accountRef: "nope", fetchImpl: fake.fetchImpl });
    await expect(noAccount.getProject("site")).rejects.toThrow(/Cloudflare account ID/);
  });
});
