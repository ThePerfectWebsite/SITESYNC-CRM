import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { auditEvents, integrations, repositoryEvents, repositoryLinks, webhookInbox } from "@/server/db/schema";
import { syncRepositoryLink, linksDueForPoll, upsertRepositoryEvents } from "@/server/integrations/github-sync";
import { createRepositoryLink, archiveRepositoryLink, repositorySummary, getRepositoryLink } from "@/server/integrations/repo-links";
import {
  archiveIntegration,
  createIntegration,
  getIntegration,
  githubAdapterFactory,
  setIntegrationDisabled,
  testIntegration,
  updateIntegration,
} from "@/server/integrations/service";
import {
  MAX_ATTEMPTS,
  processWebhookDelivery,
  pruneWebhookInbox,
  receiveGitHubWebhook,
  replayDelivery,
  signBody,
} from "@/server/integrations/webhooks";
import { runMaintenanceJob, runPollJob, runWebhookRetryJob } from "@/server/jobs/handlers";
import { JOB_SCHEMA, QUEUES } from "@/server/jobs/queues";
import { createHttpClient } from "@/server/providers/http";
import { createGitHubAdapter } from "@/server/providers/github";
import type { Actor } from "@/server/records/actor";
import { DomainError } from "@/server/records/errors";
import { listChecklist, setChecklistItemChecked } from "@/server/records/checklist";
import { computeReadiness, waiveBlocker } from "@/server/records/readiness";
import { createTask } from "@/server/records/tasks";
import { loadStages, transitionStage } from "@/server/stages/service";
import { checkRunJson, commitJson, fakeGitHub, healthyRepo, pullJson, sha } from "../support/fake-github";
import { createAdmin, makeProject, makeWebsite, makeClient } from "../support/factories";
import { appDb, ownerClient, resetTestDatabase, testUrls } from "../support/test-db";

let db: Db;
let pool: pg.Pool;
let owner: pg.Client;
let actor: Actor;

const TOKEN_VAR = "TEST_GITHUB_TOKEN";
const SECRET_VAR = "TEST_GITHUB_WEBHOOK_SECRET";

beforeAll(async () => {
  await resetTestDatabase();
  ({ db, pool } = appDb());
  owner = await ownerClient();
  actor = await createAdmin(db);
  process.env[TOKEN_VAR] = "ghp_testtokentesttokentesttokentest0000";
  process.env[SECRET_VAR] = "webhook-secret";
});

afterAll(async () => {
  delete process.env[TOKEN_VAR];
  delete process.env[SECRET_VAR];
  await pool?.end();
  await owner?.end();
});

/** An adapter factory that talks to a fake GitHub without sleeping. */
function factoryFor(fetchImpl: Parameters<typeof githubAdapterFactory>[0]) {
  return (token: string, onRateLimit: Parameters<ReturnType<typeof githubAdapterFactory>>[1]) =>
    createGitHubAdapter({ token, fetchImpl, onRateLimit, sleep: async () => undefined, random: () => 0 });
}

let n = 0;
async function setup(options: { webhook?: boolean } = {}) {
  n++;
  const integrationId = await createIntegration(db, actor, {
    provider: "github",
    name: `GitHub ${n}`,
    tokenEnvVar: TOKEN_VAR,
    webhookEnabled: options.webhook ? "on" : "",
    webhookSecretEnvVar: options.webhook ? SECRET_VAR : "",
    pollEnabled: "on",
  });
  const { projectId, websiteId } = await makeProject(db, actor);
  const linkId = await createRepositoryLink(db, actor, websiteId, {
    integrationId,
    owner: "acme",
    repo: "site",
    productionBranch: "main",
  });
  return { integrationId, projectId, websiteId, linkId };
}

const events = (linkId: string, type?: string) =>
  db
    .select()
    .from(repositoryEvents)
    .where(and(eq(repositoryEvents.repositoryLinkId, linkId), type ? eq(repositoryEvents.eventType, type as never) : undefined));

