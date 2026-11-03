// A scripted stand-in for api.github.com: routes match method + path (query
// ignored unless the route checks it); every call is recorded. Unmatched calls
// throw, so a test can't silently depend on a route it didn't set up.
import type { FetchImpl } from "@/server/providers/fetch";

export type FakeReply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (url: URL, init: RequestInit) => FakeReply | Promise<FakeReply>;

export function fakeGitHub(routes: Record<string, FakeReply | FakeReply[] | Handler>) {
  const calls: { method: string; url: URL; headers: Headers }[] = [];
  const queues = new Map<string, FakeReply[]>();
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, url, headers: new Headers(init.headers) });
    const key = `${method} ${url.pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`fake GitHub has no route for ${key}`);
    let reply: FakeReply;
    if (typeof route === "function") reply = await route(url, init);
    else if (Array.isArray(route)) {
      // A list replies in order, repeating the last entry.
      const queue = queues.get(key) ?? [...route];
      queues.set(key, queue);
      reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    } else reply = route;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetchImpl, calls };
}

export const sha = (n: number) => n.toString(16).padStart(40, "0");

export function commitJson(n: number, date = `2026-11-0${(n % 9) + 1}T10:00:00Z`) {
  return {
    sha: sha(n),
    html_url: `https://github.com/acme/site/commit/${sha(n)}`,
    commit: { message: `Commit ${n}\n\nBody text`, author: { name: "Dev", date }, committer: { date } },
    author: { login: "dev" },
    extra_field_that_is_dropped: { secret: "x" },
  };
}

export function pullJson(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: "open",
    draft: false,
    merged_at: null,
    html_url: `https://github.com/acme/site/pull/${number}`,
    created_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-02T09:00:00Z",
    user: { login: "dev" },
    head: { sha: sha(900 + number), ref: `feature-${number}` },
    base: { ref: "main" },
    ...overrides,
  };
}

export function checkRunJson(id: number, headSha: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `check-${id}`,
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/acme/site/runs/${id}`,
    started_at: "2026-11-02T10:00:00Z",
    completed_at: "2026-11-02T10:05:00Z",
    ...overrides,
  };
}

/** Routes for a healthy repo acme/site on branch main with `head` and the given commits/PRs/checks. */
export function healthyRepo(options: {
  head: string;
  commits: unknown[];
  pulls?: unknown[];
  checks?: (sha: string) => unknown[];
  rateRemaining?: number;
}) {
  const rate = {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(options.rateRemaining ?? 4990),
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  };
  return {
    "GET /user": { body: { login: "sitesync-bot" }, headers: rate },
    "GET /repos/acme/site": { body: { id: 123456, full_name: "acme/site", default_branch: "main", private: true }, headers: rate },
    "GET /repos/acme/site/branches/main": { body: { name: "main", commit: { sha: options.head } }, headers: rate },
    "GET /repos/acme/site/commits": { body: options.commits, headers: rate },
    "GET /repos/acme/site/pulls": { body: options.pulls ?? [], headers: rate },
    ...Object.fromEntries(
      [options.head, ...options.commits.map((c) => (c as { sha: string }).sha)].map((s) => [
        `GET /repos/acme/site/commits/${s}/check-runs`,
        { body: { total_count: options.checks?.(s).length ?? 0, check_runs: options.checks?.(s) ?? [] }, headers: rate },
      ]),
    ),
  } satisfies Record<string, FakeReply>;
}
