import { describe, expect, it } from "vitest";
import { checkEnvVarName, MissingTokenError, nextHealth } from "@/server/integrations/service";
import { signBody, verifySignature, retryDelayMs } from "@/server/integrations/webhooks";
import { assertAllowedUrl, BlockedRequestError, providerFetch } from "@/server/providers/fetch";
import { createGitHubAdapter } from "@/server/providers/github";
import { classifyFailure, createHttpClient, ProviderError } from "@/server/providers/http";
import { checkRunJson, commitJson, fakeGitHub, pullJson, sha } from "../support/fake-github";

const repo = { owner: "acme", repo: "site" };
const noSleep = { sleep: async () => undefined, random: () => 0 };

describe("network guard", () => {
  it("fails any request that isn't mocked", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(/Unmocked network request/);
  });
});

describe("providerFetch: SSRF guard", () => {
  it.each([
    ["http://api.github.com/user", /only https/],
    ["https://evil.example/user", /not an allowed provider API/],
    ["https://api.github.com.evil.example/", /not an allowed/],
    ["https://user:pass@api.github.com/", /credentials/],
    ["https://api.github.com:8443/", /non-default port/],
    ["https://169.254.169.254/latest/meta-data", /not an allowed/],
    ["https://localhost/", /not an allowed/],
    ["not a url", /not a valid URL/],
  ])("rejects %s", (url, reason) => {
    expect(() => assertAllowedUrl(url)).toThrow(reason);
  });

  it("allows the three provider APIs", () => {
    for (const host of ["api.github.com", "api.netlify.com", "api.vercel.com"]) {
      expect(assertAllowedUrl(`https://${host}/x`).hostname).toBe(host);
    }
  });

  it("follows a same-host redirect but refuses one to another host", async () => {
    const same = fakeGitHub({
      "GET /repos/old/name": { status: 301, headers: { location: "https://api.github.com/repositories/1" } },
      "GET /repositories/1": { body: { ok: true } },
    });
    const response = await providerFetch("https://api.github.com/repos/old/name", {}, { fetchImpl: same.fetchImpl });
    expect(await response.json()).toEqual({ ok: true });

    const offsite = fakeGitHub({
      "GET /x": { status: 302, headers: { location: "https://attacker.example/steal" } },
    });
    await expect(providerFetch("https://api.github.com/x", {}, { fetchImpl: offsite.fetchImpl })).rejects.toBeInstanceOf(
      BlockedRequestError,
    );
  });
});

describe("failure classification (GitHub rate-limit rules)", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const headers = (h: Record<string, string>) => new Headers(h);

  it("429 with Retry-After waits that long", () => {
    const result = classifyFailure(429, headers({ "retry-after": "30" }), "slow down", now);
    expect(result).toEqual({ kind: "rate_limited", retryAt: new Date(now + 30_000) });
  });

  it("403 with remaining 0 is a primary rate limit: wait for the reset", () => {
    const reset = String(now / 1000 + 600);
    const result = classifyFailure(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), "API rate limit exceeded", now);
    expect(result).toEqual({ kind: "rate_limited", retryAt: new Date(now + 600_000) });
  });

  it("403 saying 'secondary rate limit' is a rate limit, waiting at least a minute", () => {
    const result = classifyFailure(403, headers({ "x-ratelimit-remaining": "4000" }), "You have exceeded a secondary rate limit", now);
    expect(result).toEqual({ kind: "rate_limited", retryAt: new Date(now + 60_000) });
  });

  it("any other 403, and 401, are auth problems", () => {
    expect(classifyFailure(403, headers({ "x-ratelimit-remaining": "4000" }), "Resource not accessible by personal access token", now).kind).toBe("auth");
    expect(classifyFailure(401, headers({}), "Bad credentials", now).kind).toBe("auth");
  });

  it("404 and 5xx", () => {
    expect(classifyFailure(404, headers({}), "Not Found", now).kind).toBe("not_found");
    expect(classifyFailure(502, headers({}), "Bad gateway", now).kind).toBe("server");
  });
});

