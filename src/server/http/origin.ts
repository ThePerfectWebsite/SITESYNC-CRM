// Origin check for mutating Route Handlers (spec §4). Server Actions rely on
// Next.js's built-in Origin/Host check instead. Pure — unit tested.

/**
 * True only when the request's Origin (or, if absent, Referer) has exactly the
 * allowed origin. Requests carrying neither header are rejected.
 */
export function isSameOrigin(headers: Headers, allowedOrigin: string): boolean {
  const origin = headers.get("origin");
  if (origin !== null) return origin === allowedOrigin;
  const referer = headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === allowedOrigin;
  } catch {
    return false;
  }
}

/** Returns a 403 response for cross-origin requests, or null to continue. */
export function rejectCrossOrigin(request: Request, allowedOrigin: string): Response | null {
  if (isSameOrigin(request.headers, allowedOrigin)) return null;
  return new Response("Cross-origin request rejected.", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
