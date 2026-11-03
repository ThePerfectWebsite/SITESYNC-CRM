// Integrations (spec §3.18, §5.6). Only env var *names* are stored; values are
// read from the server's environment when a request is made and never shown,
// logged or stored.
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx } from "../db/client";
import { integrations, repositoryLinks, type IntegrationHealth } from "../db/schema";
import { createGitHubAdapter, type SourceAdapter } from "../providers/github";
import { createHostingAdapter, type HostingAdapter } from "../providers/hosting";
import { ProviderError, type RateLimit } from "../providers/http";
import type { FetchImpl } from "../providers/fetch";
import { describeError, redactString } from "../redact";
import { auditActor, type Actor } from "../records/actor";
import { DomainError, invalidField, isUniqueViolation, notFound, parseInput, type RawInput } from "../records/errors";
import { optionalText, requiredText } from "../records/fields";

const ENV_VAR = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Env vars an integration may never point at: SiteSync's own configuration and
 * secrets. A token is sent to the provider as a bearer token, so pointing it at
 * e.g. DATABASE_OWNER_URL would leak the database password to GitHub.
 */
const RESERVED_ENV_VAR = /^(DATABASE_|POSTGRES_|SITESYNC_|PG|NODE_|NEXT_|PATH$|HOME$|USER(NAME)?$|SHELL$|TEMP$|TMP$)/;

export function checkEnvVarName(value: string): string | null {
  if (!ENV_VAR.test(value)) return "Use an env var name like GITHUB_TOKEN (capitals, digits, underscores).";
  if (RESERVED_ENV_VAR.test(value)) return "That name is reserved for SiteSync's own settings. Choose another, e.g. GITHUB_TOKEN.";
  return null;
}

const envVarName = (label: string) =>
  z
    .string({ message: `Enter ${label}.` })
    .trim()
    .min(1, `Enter ${label}.`)
    .superRefine((value, ctx) => {
      const problem = checkEnvVarName(value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });

const checkbox = z
  .union([z.boolean(), z.literal("on"), z.literal(""), z.null()])
  .optional()
  .transform((value) => value === true || value === "on");

export const integrationSchema = z
  .object({
    name: requiredText("a name", 100),
    tokenEnvVar: envVarName("the token's env var name"),
    accountRef: optionalText(200),
    pollEnabled: checkbox,
    webhookEnabled: checkbox,
    webhookSecretEnvVar: z
      .string()
      .trim()
      .nullish()
      .transform((value) => (value ? value : null)),
  })
  .superRefine((value, ctx) => {
    if (value.webhookSecretEnvVar) {
      const problem = checkEnvVarName(value.webhookSecretEnvVar);
      if (problem) ctx.addIssue({ code: "custom", path: ["webhookSecretEnvVar"], message: problem });
    }
    if (value.webhookEnabled && !value.webhookSecretEnvVar) {
      ctx.addIssue({
        code: "custom",
        path: ["webhookSecretEnvVar"],
        message: "Webhooks need the env var name of their secret.",
      });
    }
  });

export const newIntegrationSchema = z.object({
  provider: z.enum(["github", "netlify", "vercel", "cloudflare"], { message: "Choose a provider." }),
});

export const PROVIDER_LABELS = { github: "GitHub", netlify: "Netlify", vercel: "Vercel", cloudflare: "Cloudflare" } as const;

export type IntegrationInput = RawInput<typeof integrationSchema>;
type IntegrationRow = typeof integrations.$inferSelect;

/** The value of an env var, or null if unset/blank. Never log or return this to a client. */
export function readSecret(name: string | null | undefined): string | null {
  if (!name || checkEnvVarName(name)) return null;
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function snapshot(row: IntegrationRow) {
  return {
    provider: row.provider,
    name: row.name,
    tokenEnvVar: row.tokenEnvVar,
    accountRef: row.accountRef,
    pollEnabled: row.pollEnabled,
    webhookEnabled: row.webhookEnabled,
    webhookSecretEnvVar: row.webhookSecretEnvVar,
  };
}

const nameTaken = () => invalidField("name", "Another integration for this provider uses this name.");

/** Cloudflare API paths are per account, so its integrations need a valid account ID. */
function checkAccountRef(provider: string, accountRef: string | null) {
  if (provider === "cloudflare" && !/^[0-9a-f]{32}$/i.test(accountRef ?? "")) {
    throw invalidField("accountRef", "Enter your Cloudflare account ID (32 characters, from the dashboard URL or overview page).");
  }
}

export async function createIntegration(
  db: Db,
  actor: Actor,
  input: IntegrationInput & { provider?: unknown },
): Promise<string> {
  const { provider } = parseInput(newIntegrationSchema, input);
  const data = parseInput(integrationSchema, input);
  checkAccountRef(provider, data.accountRef);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(integrations)
        .values({ provider, ...data, health: "unconfigured" })
        .returning();
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "integration.created",
        subjectType: "integration",
        subjectId: row!.id,
        summary: `${PROVIDER_LABELS[provider]} integration ${row!.name} added`,
        after: snapshot(row!),
        requestId: actor.requestId,
      });
      return row!.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, "integrations_name_live_key")) throw nameTaken();
    throw error;
  }
}

