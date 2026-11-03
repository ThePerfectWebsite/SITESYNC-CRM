// Pure env parsing (no server-only import) so scripts and unit tests can use it.
import { z } from "zod";

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/[^\s]+$/, "must be a postgres:// connection URL");

const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.origin === value;
  }, "must be an origin only (scheme://host[:port]), no path or trailing slash");

const booleanFlag = z
  .enum(["true", "false", ""])
  .optional()
  .transform((value) => value === "true");

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value ? value : undefined));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    DATABASE_URL: postgresUrl,
    SITESYNC_APP_ORIGIN: origin.default("http://127.0.0.1:3000"),
    SITESYNC_LAN_MODE: booleanFlag,
    SITESYNC_PUBLIC_ORIGIN: optionalString.pipe(origin.optional()),
  })
  .superRefine((env, ctx) => {
    // LAN mode only takes effect when both values are set, and only over HTTPS
    // (an operator-run reverse proxy). Misconfiguration fails loudly rather than
    // silently falling back.
    if (env.SITESYNC_LAN_MODE) {
      if (!env.SITESYNC_PUBLIC_ORIGIN) {
        ctx.addIssue({
          code: "custom",
          path: ["SITESYNC_PUBLIC_ORIGIN"],
          message: "required when SITESYNC_LAN_MODE=true",
        });
      } else if (!env.SITESYNC_PUBLIC_ORIGIN.startsWith("https://")) {
        ctx.addIssue({
          code: "custom",
          path: ["SITESYNC_PUBLIC_ORIGIN"],
          message: "must be https:// in LAN mode",
        });
      }
    }
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    lanMode: env.SITESYNC_LAN_MODE,
    /** The origin browsers use to reach the app; mutating Route Handlers require it. */
    appOrigin:
      env.SITESYNC_LAN_MODE && env.SITESYNC_PUBLIC_ORIGIN
        ? env.SITESYNC_PUBLIC_ORIGIN
        : env.SITESYNC_APP_ORIGIN,
  }));

export type Env = z.output<typeof envSchema>;

/** Parses env vars; on failure the error lists variable names only, never values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(env)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${problems}`);
  }
  return result.data;
}
