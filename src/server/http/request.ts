import "server-only";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { headers } from "next/headers";
import type { RequestMeta } from "../auth/service";

/** Best-effort client info for audit/session records (informational only, never trusted for auth). */
export async function requestMeta(): Promise<Required<RequestMeta>> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return {
    userAgent: h.get("user-agent")?.slice(0, 512) ?? null,
    ip: isIP(forwarded) ? forwarded : null,
    requestId: randomUUID(),
  };
}
