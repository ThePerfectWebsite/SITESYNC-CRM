// GitHub source adapter (spec §7.1). Read-only. Every response is Zod-parsed
// (unknown fields dropped) and normalized into repository-event records that
// both polling and webhooks store the same way.
import { z } from "zod";
import type { RepositoryEventType } from "../db/schema";
import type { FetchImpl } from "./fetch";
import { createHttpClient, hasNextPage, type RateLimit } from "./http";

export const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

// --- Normalized records ------------------------------------------------------

export type NormalizedEvent = {
  eventType: RepositoryEventType;
  providerEventId: string;
  commitSha: string | null;
  ref: string | null;
  title: string | null;
  authorLogin: string | null;
  state: string | null;
  conclusion: string | null;
  htmlUrl: string | null;
  occurredAt: Date;
  providerUpdatedAt: Date | null;
  snapshot: Record<string, unknown>;
};

export type Page<T> = { items: T[]; truncated: boolean };

const SHA = /^[0-9a-f]{40}$/;

const sha = (value: string | null | undefined) => (value && SHA.test(value) ? value : null);
const clip = (value: string | null | undefined, max: number) => (value ? value.slice(0, max) : null);
/** Only https links are kept (they're displayed, never fetched). */
const httpsUrl = (value: string | null | undefined) =>
  value && value.startsWith("https://") && value.length <= 2048 ? value : null;
const date = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const subject = (message: string | null | undefined) => clip(message?.split("\n", 1)[0]?.trim(), 300);

// --- Response schemas (only the fields we use) ----------------------------------

const userSchema = z.object({ login: z.string() }).nullish();

export const commitSchema = z.object({
  sha: z.string(),
  html_url: z.string().nullish(),
  commit: z.object({
    message: z.string().nullish(),
    author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish(),
    committer: z.object({ date: z.string().nullish() }).nullish(),
  }),
  author: userSchema,
});

export const pullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string().nullish(),
  state: z.string(),
  draft: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  html_url: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  user: userSchema,
  head: z.object({ sha: z.string(), ref: z.string().nullish() }),
  base: z.object({ ref: z.string() }),
});

export const checkRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullish(),
  html_url: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
});

export const checkSuiteSchema = z.object({
  id: z.number().int(),
  head_sha: z.string(),
  head_branch: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

const repoSchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  html_url: z.string().nullish(),
});

const branchSchema = z.object({ name: z.string(), commit: z.object({ sha: z.string() }) });

// --- Normalizers (shared with webhook processing) -------------------------------

export function normalizeCommit(input: z.output<typeof commitSchema>, ref: string | null): NormalizedEvent | null {
  const commitSha = sha(input.sha);
  if (!commitSha) return null;
  const when = date(input.commit.committer?.date) ?? date(input.commit.author?.date) ?? new Date(0);
  return {
    eventType: "commit",
    providerEventId: commitSha,
    commitSha,
    ref: clip(ref, 255),
    title: subject(input.commit.message),
    authorLogin: clip(input.author?.login ?? input.commit.author?.name, 100),
    state: null,
    conclusion: null,
    htmlUrl: httpsUrl(input.html_url),
    occurredAt: when,
    providerUpdatedAt: when,
    snapshot: { sha: commitSha, subject: subject(input.commit.message), author: input.author?.login ?? null },
  };
}

export function normalizePullRequest(input: z.output<typeof pullRequestSchema>): NormalizedEvent {
  const state = input.merged_at ? "merged" : input.state === "open" ? "open" : "closed";
  return {
    eventType: "pull_request",
    providerEventId: String(input.number),
    commitSha: sha(input.head.sha),
    ref: clip(input.base.ref, 255),
    title: clip(input.title, 300),
    authorLogin: clip(input.user?.login, 100),
    state,
    conclusion: null,
    htmlUrl: httpsUrl(input.html_url),
    occurredAt: date(input.created_at) ?? new Date(0),
    providerUpdatedAt: date(input.updated_at) ?? date(input.created_at),
    snapshot: {
      number: input.number,
      draft: input.draft ?? false,
      baseRef: input.base.ref,
      headRef: input.head.ref ?? null,
      headSha: sha(input.head.sha),
    },
  };
}

export function normalizeCheckRun(input: z.output<typeof checkRunSchema>): NormalizedEvent {
  const updated = date(input.completed_at) ?? date(input.started_at);
  return {
    eventType: "check_run",
    providerEventId: String(input.id),
    commitSha: sha(input.head_sha),
    ref: null,
    title: clip(input.name, 300),
    authorLogin: null,
    state: clip(input.status, 30),
    conclusion: clip(input.conclusion, 30),
    htmlUrl: httpsUrl(input.html_url),
    occurredAt: date(input.started_at) ?? updated ?? new Date(0),
    providerUpdatedAt: updated,
    snapshot: { id: input.id, name: input.name, status: input.status, conclusion: input.conclusion ?? null },
  };
}

