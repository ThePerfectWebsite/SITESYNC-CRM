import "server-only";
import { parseEnv, type Env } from "./env-schema";

let cached: Env | undefined;

/** Server-only, Zod-validated environment. Parsed lazily so builds don't need DB secrets. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