async function lockIntegration(db: DbOrTx, id: string) {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, id)).for("update");
  if (!row) throw notFound("Integration");
  return row;
}

export async function updateIntegration(db: Db, actor: Actor, id: string, input: IntegrationInput): Promise<void> {
  const data = parseInput(integrationSchema, input);
  try {
    await db.transaction(async (tx) => {
      const before = await lockIntegration(tx, id);
      checkAccountRef(before.provider, data.accountRef);
      if (before.archivedAt) throw new DomainError("conflict", "Restore this integration before editing it.");
      // A changed token env var invalidates the last test.
      const tokenChanged = data.tokenEnvVar !== before.tokenEnvVar;
      const [after] = await tx
        .update(integrations)
        .set({
          ...data,
          ...(tokenChanged && before.health !== "disabled" ? { health: "unconfigured" as const, healthDetail: null } : {}),
        })
        .where(eq(integrations.id, id))
        .returning();
      await writeAudit(tx, {
        actor: auditActor(actor),
        action: "integration.updated",
        subjectType: "integration",
        subjectId: id,
        summary: `Integration ${after!.name} updated`,
        before: snapshot(before),
        after: snapshot(after!),
        requestId: actor.requestId,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "integrations_name_live_key")) throw nameTaken();
    throw error;
  }
}

/** Operator switch (§5.6): a disabled integration is never polled or called. */
export async function setIntegrationDisabled(db: Db, actor: Actor, id: string, disabled: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockIntegration(tx, id);
    if ((row.health === "disabled") === disabled) return;
    await tx
      .update(integrations)
      .set({ health: disabled ? "disabled" : "unconfigured", healthDetail: disabled ? "Disabled by the operator." : null })
      .where(eq(integrations.id, id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: disabled ? "integration.disabled" : "integration.enabled",
      subjectType: "integration",
      subjectId: id,
      summary: `Integration ${row.name} ${disabled ? "disabled" : "enabled"}`,
      requestId: actor.requestId,
    });
  });
}

export async function archiveIntegration(db: Db, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockIntegration(tx, id);
    if (row.archivedAt) return;
    const links = await tx.$count(
      repositoryLinks,
      and(eq(repositoryLinks.integrationId, id), isNull(repositoryLinks.archivedAt)),
    );
    if (links > 0) throw new DomainError("conflict", "Remove this integration's repository links first.");
    await tx
      .update(integrations)
      .set({ archivedAt: new Date(), archivedBy: actor.userId, webhookEnabled: false })
      .where(eq(integrations.id, id));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "integration.archived",
      subjectType: "integration",
      subjectId: id,
      summary: `Integration ${row.name} archived`,
      requestId: actor.requestId,
    });
  });
}

// --- Health (spec §5.6) --------------------------------------------------------

export type CallOutcome =
  | { ok: true; detail?: string | null }
  | { ok: false; error: unknown };

/** Maps a call outcome onto the health state machine. `disabled` is only changed by the operator. */
export function nextHealth(
  current: IntegrationHealth,
  outcome: CallOutcome,
  providerLabel = "GitHub",
): { health: IntegrationHealth; detail: string | null } {
  if (current === "disabled") return { health: "disabled", detail: "Disabled by the operator." };
  if (outcome.ok) return { health: "ok", detail: outcome.detail ?? null };
  const error = outcome.error;
  if (error instanceof MissingTokenError) return { health: "unconfigured", detail: error.message };
  if (error instanceof ProviderError) {
    if (error.kind === "auth") {
      return { health: "error", detail: `${providerLabel} refused the token (expired, revoked, or missing permissions).` };
    }
    if (error.kind === "rate_limited") {
      const until = error.retryAt ? ` until ${error.retryAt.toISOString()}` : "";
      return { health: "degraded", detail: `Rate limited by ${providerLabel}${until}.` };
    }
  }
  // Token presumably still valid: a sync failure degrades, it doesn't break.
  const detail = error instanceof ProviderError ? redactString(error.message) : redactString(describeError(error));
  return { health: current === "error" ? "error" : "degraded", detail: detail.slice(0, 1000) };
}

export class MissingTokenError extends Error {
  constructor(envVar: string) {
    super(`The env var ${envVar} isn't set on the server.`);
    this.name = "MissingTokenError";
  }
}

export type AdapterFactory<A = SourceAdapter> = (token: string, onRateLimit: (rateLimit: RateLimit) => void) => A;

/** Default: the real GitHub adapter (tests pass a fake fetch). */
export function githubAdapterFactory(fetchImpl?: FetchImpl): AdapterFactory {
  return (token, onRateLimit) => createGitHubAdapter({ token, fetchImpl, onRateLimit });
}

