import { describe, expect, it } from "vitest";
import { parseEnv } from "@/server/env-schema";

const base = { DATABASE_URL: "postgres://sitesync_app:secretvalue@127.0.0.1:5432/sitesync" };

describe("parseEnv", () => {
  it("applies local defaults", () => {
    const env = parseEnv(base);
    expect(env.appOrigin).toBe("http://127.0.0.1:3000");
    expect(env.lanMode).toBe(false);
    expect(env.nodeEnv).toBe("development");
  });

  it("requires a postgres DATABASE_URL", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  it("never echoes values in errors", () => {
    try {
      parseEnv({ DATABASE_URL: "not-a-url-with-SECRETVALUE" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("SECRETVALUE");
    }
  });

  it("rejects an app origin with a path or trailing slash", () => {
    expect(() => parseEnv({ ...base, SITESYNC_APP_ORIGIN: "http://127.0.0.1:3000/" })).toThrow(
      /SITESYNC_APP_ORIGIN/,
    );
    expect(() => parseEnv({ ...base, SITESYNC_APP_ORIGIN: "http://127.0.0.1:3000/app" })).toThrow();
  });

  it("uses the public origin only in LAN mode", () => {
    const off = parseEnv({ ...base, SITESYNC_PUBLIC_ORIGIN: "https://sitesync.lan" });
    expect(off.appOrigin).toBe("http://127.0.0.1:3000");
    const on = parseEnv({ ...base, SITESYNC_LAN_MODE: "true", SITESYNC_PUBLIC_ORIGIN: "https://sitesync.lan" });
    expect(on.lanMode).toBe(true);
    expect(on.appOrigin).toBe("https://sitesync.lan");
  });

  it("refuses LAN mode without an https public origin", () => {
    expect(() => parseEnv({ ...base, SITESYNC_LAN_MODE: "true" })).toThrow(/SITESYNC_PUBLIC_ORIGIN/);
    expect(() =>
      parseEnv({ ...base, SITESYNC_LAN_MODE: "true", SITESYNC_PUBLIC_ORIGIN: "http://sitesync.lan" }),
    ).toThrow(/https/);
  });

  it("treats an empty LAN flag as off", () => {
    expect(parseEnv({ ...base, SITESYNC_LAN_MODE: "", SITESYNC_PUBLIC_ORIGIN: "" }).lanMode).toBe(false);
  });
});