describe("integrations", () => {
  it("stores env var names only, refuses reserved names, and validates webhook settings", async () => {
    await expect(
      createIntegration(db, actor, { provider: "github", name: "Bad", tokenEnvVar: "DATABASE_OWNER_URL" }),
    ).rejects.toMatchObject({ fieldErrors: { tokenEnvVar: expect.stringMatching(/reserved/) } });
    await expect(
      createIntegration(db, actor, { provider: "github", name: "Hook", tokenEnvVar: TOKEN_VAR, webhookEnabled: "on" }),
    ).rejects.toMatchObject({ fieldErrors: { webhookSecretEnvVar: expect.any(String) } });
    await expect(createIntegration(db, actor, { provider: "netlify", name: "N", tokenEnvVar: "NETLIFY_TOKEN" })).rejects.toBeInstanceOf(
      DomainError,
    );
    const id = await createIntegration(db, actor, { provider: "github", name: "Main", tokenEnvVar: TOKEN_VAR });
    const row = await getIntegration(db, id);
    expect(row).toMatchObject({ tokenEnvVar: TOKEN_VAR, health: "unconfigured", webhookEnabled: false });
    // The token value is nowhere in the database.
    const dump = await owner.query("SELECT row_to_json(i)::text AS j FROM integrations i");
    expect(dump.rows.map((r) => r.j).join()).not.toContain(process.env[TOKEN_VAR]);
    const audit = await owner.query("SELECT string_agg(coalesce(after::text,'') || coalesce(metadata::text,''), '') AS j FROM audit_events");
    expect(audit.rows[0].j).not.toContain(process.env[TOKEN_VAR]);
  });

  it("test connection: ok, then an auth failure sets health to error; a missing env var is unconfigured", async () => {
    const id = await createIntegration(db, actor, { provider: "github", name: "Tested", tokenEnvVar: TOKEN_VAR });
    const ok = fakeGitHub({ "GET /user": { body: { login: "sitesync-bot" }, headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" } } });
    expect(await testIntegration(db, actor, id, factoryFor(ok.fetchImpl))).toEqual({ ok: true, message: "Connected to GitHub as sitesync-bot." });
    expect(await getIntegration(db, id)).toMatchObject({ health: "ok", rateLimitRemaining: 4999, lastTestedAt: expect.any(Date) });

    const denied = fakeGitHub({ "GET /user": { status: 401, body: { message: "Bad credentials" } } });
    const result = await testIntegration(db, actor, id, factoryFor(denied.fetchImpl));
    expect(result.ok).toBe(false);
    expect(await getIntegration(db, id)).toMatchObject({ health: "error", lastError: expect.stringMatching(/refused the token/) });

    await updateIntegration(db, actor, id, { name: "Tested", tokenEnvVar: "UNSET_GITHUB_TOKEN" });
    await testIntegration(db, actor, id, factoryFor(ok.fetchImpl));
    expect(await getIntegration(db, id)).toMatchObject({ health: "unconfigured", healthDetail: expect.stringMatching(/UNSET_GITHUB_TOKEN/) });

    const changes = await db.select().from(auditEvents).where(and(eq(auditEvents.subjectId, id), eq(auditEvents.action, "integration.health_changed")));
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it("disabled integrations are never called; archiving needs links removed first", async () => {
    const { integrationId, linkId } = await setup();
    await setIntegrationDisabled(db, actor, integrationId, true);
    const fake = fakeGitHub({});
    expect(await syncRepositoryLink(db, linkId, { factory: factoryFor(fake.fetchImpl) })).toEqual({ status: "skipped", reason: "integration disabled" });
    expect(fake.calls).toHaveLength(0);
    await expect(archiveIntegration(db, actor, integrationId)).rejects.toMatchObject({ code: "conflict" });
    await archiveRepositoryLink(db, actor, linkId);
    await archiveIntegration(db, actor, integrationId);
  });
});

describe("sync", () => {
  const head = sha(10);
  const commits = [commitJson(10), commitJson(9), commitJson(8)];
  const checks = (s: string) => (s === head ? [checkRunJson(1, head), checkRunJson(2, head, { conclusion: "failure" })] : []);

  it("stores head, commits, open PRs and check runs, and marks the integration ok", async () => {
    const { linkId, integrationId } = await setup();
    const fake = fakeGitHub(healthyRepo({ head, commits, pulls: [pullJson(1), pullJson(2, { base: { ref: "develop" } })], checks }));
    const result = await syncRepositoryLink(db, linkId, { factory: factoryFor(fake.fetchImpl) });
    expect(result).toMatchObject({ status: "ok", headSha: head, commits: 3, pulls: 2, checks: 2 });
    expect(await getRepositoryLink(db, linkId)).toMatchObject({ providerRepoId: "123456", syncCursor: { headSha: head } });
    expect(await events(linkId, "commit")).toHaveLength(3);
    expect(await events(linkId, "check_run")).toHaveLength(2);
    expect(await getIntegration(db, integrationId)).toMatchObject({ health: "ok", lastSyncSucceededAt: expect.any(Date), rateLimitRemaining: 4990 });

    const summary = await repositorySummary(db, (await getRepositoryLink(db, linkId))!);
    expect(summary.pullsIntoProduction.map((p) => p.providerEventId)).toEqual(["1"]);
    expect(summary.otherPulls.map((p) => p.providerEventId)).toEqual(["2"]);
    expect(summary.checks.map((c) => c.conclusion).sort()).toEqual(["failure", "success"]);
  });

  it("is idempotent, and only newer provider data overwrites", async () => {
    const { linkId } = await setup();
    const fake = fakeGitHub(healthyRepo({ head, commits, pulls: [pullJson(1)], checks }));
    await syncRepositoryLink(db, linkId, { factory: factoryFor(fake.fetchImpl) });
    const before = await events(linkId);
    await syncRepositoryLink(db, linkId, { factory: factoryFor(fake.fetchImpl) });
    const after = await events(linkId);
    expect(after).toHaveLength(before.length);
    expect(after.map((e) => e.updatedAt.getTime()).sort()).toEqual(before.map((e) => e.updatedAt.getTime()).sort());

    const [pr] = await events(linkId, "pull_request");
    const older = { ...pr!, title: "Stale title", providerUpdatedAt: new Date("2026-01-01T00:00:00Z") };
    await upsertRepositoryEvents(db, linkId, [{ ...older, snapshot: {}, eventType: "pull_request" }], "webhook");
    expect((await events(linkId, "pull_request"))[0]!.title).toBe("PR 1");
    const newer = { ...older, title: "Fresh title", providerUpdatedAt: new Date("2026-12-01T00:00:00Z") };
    await upsertRepositoryEvents(db, linkId, [{ ...newer, snapshot: {}, eventType: "pull_request" }], "webhook");
    expect((await events(linkId, "pull_request"))[0]).toMatchObject({ title: "Fresh title", source: "webhook" });
  });

  it("closes PRs GitHub no longer lists as open", async () => {
    const { linkId } = await setup();
    await syncRepositoryLink(db, linkId, { factory: factoryFor(fakeGitHub(healthyRepo({ head, commits, pulls: [pullJson(1), pullJson(2)] })).fetchImpl) });
    await syncRepositoryLink(db, linkId, { factory: factoryFor(fakeGitHub(healthyRepo({ head, commits, pulls: [pullJson(2)] })).fetchImpl) });
    const states = Object.fromEntries((await events(linkId, "pull_request")).map((e) => [e.providerEventId, e.state]));
    expect(states).toEqual({ "1": "closed", "2": "open" });
  });

  it("a rate limit degrades health and the poller skips the integration until the reset", async () => {
    const { linkId, integrationId } = await setup();
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    const limited = fakeGitHub({
      "GET /repos/acme/site": { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000", "x-ratelimit-reset": reset }, body: { message: "API rate limit exceeded" } },
    });
    const result = await syncRepositoryLink(db, linkId, { factory: factoryFor(limited.fetchImpl) });
    expect(result.status).toBe("failed");
    expect(await getIntegration(db, integrationId)).toMatchObject({ health: "degraded", rateLimitRemaining: 0, healthDetail: expect.stringMatching(/Rate limited/) });
    expect(await linksDueForPoll(db, 10)).not.toContain(linkId);
    // After the reset, it's due again.
    expect(await linksDueForPoll(db, 10, new Date(Date.now() + 2 * 3600 * 1000))).toContain(linkId);
  });

  it("a 404 says what to check: repo access, or a missing branch", async () => {
    const { linkId, integrationId } = await setup();
    const hidden = fakeGitHub({ "GET /repos/acme/site": { status: 404, body: { message: "Not Found" } } });
    await syncRepositoryLink(db, linkId, { factory: factoryFor(hidden.fetchImpl) });
    expect((await getIntegration(db, integrationId))?.healthDetail).toMatch(
      /^GitHub can't see acme\/site\. Check the owner and name, and that the token has access/,
    );

    const noBranch = fakeGitHub({
      ...healthyRepo({ head, commits }),
      "GET /repos/acme/site": { body: { id: 1, full_name: "acme/site", default_branch: "trunk", private: true } },
      "GET /repos/acme/site/branches/main": { status: 404, body: { message: "Branch not found" } },
    });
    await syncRepositoryLink(db, linkId, { factory: factoryFor(noBranch.fetchImpl) });
    expect((await getIntegration(db, integrationId))?.healthDetail).toBe(
      "The branch main doesn't exist in acme/site. Its default branch is trunk.",
    );
  });

  it("an empty repository (as GitHub really answers: 404 branch, 409 commits) syncs fine with nothing in it", async () => {
    const { linkId, integrationId, projectId } = await setup();
    const empty = fakeGitHub({
      "GET /repos/acme/site": { body: { id: 1, full_name: "acme/site", default_branch: "main", private: false } },
      "GET /repos/acme/site/branches/main": { status: 404, body: { message: "Branch not found" } },
      "GET /repos/acme/site/commits": { status: 409, body: { message: "Git Repository is empty." } },
      "GET /repos/acme/site/pulls": { body: [] },
    });
    const result = await syncRepositoryLink(db, linkId, { factory: factoryFor(empty.fetchImpl) });
    expect(result).toMatchObject({ status: "ok", headSha: null, commits: 0, pulls: 0, checks: 0 });
    expect(await getIntegration(db, integrationId)).toMatchObject({ health: "ok" });
    const synced = await getRepositoryLink(db, linkId);
    expect(synced?.lastSyncedAt).toBeInstanceOf(Date);
    expect(synced?.syncCursor?.headSha).toBeUndefined();
    const readiness = await computeReadiness(db, projectId);
    expect(readiness.notes).toEqual(["acme/site has no commits on main yet, so there are no checks to count."]);
    expect(readiness.blockers.some((b) => b.type === "failing_check")).toBe(false);
  });

  it("the poll job enqueues only links that are due", async () => {
    const { linkId } = await setup();
    const queued: string[] = [];
    await runPollJob(db, async (job) => void queued.push(job.linkId));
    expect(queued).toContain(linkId);
    await syncRepositoryLink(db, linkId, { factory: factoryFor(fakeGitHub(healthyRepo({ head, commits })).fetchImpl) });
    queued.length = 0;
    await runPollJob(db, async (job) => void queued.push(job.linkId));
    expect(queued).not.toContain(linkId);
  });
});

describe("readiness from GitHub checks", () => {
  const head = sha(20);

  async function readyProjectWithRepo() {
    const ctx = await setup();
    for (const item of await listChecklist(db, ctx.projectId)) await setChecklistItemChecked(db, actor, item.id, true);
    return ctx;
  }

  it("failing and unfinished checks on the branch head block; passing ones don't", async () => {
    const { projectId, linkId } = await readyProjectWithRepo();
    const checks = () => [
      checkRunJson(1, head),
      checkRunJson(2, head, { name: "e2e", conclusion: "failure" }),
      checkRunJson(3, head, { name: "deploy-preview", status: "in_progress", conclusion: null }),
      checkRunJson(4, head, { name: "lint", conclusion: "neutral" }),
    ];
    await syncRepositoryLink(db, linkId, { factory: factoryFor(fakeGitHub(healthyRepo({ head, commits: [commitJson(20)], checks })).fetchImpl) });
    const readiness = await computeReadiness(db, projectId);
    expect(readiness.commitSha).toBe(head);
    expect(readiness.blockers.map((b) => b.type)).toEqual(["failing_check", "failing_check"]);
    expect(readiness.blockers.map((b) => b.label)).toEqual([
      expect.stringMatching(/Check failing on 0000000: e2e \(failure\)/),
      expect.stringMatching(/Check still running on 0000000: deploy-preview/),
    ]);
  });

  it("a check waiver scoped to the head commit applies, and stops applying when the head moves", async () => {
    const { projectId, linkId } = await readyProjectWithRepo();
    // Each commit gets its own check run id, as on GitHub.
    const failing = (s: string) => [checkRunJson(parseInt(s.slice(-4), 16) + 1000, s, { name: "e2e", conclusion: "failure" })];
    await syncRepositoryLink(db, linkId, { factory: factoryFor(fakeGitHub(healthyRepo({ head, commits: [commitJson(20)], checks: failing })).fetchImpl) });
    const key = `check_run:${linkId}:e2e`;
    await waiveBlocker(db, actor, projectId, { blockerKey: key, reason: "Known flaky test", commitSha: head });
    expect((await computeReadiness(db, projectId)).ready).toBe(true);

    const newHead = sha(21);
    await syncRepositoryLink(db, linkId, {
      factory: factoryFor(fakeGitHub(healthyRepo({ head: newHead, commits: [commitJson(21)], checks: failing })).fetchImpl),
    });
    const moved = await computeReadiness(db, projectId);
    expect(moved.commitSha).toBe(newHead);
    expect(moved.ready).toBe(false);
    expect(moved.inactiveWaivers.map((w) => w.blockerKey)).toEqual([key]);
  });

  it("a disconnected integration is a note, never a blocker, and doesn't block manual work", async () => {
    const { projectId, integrationId } = await readyProjectWithRepo();
    await testIntegration(db, actor, integrationId, factoryFor(fakeGitHub({ "GET /user": { status: 401, body: { message: "Bad credentials" } } }).fetchImpl));
    const readiness = await computeReadiness(db, projectId);
    expect(readiness.ready).toBe(true);
    expect(readiness.notes).toEqual([expect.stringMatching(/GitHub checks unavailable for acme\/site: .* is error/)]);

    // Manual flows still work.
    await createTask(db, actor, projectId, { title: "Still works" });
    const current = (await loadStages(db, projectId)).find((s) => s.status === "current")!;
    await transitionStage(db, actor, { projectId, expectedCurrentStageId: current.id, request: { kind: "advance" } });
  });
});

describe("repository links", () => {
  it("validate owner, repo and branch, need a GitHub integration, and keep one primary", async () => {
    const integrationId = await createIntegration(db, actor, { provider: "github", name: "Links", tokenEnvVar: TOKEN_VAR });
    const websiteId = await makeWebsite(db, actor, await makeClient(db, actor));
    const bad = (input: Record<string, unknown>) => createRepositoryLink(db, actor, websiteId, { integrationId, owner: "acme", repo: "site", productionBranch: "main", ...input });
    await expect(bad({ owner: "-acme" })).rejects.toMatchObject({ fieldErrors: { owner: expect.any(String) } });
    await expect(bad({ repo: "a/b" })).rejects.toMatchObject({ fieldErrors: { repo: expect.any(String) } });
    await expect(bad({ productionBranch: "feature..x" })).rejects.toMatchObject({ fieldErrors: { productionBranch: expect.any(String) } });
    await expect(bad({ integrationId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ fieldErrors: { integrationId: expect.any(String) } });

    const first = await bad({ repo: "site.git" });
    expect(await getRepositoryLink(db, first)).toMatchObject({ repo: "site", isPrimary: true });
    await expect(bad({ repo: "SITE" })).rejects.toMatchObject({ fieldErrors: { repo: expect.stringMatching(/already linked/) } });
    const second = await bad({ repo: "docs", isPrimary: "on" });
    expect(await getRepositoryLink(db, first)).toMatchObject({ isPrimary: false });
    expect(await getRepositoryLink(db, second)).toMatchObject({ isPrimary: true });
    await archiveRepositoryLink(db, actor, second);
    expect(await getRepositoryLink(db, first)).toMatchObject({ isPrimary: true });
  });
});

describe("webhooks", () => {
  function delivery(body: object, options: { event?: string; id?: string; secret?: string } = {}) {
    const raw = Buffer.from(JSON.stringify(body));
    const headers = new Headers({
      "x-github-event": options.event ?? "push",
      "x-github-delivery": options.id ?? crypto.randomUUID(),
      "x-hub-signature-256": signBody(options.secret ?? process.env[SECRET_VAR]!, raw),
    });
    return { raw, headers };
  }

  const pushBody = (after: string) => ({
    ref: "refs/heads/main",
    after,
    repository: { full_name: "acme/site" },
    commits: [{ id: after, message: "Push commit\nmore", timestamp: "2026-11-03T08:00:00Z", url: `https://github.com/acme/site/commit/${after}`, author: { username: "dev" } }],
  });

  afterEach(async () => {
    await owner.query("UPDATE integrations SET webhook_enabled = false WHERE webhook_enabled");
  });

  it("is a 404 unless the integration enables webhooks", async () => {
    const { integrationId } = await setup();
    const { raw, headers } = delivery({ zen: "hi" }, { event: "ping" });
    expect(await receiveGitHubWebhook(db, { integrationId, headers, body: raw })).toMatchObject({ status: 404 });
    expect(await receiveGitHubWebhook(db, { integrationId: "00000000-0000-4000-8000-000000000000", headers, body: raw })).toMatchObject({ status: 404 });
  });

  it("rejects bad, missing or wrong-secret signatures with 401 and stores nothing", async () => {
    const { integrationId } = await setup({ webhook: true });
    const before = await db.$count(webhookInbox);
    const { raw, headers } = delivery({ zen: "hi" }, { event: "ping", secret: "wrong" });
    expect(await receiveGitHubWebhook(db, { integrationId, headers, body: raw })).toMatchObject({ status: 401 });
    headers.delete("x-hub-signature-256");
    expect(await receiveGitHubWebhook(db, { integrationId, headers, body: raw })).toMatchObject({ status: 401 });
    const good = delivery({ zen: "hi" }, { event: "ping" });
    expect(await receiveGitHubWebhook(db, { integrationId, headers: good.headers, body: Buffer.from('{"zen":"tampered"}') })).toMatchObject({ status: 401 });
    expect(await receiveGitHubWebhook(db, { integrationId, headers: good.headers, body: "too_large" })).toMatchObject({ status: 413 });
    expect(await db.$count(webhookInbox)).toBe(before);
  });

  it("stores once per delivery id; non-allowlisted events are stored as ignored", async () => {
    const { integrationId } = await setup({ webhook: true });
    const first = delivery({ zen: "hi" }, { event: "ping", id: "delivery-dup" });
    expect(await receiveGitHubWebhook(db, { integrationId, headers: first.headers, body: first.raw })).toMatchObject({ status: 202, process: true });
    expect(await receiveGitHubWebhook(db, { integrationId, headers: first.headers, body: first.raw })).toEqual({ status: 200, duplicate: true });

    const issue = delivery({ action: "opened", repository: { full_name: "acme/site" } }, { event: "issues", id: "delivery-issue" });
    expect(await receiveGitHubWebhook(db, { integrationId, headers: issue.headers, body: issue.raw })).toMatchObject({ status: 202, process: false });
    const [row] = await db.select().from(webhookInbox).where(eq(webhookInbox.deliveryId, "delivery-issue"));
    expect(row).toMatchObject({ status: "ignored", signatureValid: true });
  });

  it("a push to the production branch records commits and moves the head", async () => {
    const { integrationId, linkId } = await setup({ webhook: true });
    const after = sha(77);
    const { raw, headers } = delivery(pushBody(after));
    const received = await receiveGitHubWebhook(db, { integrationId, headers, body: raw });
    if (received.status !== 202) throw new Error("not received");
    expect(await processWebhookDelivery(db, received.inboxId)).toBe("processed");
    expect(await processWebhookDelivery(db, received.inboxId)).toBe("skipped"); // already done
    expect(await getRepositoryLink(db, linkId)).toMatchObject({ syncCursor: { headSha: after } });
    expect((await events(linkId, "commit"))[0]).toMatchObject({ commitSha: after, title: "Push commit", source: "webhook" });
  });

  it("check_run deliveries update checks; secrets in bodies are redacted before storage", async () => {
    const { integrationId, linkId } = await setup({ webhook: true });
    const head = sha(88);
    const body = { action: "completed", repository: { full_name: "acme/site" }, check_run: checkRunJson(500, head, { conclusion: "failure" }), installation: { token: "ghs_shouldnotbestored" } };
    const { raw, headers } = delivery(body, { event: "check_run" });
    const received = await receiveGitHubWebhook(db, { integrationId, headers, body: raw });
    if (received.status !== 202) throw new Error("not received");
    const [stored] = await db.select().from(webhookInbox).where(eq(webhookInbox.id, received.inboxId));
    expect(JSON.stringify(stored!.body)).not.toContain("ghs_shouldnotbestored");
    await processWebhookDelivery(db, received.inboxId);
    expect((await events(linkId, "check_run"))[0]).toMatchObject({ providerEventId: "500", conclusion: "failure", commitSha: head });
  });

  it("failures retry with backoff, dead-letter after 8 attempts, and can be replayed", async () => {
    const { integrationId } = await setup({ webhook: true });
    const { raw, headers } = delivery({ repository: { full_name: "acme/site" }, pull_request: { not: "a pr" } }, { event: "pull_request" });
    const received = await receiveGitHubWebhook(db, { integrationId, headers, body: raw });
    if (received.status !== 202) throw new Error("not received");
    const id = received.inboxId;

    let now = new Date("2026-11-03T12:00:00Z");
    expect(await processWebhookDelivery(db, id, { now })).toBe("failed");
    const [failed] = await db.select().from(webhookInbox).where(eq(webhookInbox.id, id));
    expect(failed).toMatchObject({ status: "failed", attempts: 1, nextAttemptAt: new Date(now.getTime() + 30_000), lastError: expect.any(String) });

    // The retry job only picks it up once the backoff has passed.
    expect(await runWebhookRetryJob(db, new Date(now.getTime() + 10_000))).toBe(0);
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      expect(await runWebhookRetryJob(db, now)).toBe(1);
    }
    const [dead] = await db.select().from(webhookInbox).where(eq(webhookInbox.id, id));
    expect(dead).toMatchObject({ status: "dead_lettered", attempts: MAX_ATTEMPTS, nextAttemptAt: null });
    expect(await runWebhookRetryJob(db, new Date(now.getTime() + 10 * 3600 * 1000))).toBe(0);

    await replayDelivery(db, actor, id);
    expect((await db.select().from(webhookInbox).where(eq(webhookInbox.id, id)))[0]).toMatchObject({ status: "received", attempts: 0 });
    await expect(replayDelivery(db, actor, id)).rejects.toMatchObject({ code: "conflict" });
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, "webhook.replayed"));
    expect(audit).toMatchObject({ subjectId: id, actorUserId: actor.userId });
  });

  it("retention prunes processed/ignored deliveries after 30 days but keeps dead letters", async () => {
    await owner.query(`UPDATE webhook_inbox SET received_at = now() - interval '40 days'`);
    const deadBefore = await db.$count(webhookInbox, eq(webhookInbox.status, "dead_lettered"));
    await owner.query(`UPDATE webhook_inbox SET status = 'dead_lettered' WHERE id = (SELECT id FROM webhook_inbox WHERE status = 'received' LIMIT 1)`);
    const removed = await pruneWebhookInbox(db);
    expect(removed).toBeGreaterThan(0);
    expect(await db.$count(webhookInbox, eq(webhookInbox.status, "processed"))).toBe(0);
    expect(await db.$count(webhookInbox, eq(webhookInbox.status, "dead_lettered"))).toBeGreaterThanOrEqual(deadBefore);
    expect(await runMaintenanceJob(db)).toMatchObject({ deliveries: 0 });
  });
});

describe("job store (decision 0009)", () => {
  it("the runtime role can run pg-boss without DDL rights: send, dedupe per link, work", async () => {
    const boss = new PgBoss({ connectionString: testUrls().app, schema: JOB_SCHEMA, migrate: false, createSchema: false, supervise: false, schedule: false });
    const errors: unknown[] = [];
    boss.on("error", (e) => errors.push(e));
    await boss.start();
    try {
      const first = await boss.send(QUEUES.githubSync, { linkId: "a", mode: "manual" }, { singletonKey: "a" });
      const second = await boss.send(QUEUES.githubSync, { linkId: "a", mode: "manual" }, { singletonKey: "a" });
      expect(first).toEqual(expect.any(String));
      expect(second).toBeNull();
      const seen: unknown[] = [];
      await boss.work(QUEUES.githubSync, async (jobs) => void seen.push(...jobs.map((j) => j.data)));
      await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(1);
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
    expect(errors).toEqual([]);
    // …and it really has no DDL rights there.
    await expect(pool.query(`CREATE TABLE ${JOB_SCHEMA}.nope (id int)`)).rejects.toThrow(/permission denied/);
  });

  it("the runtime role can start pg-boss with its scheduler and maintenance on (as the app does)", async () => {
    const boss = new PgBoss({
      connectionString: testUrls().app,
      schema: JOB_SCHEMA,
      migrate: false,
      createSchema: false,
      supervise: true,
      schedule: true,
      superviseIntervalSeconds: 1,
    });
    const errors: string[] = [];
    boss.on("error", (e) => errors.push(String((e as Error)?.message ?? e)));
    await boss.start();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await boss.stop({ graceful: false, close: true });
    expect(errors).toEqual([]);
  });

  it("no outbound request is possible outside the provider allowlist", async () => {
    const client = createHttpClient({ baseUrl: "https://evil.example", headers: {} });
    await expect(client.request("/x")).rejects.toMatchObject({ kind: "blocked" });
  });

  it("repository events can't be deleted by the runtime role", async () => {
    await expect(pool.query("DELETE FROM repository_events")).rejects.toThrow(/permission denied/);
    await expect(pool.query("DELETE FROM integrations")).rejects.toThrow(/permission denied/);
    expect(await db.$count(repositoryLinks)).toBeGreaterThan(0);
    expect(await db.$count(integrations)).toBeGreaterThan(0);
  });
});
