import { describe, expect, it } from "vitest";
import { hashSessionToken } from "@/server/auth/session";
import { requiredDelaySeconds } from "@/server/auth/throttle";
import { buildCsp, generateNonce } from "@/server/http/csp";
import { isSameOrigin, rejectCrossOrigin } from "@/server/http/origin";

const APP = "http://127.0.0.1:3000";

describe("Origin check", () => {
  it("accepts an exact Origin match", () => {
    expect(isSameOrigin(new Headers({ origin: APP }), APP)).toBe(true);
  });

  it("rejects other origins, ports, schemes and the opaque 'null' origin", () => {
    for (const origin of ["http://evil.test", "http://127.0.0.1:3001", "https://127.0.0.1:3000", "http://localhost:3000", "null"]) {
      expect(isSameOrigin(new Headers({ origin }), APP)).toBe(false);
    }
  });

  it("prefers Origin over Referer when both are present", () => {
    expect(isSameOrigin(new Headers({ origin: "http://evil.test", referer: `${APP}/` }), APP)).toBe(false);
  });

  it("falls back to the Referer's origin", () => {
    expect(isSameOrigin(new Headers({ referer: `${APP}/projects?x=1` }), APP)).toBe(true);
    expect(isSameOrigin(new Headers({ referer: "http://evil.test/127.0.0.1:3000" }), APP)).toBe(false);
    expect(isSameOrigin(new Headers({ referer: "not a url" }), APP)).toBe(false);
  });

  it("rejects requests with neither header", () => {
    expect(isSameOrigin(new Headers(), APP)).toBe(false);
  });

  it("returns a 403 response when rejecting", async () => {
    const response = rejectCrossOrigin(new Request(`${APP}/logout`, { method: "POST", headers: { origin: "http://evil.test" } }), APP);
    expect(response?.status).toBe(403);
    expect(rejectCrossOrigin(new Request(`${APP}/logout`, { method: "POST", headers: { origin: APP } }), APP)).toBeNull();
  });
});

describe("CSP", () => {
  it("uses a nonce for scripts and blocks framing, objects and foreign forms", () => {
    const csp = buildCsp("abc123", false);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("default-src 'self'");
  });

  it("allows eval only in development", () => {
    expect(buildCsp("n", true)).toContain("'unsafe-eval'");
  });

  it("generates distinct nonces", () => {
    expect(generateNonce()).not.toEqual(generateNonce());
  });
});

describe("session token decoding", () => {
  it("accepts only 32-byte base64url tokens", () => {
    const token = Buffer.alloc(32, 7).toString("base64url");
    expect(hashSessionToken(token)).toHaveLength(32);
    expect(hashSessionToken("short")).toBeNull();
    expect(hashSessionToken(`${token}x`)).toBeNull();
    expect(hashSessionToken(token.replace(/.$/, "+"))).toBeNull();
  });
});

describe("throttle delay", () => {
  it("is free for the first five failures, then doubles from 1 s, capped at 60 s", () => {
    expect([0, 4].map(requiredDelaySeconds)).toEqual([0, 0]);
    expect([5, 6, 7, 8, 10, 11, 50].map(requiredDelaySeconds)).toEqual([1, 2, 4, 8, 32, 60, 60]);
  });
});
