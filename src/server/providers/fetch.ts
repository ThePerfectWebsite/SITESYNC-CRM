// The only way SiteSync talks to the outside world (spec §4 "Outbound HTTP").
// https only, three provider API hosts only, 10 s timeout, redirects followed
// only when they stay on the same allowlisted host. User-supplied URLs are
// never fetched.

export const ALLOWED_PROVIDER_HOSTS = new Set(["api.github.com", "api.netlify.com", "api.vercel.com"]);

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export class BlockedRequestError extends Error {
  constructor(reason: string) {
    super(`Blocked outbound request: ${reason}`);
    this.name = "BlockedRequestError";
  }
}

/** Throws unless `url` is https on an allowlisted provider host (no credentials, default port). */
export function assertAllowedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedRequestError("not a valid URL");
  }
  if (parsed.protocol !== "https:") throw new BlockedRequestError("only https is allowed");
  if (parsed.username || parsed.password) throw new BlockedRequestError("credentials in URL");
  if (parsed.port && parsed.port !== "443") throw new BlockedRequestError("non-default port");
  if (!ALLOWED_PROVIDER_HOSTS.has(parsed.hostname)) {
    throw new BlockedRequestError(`host ${parsed.hostname} is not an allowed provider API`);
  }
  return parsed;
}

export async function providerFetch(
  url: string,
  init: RequestInit = {},
  options: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? ((input, requestInit) => fetch(input, requestInit));
  let current = assertAllowedUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current.toString(), {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
    if (response.status < 300 || response.status >= 400 || response.status === 304) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    const next = assertAllowedUrl(new URL(location, current).toString());
    if (next.hostname !== current.hostname) {
      throw new BlockedRequestError(`redirect to another host (${next.hostname})`);
    }
    current = next;
  }
  throw new BlockedRequestError("too many redirects");
}
