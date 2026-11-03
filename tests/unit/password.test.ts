import { describe, expect, it } from "vitest";
import {
  checkPasswordPolicy,
  CURRENT_SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@/server/auth/password";

const WEAK = { N: 1024, r: 8, p: 1, keylen: 64 };

describe("scrypt password hashing", () => {
  it("hashes with current params, a 16-byte salt and a 64-byte key", async () => {
    const record = await hashPassword("a long enough passphrase");
    expect(record.params).toEqual({ N: 131072, r: 8, p: 1, keylen: 64 });
    expect(Buffer.from(record.salt, "base64")).toHaveLength(16);
    expect(Buffer.from(record.hash, "base64")).toHaveLength(64);
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const record = await hashPassword("correct passphrase here");
    await expect(verifyPassword("correct passphrase here", record)).resolves.toBe(true);
    await expect(verifyPassword("correct passphrase herE", record)).resolves.toBe(false);
  });

  it("uses a fresh salt each time", async () => {
    const a = await hashPassword("same password twice", WEAK);
    const b = await hashPassword("same password twice", WEAK);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.hash).not.toEqual(b.hash);
  });

  it("verifies with the params stored on the record, so old hashes still work", async () => {
    const old = await hashPassword("legacy password value", WEAK);
    await expect(verifyPassword("legacy password value", old)).resolves.toBe(true);
  });

  it("flags weaker params for rehash and current params as fine", () => {
    expect(needsRehash(WEAK)).toBe(true);
    expect(needsRehash({ ...CURRENT_SCRYPT_PARAMS, r: 4 })).toBe(true);
    expect(needsRehash(CURRENT_SCRYPT_PARAMS)).toBe(false);
  });

  it("rejects a tampered hash of a different length", async () => {
    const record = await hashPassword("tamper test password", WEAK);
    const truncated = { ...record, hash: Buffer.from(record.hash, "base64").subarray(0, 32).toString("base64") };
    await expect(verifyPassword("tamper test password", truncated)).resolves.toBe(false);
  });
});

describe("password policy", () => {
  it("requires 12 to 256 characters", () => {
    expect(checkPasswordPolicy("short pass1")).toMatch(/at least 12/);
    expect(checkPasswordPolicy("x".repeat(257))).toMatch(/at most 256/);
    expect(checkPasswordPolicy("twelve chars")).toBeNull();
  });

  it("rejects common passwords case-insensitively", () => {
    expect(checkPasswordPolicy("Password1234")).toMatch(/too common/);
    expect(checkPasswordPolicy("QWERTY123456")).toMatch(/too common/);
  });

  it("has no composition rules", () => {
    expect(checkPasswordPolicy("all lowercase words here")).toBeNull();
  });
});
