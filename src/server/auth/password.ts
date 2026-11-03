// scrypt password hashing (spec §3.1). Pure — no DB access.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { ScryptParams } from "../db/schema";
import { isCommonPassword } from "./common-passwords";

export const CURRENT_SCRYPT_PARAMS: ScryptParams = { N: 131072, r: 8, p: 1, keylen: 64 };
const MAXMEM = 256 * 1024 * 1024;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export type PasswordRecord = { hash: string; salt: string; params: ScryptParams };

function scryptAsync(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, params.keylen, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(
  password: string,
  params: ScryptParams = CURRENT_SCRYPT_PARAMS,
): Promise<PasswordRecord> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, params);
  return { hash: key.toString("base64"), salt: salt.toString("base64"), params };
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const expected = Buffer.from(record.hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(record.salt, "base64"), record.params);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a stored hash used weaker params than current; rehash after a successful login. */
export function needsRehash(params: ScryptParams): boolean {
  const current = CURRENT_SCRYPT_PARAMS;
  return (
    params.N < current.N || params.r < current.r || params.p < current.p || params.keylen < current.keylen
  );
}

/** Spec policy: 12–256 characters, not a common password, no composition rules. */
export function checkPasswordPolicy(password: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (isCommonPassword(password)) return "That password is too common. Choose something less guessable.";
  return null;
}

// Verified against when no user matches, so unknown emails take as long as wrong passwords.
let dummyRecord: Promise<PasswordRecord> | undefined;
export function dummyPasswordRecord(): Promise<PasswordRecord> {
  dummyRecord ??= hashPassword(randomBytes(24).toString("base64"));
  return dummyRecord;
}