/** The real Netlify/Vercel adapter for an integration (tests pass a fake fetch). */
export function hostingAdapterFactory(
  integration: Pick<IntegrationRow, "provider" | "accountRef">,
  fetchImpl?: FetchImpl,
): AdapterFactory<HostingAdapter> {
  if (integration.provider === "github") throw new Error("GitHub isn't a hosting provider");
  const provider = integration.provider;
  return (token, onRateLimit) => createHostingAdapter(provider, { token, accountRef: integration.accountRef, fetchImpl, onRateLimit });
}

function defaultAdapterFactory(integration: IntegrationRow): AdapterFactory<{ testConnection(): Promise<{ login: string }> }> {
  return integration.provider === "github" ? githubAdapterFactory() : hostingAdapterFactory(integration);
}

/**
 * Runs `fn` with an adapter for the integration and records the outcome:
 * health, last error, rate-limit state. Health changes are audited (system actor).
 */
export async function withIntegrationAdapter<T, A = SourceAdapter>(
  db: Db,
  integration: IntegrationRow,
  factory: AdapterFactory<A>,
  fn: (adapter: A) => Promise<T>,
  options: { kind: "test" | "sync"; now?: Date } = { kind: "sync" },
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let rateLimit: RateLimit | null = null;
  let result: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const token = readSecret(integration.tokenEnvVar);
    if (!token) throw new MissingTokenError(integration.tokenEnvVar);
    const adapter = factory(token, (latest) => {
      rateLimit = latest;
    });
    result = { ok: true, value: await fn(adapter) };
  } catch (error) {
    result = { ok: false, error };
  }

  const now = options.now ?? new Date();
  const outcome: CallOutcome = result.ok ? { ok: true } : { ok: false, error: result.error };
  const { health, detail } = nextHealth(integration.health, outcome, PROVIDER_LABELS[integration.provider]);
  const rate = rateLimit as RateLimit | null;
  await db.transaction(async (tx) => {
    await tx
      .update(integrations)
      .set({
        health,
        healthDetail: detail,
        ...(options.kind === "test" ? { lastTestedAt: now } : {}),
        ...(result.ok
          ? options.kind === "sync"
            ? { lastSyncSucceededAt: now }
            : {}
          : { lastErrorAt: now, lastError: detail ?? "Unknown error" }),
        ...(rate
          ? { rateLimitRemaining: rate.remaining, rateLimitLimit: rate.limit, rateLimitResetAt: rate.resetAt }
          : {}),
      })
      .where(eq(integrations.id, integration.id));
    if (health !== integration.health) {
      await writeAudit(tx, {
        actor: { type: "system" },
        action: "integration.health_changed",
        subjectType: "integration",
        subjectId: integration.id,
        summary: `Integration ${integration.name} is now ${health}`,
        before: { health: integration.health },
        after: { health, detail },
      });
    }
  });
  return result;
}

export async function testIntegration(
  db: Db,
  actor: Actor,
  id: string,
  factory?: AdapterFactory<{ testConnection(): Promise<{ login: string }> }>,
): Promise<{ ok: boolean; message: string }> {
  const integration = await getIntegration(db, id);
  if (!integration || integration.archivedAt) throw notFound("Integration");
  if (integration.health === "disabled") throw new DomainError("conflict", "Enable this integration first.");
  const label = PROVIDER_LABELS[integration.provider];
  const result = await withIntegrationAdapter(
    db,
    integration,
    factory ?? defaultAdapterFactory(integration),
    (adapter) => adapter.testConnection(),
    { kind: "test" },
  );
  const message = result.ok
    ? `Connected to ${label} as ${result.value.login}.`
    : nextHealth(integration.health, { ok: false, error: result.error }, label).detail ?? "Connection failed.";
  await writeAudit(db, {
    actor: auditActor(actor),
    action: "integration.tested",
    subjectType: "integration",
    subjectId: id,
    summary: `Integration ${integration.name} tested: ${result.ok ? "connected" : "failed"}`,
    metadata: { ok: result.ok },
    requestId: actor.requestId,
  });
  return { ok: result.ok, message };
}

// --- Queries -------------------------------------------------------------------

export async function getIntegration(db: DbOrTx, id: string) {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, id));
  return row ?? null;
}

export async function listIntegrations(db: DbOrTx, includeArchived = false) {
  return db
    .select()
    .from(integrations)
    .where(includeArchived ? undefined : isNull(integrations.archivedAt))
    .orderBy(asc(integrations.provider), asc(integrations.name));
}

/** Whether each env var an integration names is set (never the values). */
export function envVarStatus(row: Pick<IntegrationRow, "tokenEnvVar" | "webhookSecretEnvVar">) {
  return {
    tokenSet: readSecret(row.tokenEnvVar) !== null,
    webhookSecretSet: row.webhookSecretEnvVar ? readSecret(row.webhookSecretEnvVar) !== null : null,
  };
}
