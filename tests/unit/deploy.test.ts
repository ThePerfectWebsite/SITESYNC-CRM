import { describe, expect, it } from "vitest";
import { confirmBackoffSeconds, judgeRelease } from "@/server/deploy/confirm";
import { canonicalJson, hashSnapshot, releaseStageProblem } from "@/server/deploy/preflight";
import { providerFetch } from "@/server/providers/fetch";
import { createCloudflareAdapter, createNetlifyAdapter, createVercelAdapter, UnsupportedActionError } from "@/server/providers/hosting";
import type { StageView } from "@/server/stages/machine";
import { fakeGitHub, sha } from "../support/fake-github";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const noSleep = { sleep: async () => undefined, random: () => 0 };

describe("preflight hash", () => {
  it("is canonical: key order and undefined fields don't matter, values do", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"x":2,"y":1}]},"b":1}');
    const one = hashSnapshot({ target: { sha: sha(1) }, action: "promote" });
    expect(one).toEqual(hashSnapshot({ action: "promote", target: { sha: sha(1) } }));
    expect(one).not.toEqual(hashSnapshot({ action: "promote", target: { sha: sha(2) } }));
    expect(one).toHaveLength(32);
  });
});

describe("release stage rule", () => {
  const stage = (key: string, position: number, role: StageView["role"], status: StageView["status"], kind: StageView["kind"] = "linear"): StageView => ({
    id: key,
    key,
    name: key,
    position,
    kind,
    role,
    status,
  });
  it("needs Ready to Deploy or later, and not On Hold", () => {
    const stages = (current: string) => [
      stage("build", 1, null, current === "build" ? "current" : "upcoming"),
      stage("rtd", 2, "ready_to_deploy", current === "rtd" ? "current" : "upcoming"),
      stage("live", 3, "live", current === "live" ? "current" : "upcoming"),
      stage("hold", 90, null, current === "hold" ? "current" : "upcoming", "on_hold"),
    ];
    expect(releaseStageProblem(stages("build"))).toMatch(/Move it to rtd/);
    expect(releaseStageProblem(stages("rtd"))).toBeNull();
    expect(releaseStageProblem(stages("live"))).toBeNull();
    expect(releaseStageProblem(stages("hold"))).toMatch(/project is hold/);
  });
});

describe("confirmation (§5.3)", () => {
  it("backs off 5 s → 60 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(confirmBackoffSeconds)).toEqual([5, 10, 20, 40, 60, 60]);
  });

  const build = { id: "row", kind: "deploy" as const, providerDeploymentId: "p", targetDeploymentId: null, previousLiveDeploymentId: "old", state: "building" as const, commitSha: sha(1) };
  it("a build succeeds only when it's live with the approved commit", () => {
    expect(judgeRelease(build, sha(1), "old", null)).toEqual({ kind: "waiting" });
    expect(judgeRelease({ ...build, state: "published" }, sha(1), "row", null)).toEqual({ kind: "success" });
    expect(judgeRelease({ ...build, state: "published", commitSha: sha(2) }, sha(1), "row", null)).toMatchObject({ kind: "failure", reason: expect.stringMatching(/not the approved/) });
    expect(judgeRelease({ ...build, state: "published", commitSha: null }, sha(1), "row", null)).toMatchObject({ kind: "failure" });
    expect(judgeRelease({ ...build, state: "failed" }, sha(1), "old", null)).toMatchObject({ kind: "failure" });
    expect(judgeRelease({ ...build, providerDeploymentId: null }, sha(1), "old", null)).toEqual({ kind: "waiting" });
  });

  const promote = { ...build, kind: "promote" as const, providerDeploymentId: null, targetDeploymentId: "target", state: "queued" as const };
  it("a promote succeeds when the target is live; another deploy going live is a failure", () => {
    expect(judgeRelease(promote, sha(1), "old", { state: "ready" })).toEqual({ kind: "waiting" });
    expect(judgeRelease(promote, sha(1), "target", { state: "published" })).toEqual({ kind: "success" });
    expect(judgeRelease(promote, sha(1), "other", { state: "ready" })).toMatchObject({ kind: "failure", reason: expect.stringMatching(/different deploy/) });
    expect(judgeRelease(promote, sha(1), "old", { state: "canceled" })).toMatchObject({ kind: "failure" });
  });
});

describe("provider writes (decision 0011)", () => {
  it("are never retried after a 5xx or network error, and never follow redirects", async () => {
    const fake = fakeGitHub({ "POST /api/v1/sites/site/deploys/d1/restore": { status: 502, body: { message: "bad gateway" } } });
    const netlify = createNetlifyAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep });
    await expect(netlify.promote("site", "d1")).rejects.toMatchObject({ kind: "server" });
    expect(fake.calls).toHaveLength(1);

    const redirect = async () => new Response(null, { status: 307, headers: { location: "https://api.netlify.com/elsewhere" } });
    await expect(
      providerFetch("https://api.netlify.com/api/v1/x", { method: "POST" }, { fetchImpl: redirect, followRedirects: false }),
    ).rejects.toThrow(/redirect on a write/);
  });

  it("a rate-limit refusal (not acted on) is retried", async () => {
    const fake = fakeGitHub({
      "POST /api/v1/sites/site/deploys/d1/restore": [
        { status: 429, body: { message: "slow down" }, headers: { "retry-after": "1" } },
        { status: 201, body: { id: "d1" } },
      ],
    });
    const netlify = createNetlifyAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep });
    await expect(netlify.promote("site", "d1")).resolves.toEqual({ providerDeploymentId: null });
    expect(fake.calls).toHaveLength(2);
  });

  it("Vercel promote and rollback use the documented paths with the team ID", async () => {
    const fake = fakeGitHub({
      "POST /v10/projects/prj/promote/dpl_1": { status: 201, body: {} },
      "POST /v1/projects/prj/rollback/dpl_0": { status: 201, body: {} },
    });
    const vercel = createVercelAdapter({ token: "t", accountRef: "team_1", fetchImpl: fake.fetchImpl, ...noSleep });
    await vercel.promote("prj", "dpl_1");
    await vercel.rollback("prj", "dpl_0");
    expect(fake.calls.map((c) => [c.method, c.url.pathname, c.url.searchParams.get("teamId")])).toEqual([
      ["POST", "/v10/projects/prj/promote/dpl_1", "team_1"],
      ["POST", "/v1/projects/prj/rollback/dpl_0", "team_1"],
    ]);
    await expect(vercel.buildFromRef("prj", "main")).rejects.toBeInstanceOf(UnsupportedActionError);
  });

  it("Cloudflare builds a branch (form field) and rolls back to a deployment", async () => {
    let branch: unknown = null;
    const base = `/client/v4/accounts/${ACCOUNT}/pages/projects/site`;
    const fake = fakeGitHub({
      [`POST ${base}/deployments`]: (_url, init) => {
        branch = (init.body as FormData).get("branch");
        return { body: { success: true, result: { id: "new-deploy" } } };
      },
      [`POST ${base}/deployments/old/rollback`]: { body: { success: true, result: { id: "old" } } },
    });
    const cf = createCloudflareAdapter({ token: "t", accountRef: ACCOUNT, fetchImpl: fake.fetchImpl, ...noSleep });
    expect(await cf.buildFromRef("site", "main")).toEqual({ providerDeploymentId: "new-deploy" });
    expect(branch).toBe("main");
    expect(await cf.rollback("site", "old")).toEqual({ providerDeploymentId: null });
    await expect(cf.promote("site", "x")).rejects.toBeInstanceOf(UnsupportedActionError);
  });
});