describe("retries", () => {
  it("retries 429 respecting Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    const fake = fakeGitHub({
      "GET /user": [{ status: 429, headers: { "retry-after": "2" }, body: { message: "slow" } }, { body: { login: "bot" } }],
    });
    const client = createHttpClient({
      baseUrl: "https://api.github.com",
      headers: {},
      fetchImpl: fake.fetchImpl,
      sleep: async (ms) => void waits.push(ms),
      random: () => 0,
      now: () => 0,
    });
    const response = await client.request("/user");
    expect(response.status).toBe(200);
    expect(waits).toEqual([2000]);
  });

  it("retries 5xx with exponential backoff and gives up after 5 attempts", async () => {
    const waits: number[] = [];
    const fake = fakeGitHub({ "GET /user": { status: 503, body: { message: "unavailable" } } });
    const client = createHttpClient({
      baseUrl: "https://api.github.com",
      headers: {},
      fetchImpl: fake.fetchImpl,
      sleep: async (ms) => void waits.push(ms),
      random: () => 0,
    });
    await expect(client.request("/user")).rejects.toMatchObject({ kind: "server", status: 503 });
    expect(fake.calls).toHaveLength(5);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it("never retries an auth error", async () => {
    const fake = fakeGitHub({ "GET /user": { status: 401, body: { message: "Bad credentials" } } });
    const adapter = createGitHubAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep });
    await expect(adapter.testConnection()).rejects.toMatchObject({ kind: "auth" });
    expect(fake.calls).toHaveLength(1);
  });

  it("gives up straight away when the reset is too far off (the poller retries later)", async () => {
    const fake = fakeGitHub({
      "GET /user": {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) },
        body: { message: "API rate limit exceeded" },
      },
    });
    const adapter = createGitHubAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep });
    await expect(adapter.testConnection()).rejects.toMatchObject({ kind: "rate_limited" });
    expect(fake.calls).toHaveLength(1);
  });

  it("reports rate-limit headers to the caller", async () => {
    const seen: unknown[] = [];
    const fake = fakeGitHub({
      "GET /user": { body: { login: "bot" }, headers: { "x-ratelimit-remaining": "4321", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1793000000" } },
    });
    const adapter = createGitHubAdapter({ token: "t", fetchImpl: fake.fetchImpl, onRateLimit: (r) => seen.push(r), ...noSleep });
    await adapter.testConnection();
    expect(seen).toEqual([{ remaining: 4321, limit: 5000, resetAt: new Date(1793000000 * 1000) }]);
  });
});