export function normalizeCheckSuite(input: z.output<typeof checkSuiteSchema>): NormalizedEvent {
  return {
    eventType: "check_suite",
    providerEventId: String(input.id),
    commitSha: sha(input.head_sha),
    ref: clip(input.head_branch, 255),
    title: null,
    authorLogin: null,
    state: clip(input.status, 30),
    conclusion: clip(input.conclusion, 30),
    htmlUrl: null,
    occurredAt: date(input.created_at) ?? date(input.updated_at) ?? new Date(0),
    providerUpdatedAt: date(input.updated_at),
    snapshot: { id: input.id, status: input.status ?? null, conclusion: input.conclusion ?? null },
  };
}

// --- Adapter -----------------------------------------------------------------

export type RepoRef = { owner: string; repo: string };
export type RepoInfo = { providerRepoId: string; fullName: string; defaultBranch: string; private: boolean };
export type ConnectionResult = { ok: true; login: string; rateLimit: RateLimit | null } | { ok: false; error: string };

export interface SourceAdapter {
  testConnection(): Promise<{ login: string }>;
  getRepository(repo: RepoRef): Promise<RepoInfo>;
  listCommits(repo: RepoRef, options: { branch: string; since?: Date; limit: number }): Promise<Page<NormalizedEvent>>;
  listOpenPullRequests(repo: RepoRef): Promise<Page<NormalizedEvent>>;
  listCheckRuns(repo: RepoRef, commitSha: string): Promise<Page<NormalizedEvent>>;
  getBranchHead(repo: RepoRef, branch: string): Promise<string>;
}

export type GitHubAdapterOptions = {
  token: string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRateLimit?: (rateLimit: RateLimit) => void;
};

const MAX_PER_PAGE = 100;
const repoPath = ({ owner, repo }: RepoRef) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export function createGitHubAdapter(options: GitHubAdapterOptions): SourceAdapter {
  const client = createHttpClient({
    baseUrl: GITHUB_API,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "SiteSync-Control-Centre",
    },
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    random: options.random,
    now: options.now,
    onRateLimit: options.onRateLimit,
  });

  return {
    async testConnection() {
      const { data } = await client.getJson("/user", z.object({ login: z.string() }));
      return { login: data.login };
    },

    async getRepository(repo) {
      const { data } = await client.getJson(repoPath(repo), repoSchema);
      return {
        providerRepoId: String(data.id),
        fullName: data.full_name,
        defaultBranch: data.default_branch,
        private: data.private,
      };
    },

    async listCommits(repo, { branch, since, limit }) {
      const perPage = Math.min(Math.max(limit, 1), MAX_PER_PAGE);
      const { data, response } = await client.getJson(`${repoPath(repo)}/commits`, z.array(commitSchema), {
        sha: branch,
        per_page: perPage,
        since: since?.toISOString(),
      });
      const items = data
        .slice(0, perPage)
        .map((commit) => normalizeCommit(commit, branch))
        .filter((e): e is NormalizedEvent => e !== null);
      return { items, truncated: hasNextPage(response.headers) };
    },

    async listOpenPullRequests(repo) {
      const { data, response } = await client.getJson(`${repoPath(repo)}/pulls`, z.array(pullRequestSchema), {
        state: "open",
        per_page: MAX_PER_PAGE,
        sort: "updated",
        direction: "desc",
      });
      return { items: data.slice(0, MAX_PER_PAGE).map(normalizePullRequest), truncated: hasNextPage(response.headers) };
    },

    async listCheckRuns(repo, commitSha) {
      if (!SHA.test(commitSha)) throw new Error("listCheckRuns needs a full commit SHA");
      const { data, response } = await client.getJson(
        `${repoPath(repo)}/commits/${commitSha}/check-runs`,
        z.object({ total_count: z.number().int(), check_runs: z.array(checkRunSchema) }),
        { per_page: MAX_PER_PAGE, filter: "latest" },
      );
      return {
        items: data.check_runs.slice(0, MAX_PER_PAGE).map(normalizeCheckRun),
        truncated: hasNextPage(response.headers) || data.total_count > data.check_runs.length,
      };
    },

    async getBranchHead(repo, branch) {
      const path = branch.split("/").map(encodeURIComponent).join("/");
      const { data } = await client.getJson(`${repoPath(repo)}/branches/${path}`, branchSchema);
      if (!SHA.test(data.commit.sha)) throw new Error("branch head is not a full SHA");
      return data.commit.sha;
    },
  };
}
