import { describe, expect, it } from "vitest";
import { boundJson } from "@/server/audit";
import { describeError, redact, REDACTED, redactString } from "@/server/redact";

describe("redact", () => {
  it("removes sensitive keys at any depth, case-insensitively", () => {
    const input = {
      name: "ok",
      Authorization: "Bearer abc",
      nested: { apiKey: "k", api_key: "k", "api-key": "k", clientSecret: "s", list: [{ password: "p" }] },
      sessionId: "x",
      Cookie: "c",
      webhookSignature: "sig",
      accessToken: "t",
    };
    expect(redact(input)).toEqual({
      name: "ok",
      Authorization: REDACTED,
      nested: { apiKey: REDACTED, api_key: REDACTED, "api-key": REDACTED, clientSecret: REDACTED, list: [{ password: REDACTED }] },
      sessionId: REDACTED,
      Cookie: REDACTED,
      webhookSignature: REDACTED,
      accessToken: REDACTED,
    });
  });

  it("does not mutate its input", () => {
    const input = { password: "p" };
    redact(input);
    expect(input.password).toBe("p");
  });

  it("masks known token shapes inside strings", () => {
    const samples = [
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"B".repeat(22)}_${"c".repeat(59)}`,
      `gho_${"d".repeat(36)}`,
      `nfp_${"e".repeat(40)}`,
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl",
    ];
    for (const token of samples) {
      const out = redactString(`failed with ${token} today`);
      expect(out).not.toContain(token);
      expect(out).toContain(REDACTED);
    }
  });

  it("masks bearer credentials in free text", () => {
    expect(redactString("header was Bearer abcdef1234567890")).not.toContain("abcdef1234567890");
  });

  it("strips token-like query params and URL credentials", () => {
    const out = redactString(
      "see https://api.example.com/cb?code=abc123&state=keep&access_token=zzz&sig=qq and postgres://user:pw@127.0.0.1:5432/db",
    );
    expect(out).toContain("state=keep");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("zzz");
    expect(out).not.toContain("sig=qq");
    expect(out).not.toContain(":pw@");
  });

  it("leaves ordinary text alone", () => {
    expect(redactString("Deployed commit 4f2a to production")).toBe("Deployed commit 4f2a to production");
  });

  it("redacts error messages and handles non-plain values", () => {
    expect(describeError(new Error(`token ghp_${"x".repeat(36)} rejected`))).not.toContain("ghp_");
    expect(redact({ when: new Date("2026-01-01T00:00:00Z"), big: 10n, buf: Buffer.from("x") })).toEqual({
      when: "2026-01-01T00:00:00.000Z",
      big: "10",
      buf: "[BINARY]",
    });
  });
});

describe("boundJson", () => {
  it("redacts and passes small values through", () => {
    expect(boundJson({ a: 1, token: "x" })).toEqual({ a: 1, token: REDACTED });
    expect(boundJson(undefined)).toBeNull();
  });

  it("replaces oversized values with a truncation marker", () => {
    const out = boundJson({ blob: "x".repeat(20_000) }) as { _truncated: boolean };
    expect(out._truncated).toBe(true);
  });
});