describe("GitHub adapter", () => {
  it("sends the token as a bearer header with the pinned API version, to api.github.com only", async () => {
    const fake = fakeGitHub({ "GET /user": { body: { login: "bot" } } });
    await createGitHubAdapter({ token: "ghp_secret", fetchImpl: fake.fetchImpl, ...noSleep }).testConnection();
    const call = fake.calls[0]!;
    expect(call.url.origin).toBe("https://api.github.com");
    expect(call.headers.get("authorization")).toBe("Bearer ghp_secret");
    expect(call.headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("normalizes commits: subject line only, unknown fields dropped, bounded page size", async () => {
    const fake = fakeGitHub({ "GET /repos/acme/site/commits": { body: [commitJson(1), commitJson(2)] } });
    const adapter = createGitHubAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep });
    const page = await adapter.listCommits(repo, { branch: "main", limit: 500 });
    expect(fake.calls[0]!.url.searchParams.get("per_page")).toBe("100");
    expect(fake.calls[0]!.url.searchParams.get("sha")).toBe("main");
    expect(page.items[0]).toMatchObject({ eventType: "commit", providerEventId: sha(1), commitSha: sha(1), title: "Commit 1", authorLogin: "dev", ref: "main" });
    expect(JSON.stringify(page.items)).not.toContain("extra_field_that_is_dropped");
    expect(page.truncated).toBe(false);
  });

  it("flags truncation from the Link header and caps open PRs at 100", async () => {
    const pulls = Array.from({ length: 100 }, (_, i) => pullJson(i + 1));
    const fake = fakeGitHub({
      "GET /repos/acme/site/pulls": { body: pulls, headers: { link: '<https://api.github.com/repos/acme/site/pulls?page=2>; rel="next"' } },
    });
    const page = await createGitHubAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep }).listOpenPullRequests(repo);
    expect(page.items).toHaveLength(100);
    expect(page.truncated).toBe(true);
    expect(fake.calls[0]!.url.searchParams.get("state")).toBe("open");
  });

  it("normalizes PR state, including merged", async () => {
    const fake = fakeGitHub({
      "GET /repos/acme/site/pulls": { body: [pullJson(1), pullJson(2, { state: "closed", merged_at: "2026-11-02T00:00:00Z" })] },
    });
    const page = await createGitHubAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep }).listOpenPullRequests(repo);
    expect(page.items.map((p) => p.state)).toEqual(["open", "merged"]);
    expect(page.items[0]).toMatchObject({ providerEventId: "1", ref: "main", snapshot: { headRef: "feature-1" } });
  });

  it("normalizes check runs and refuses short SHAs", async () => {
    const head = sha(7);
    const fake = fakeGitHub({
      [`GET /repos/acme/site/commits/${head}/check-runs`]: {
        body: { total_count: 2, check_runs: [checkRunJson(1, head), checkRunJson(2, head, { status: "in_progress", conclusion: null })] },
      },
    });
    const adapter = createGitHubAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep });
    const page = await adapter.listCheckRuns(repo, head);
    expect(page.items.map((c) => [c.title, c.state, c.conclusion])).toEqual([
      ["check-1", "completed", "success"],
      ["check-2", "in_progress", null],
    ]);
    expect(fake.calls[0]!.url.searchParams.get("filter")).toBe("latest");
    await expect(adapter.listCheckRuns(repo, "abc123")).rejects.toThrow(/full commit SHA/);
  });

  it("reports an empty repository and a missing branch without throwing (seen live)", async () => {
    const fake = fakeGitHub({
      "GET /repos/acme/site/commits": { status: 409, body: { message: "Git Repository is empty." } },
      "GET /repos/acme/site/branches/main": { status: 404, body: { message: "Branch not found" } },
    });
    const adapter = createGitHubAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep });
    expect(await adapter.listCommits(repo, { branch: "main", limit: 1 })).toEqual({ items: [], truncated: false, empty: true });
    expect(await adapter.getBranchHead(repo, "main")).toBeNull();
    expect(fake.calls).toHaveLength(2); // neither is retried
  });

  it("keeps slashes in branch paths and rejects malformed responses", async () => {
    const fake = fakeGitHub({
      "GET /repos/acme/site/branches/release/2026": { body: { name: "release/2026", commit: { sha: sha(3) } } },
      "GET /repos/acme/site": { body: { unexpected: true } },
    });
    const adapter = createGitHubAdapter({ token: "t", fetchImpl: fake.fetchImpl, ...noSleep });
    expect(await adapter.getBranchHead(repo, "release/2026")).toBe(sha(3));
    await expect(adapter.getRepository(repo)).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("webhook signatures", () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');

  it("accepts GitHub's sha256=<hex> HMAC of the raw body", () => {
    expect(verifySignature("s3cret", body, signBody("s3cret", body))).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, a missing or malformed header", () => {
    const good = signBody("s3cret", body);
    expect(verifySignature("other", body, good)).toBe(false);
    expect(verifySignature("s3cret", Buffer.from(body.toString() + " "), good)).toBe(false);
    expect(verifySignature("s3cret", body, null)).toBe(false);
    expect(verifySignature("s3cret", body, good.replace("sha256=", "sha1="))).toBe(false);
    expect(verifySignature("s3cret", body, "sha256=abc")).toBe(false);
  });

  it("backs off 30 s, 1 min, 2 min … up to an hour", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });
});

describe("integration settings", () => {
  it("only accepts env var names, and never SiteSync's own secrets", () => {
    expect(checkEnvVarName("GITHUB_TOKEN")).toBeNull();
    expect(checkEnvVarName("github_token")).toMatch(/capitals/);
    for (const reserved of ["DATABASE_OWNER_URL", "DATABASE_URL", "POSTGRES_PASSWORD", "SITESYNC_APP_PASSWORD", "PGPASSWORD", "PATH", "HOME"]) {
      expect(checkEnvVarName(reserved), reserved).toMatch(/reserved/);
    }
  });

  it("health follows §5.6", () => {
    expect(nextHealth("unconfigured", { ok: true }).health).toBe("ok");
    expect(nextHealth("ok", { ok: false, error: new ProviderError("auth", "401") }).health).toBe("error");
    expect(nextHealth("ok", { ok: false, error: new ProviderError("rate_limited", "429", 429, new Date(0)) }).health).toBe("degraded");
    expect(nextHealth("ok", { ok: false, error: new ProviderError("server", "502") }).health).toBe("degraded");
    expect(nextHealth("error", { ok: false, error: new ProviderError("server", "502") }).health).toBe("error");
    expect(nextHealth("ok", { ok: false, error: new MissingTokenError("GITHUB_TOKEN") }).health).toBe("unconfigured");
    expect(nextHealth("disabled", { ok: true }).health).toBe("disabled");
  });

  it("error details are redacted", () => {
    const detail = nextHealth("ok", { ok: false, error: new Error("failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789") }).detail;
    expect(detail).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
