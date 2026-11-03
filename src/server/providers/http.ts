// JSON requests to provider APIs (spec §7.1): Zod-parsed responses, rate-limit
// headers reported to the caller, retries on 429/5xx/secondary limits with
// exponential backoff + jitter that respects Retry-After and reset headers
// (max 5 attempts), and no retries on auth errors.
import type { z } from "zod";
import { redactString } from "../redact";
import { BlockedRequestError, providerFetch, type FetchImpl } from "./fetch";

export type ProviderErrorKind =
  | "auth" // 401, or 403 that isn't a rate limit: bad/expired token or missing permission
  | "not_found"
  | "rate_limited"
  | "server"
  | "network"
  | "invalid_response"
  | "blocked"
  | "client";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    /** For rate limits: when it's worth trying again. */
    readonly retryAt?: Date,
  ) {
    super(redactString(message));
    this.name = "ProviderError";
  }
}

export type RateLimit = { remaining: number | null; limit: number | null; resetAt: Date | null };

export type HttpClientOptions = {
  baseUrl: string;
  headers: Record<string, string>;
  fetchImpl?: FetchImpl;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRateLimit?: (rateLimit: RateLimit) => void;
  maxAttempts?: number;
  /** Never wait longer than this for one retry; beyond it, give up as rate_limited. */
  maxRetryWaitMs?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function readRateLimit(headers: Headers): RateLimit {
  const num = (name: string) => {
    const value = headers.get(name);
    if (value === null || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const reset = num("x-ratelimit-reset");
  return {
    remaining: num("x-ratelimit-remaining"),
    limit: num("x-ratelimit-limit"),
    resetAt: reset === null ? null : new Date(reset * 1000),
  };
}

/** Pulls the "message" field out of an error body, if there is one. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 2000);
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      /* not JSON */
    }
    return text || response.statusText;
  } catch {
    return response.statusText;
  }
}

/**
 * Classifies a failed response. GitHub signals rate limits with 403 or 429:
 * a primary limit has x-ratelimit-remaining: 0, a secondary limit says so in
 * the message and usually sends Retry-After. Any other 403 is a permission problem.
 */
export function classifyFailure(
  status: number,
  headers: Headers,
  message: string,
  now: number,
): { kind: ProviderErrorKind; retryAt?: Date } {
  const rate = readRateLimit(headers);
  const retryAfter = Number(headers.get("retry-after"));
  const retryAfterAt = Number.isFinite(retryAfter) && retryAfter >= 0 && headers.has("retry-after")
    ? new Date(now + retryAfter * 1000)
    : undefined;
  const secondary = /secondary rate limit|abuse detection/i.test(message);
  if (status === 429 || ((status === 403 || status === 429) && (rate.remaining === 0 || secondary || retryAfterAt))) {
    // No Retry-After and remaining 0: wait for the reset. Otherwise at least a minute.
    const retryAt = retryAfterAt ?? (rate.remaining === 0 && rate.resetAt ? rate.resetAt : new Date(now + 60_000));
    return { kind: "rate_limited", retryAt };
  }
  if (status === 401 || status === 403) return { kind: "auth" };
  if (status === 404) return { kind: "not_found" };
  if (status >= 500) return { kind: "server" };
  return { kind: "client" };
}

export function createHttpClient(options: HttpClientOptions) {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? 5;
  const maxRetryWaitMs = options.maxRetryWaitMs ?? 120_000;

  async function request(path: string, query: Record<string, string | number | undefined> = {}) {
    const url = new URL(path, options.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: ProviderError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await providerFetch(url.toString(), { method: "GET", headers: options.headers }, { fetchImpl: options.fetchImpl });
      } catch (error) {
        if (error instanceof BlockedRequestError) throw new ProviderError("blocked", error.message);
        lastError = new ProviderError("network", error instanceof Error ? error.message : "network error");
        if (attempt < maxAttempts) await sleep(backoff(attempt));
        continue;
      }

      const rateLimit = readRateLimit(response.headers);
      if (rateLimit.remaining !== null || rateLimit.resetAt !== null) options.onRateLimit?.(rateLimit);
      if (response.ok) return response;

      const message = await errorMessage(response);
      const { kind, retryAt } = classifyFailure(response.status, response.headers, message, now());
      lastError = new ProviderError(kind, `${response.status} ${message}`, response.status, retryAt);

      const retryable = kind === "rate_limited" || kind === "server";
      if (!retryable || attempt === maxAttempts) throw lastError;
      const waitMs = retryAt ? Math.max(0, retryAt.getTime() - now()) + jitter() : backoff(attempt);
      if (waitMs > maxRetryWaitMs) throw lastError; // the poller tries again after the reset
      await sleep(waitMs);
    }
    throw lastError ?? new ProviderError("network", "request failed");
  }

  /** Exponential backoff with jitter: ~1 s, 2 s, 4 s, 8 s (+ up to 1 s). */
  function backoff(attempt: number): number {
    return 1000 * 2 ** (attempt - 1) + jitter();
  }

  function jitter(): number {
    return Math.floor(random() * 1000);
  }

  async function getJson<S extends z.ZodType>(
    path: string,
    schema: S,
    query?: Record<string, string | number | undefined>,
  ): Promise<{ data: z.output<S>; response: Response }> {
    const response = await request(path, query);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderError("invalid_response", `${path}: response was not JSON`, response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError("invalid_response", `${path}: unexpected response shape`, response.status);
    }
    return { data: parsed.data, response };
  }

  return { request, getJson };
}

/** True if a Link header says there are more pages. */
export function hasNextPage(headers: Headers): boolean {
  return /<[^>]+>;\s*rel="next"/.test(headers.get("link") ?? "");
}
