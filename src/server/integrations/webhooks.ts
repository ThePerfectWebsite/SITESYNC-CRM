// GitHub webhooks (spec §5.5, §7.3), disabled by default. Receiving only
// verifies, dedupes and stores; processing happens in a job and retries with
// backoff until it is dead-lettered after 8 attempts. Dead letters can be replayed.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit";
import type { Db, DbOrTx } from "../db/client";
import { integrations, repositoryLinks, webhookInbox } from "../db/schema";
import {
  checkRunSchema,
  checkSuiteSchema,
  normalizeCheckRun,
  normalizeCheckSuite,
  normalizeCommit,
  normalizePullRequest,
  pullRequestSchema,
  type NormalizedEvent,
} from "../providers/github";
import { describeError, redact } from "../redact";
import { auditActor, type Actor } from "../records/actor";
import { DomainError, notFound } from "../records/errors";
import { upsertRepositoryEvents } from "./github-sync";
import { readSecret } from "./service";

export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_STORED_BYTES = 256 * 1024;
export const MAX_ATTEMPTS = 8;
export const ALLOWED_GITHUB_EVENTS = new Set(["push", "pull_request", "check_run", "check_suite", "ping"]);
const MAX_PUSH_COMMITS = 50;

export function signBody(secret: string, body: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Constant-time check of X-Hub-Signature-256 against the raw body. */
export function verifySignature(secret: string, body: Buffer, header: string | null): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type ReceiveResult =
  | { status: 404 | 401 | 400 | 413; error: string }
  | { status: 200; duplicate: true }
  | { status: 202; inboxId: string; process: boolean };

/** Keeps a stored body under the 256 KiB budget: push payloads keep their first 50 commits. */
function storableBody(event: string, payload: unknown): unknown | null {
  let body = redact(payload);
  if (event === "push" && body && typeof body === "object" && Array.isArray((body as { commits?: unknown }).commits)) {
    const commits = (body as { commits: unknown[] }).commits;
    body = { ...(body as object), commits: commits.slice(0, MAX_PUSH_COMMITS), commits_truncated: commits.length > MAX_PUSH_COMMITS };
  }
  return Buffer.byteLength(JSON.stringify(body), "utf8") <= MAX_STORED_BYTES - 4096 ? body : null;
}

/**
 * Handles one delivery. Order matters: unknown or disabled integrations look
 * like 404s; nothing is stored before the signature checks out.
 */
export async function receiveGitHubWebhook(
  db: Db,
  input: { integrationId: string; headers: Headers; body: Buffer | "too_large" },
): Promise<ReceiveResult> {
  const [integration] = await db.select().from(integrations).where(eq(integrations.id, input.integrationId));
  if (!integration || integration.archivedAt || integration.provider !== "github" || !integration.webhookEnabled) {
    return { status: 404, error: "not found" };
  }
  if (input.body === "too_large") return { status: 413, error: "payload too large" };
  const secret = readSecret(integration.webhookSecretEnvVar);
  if (!secret || !verifySignature(secret, input.body, input.headers.get("x-hub-signature-256"))) {
    return { status: 401, error: "invalid signature" };
  }

  const deliveryId = input.headers.get("x-github-delivery")?.trim() ?? "";
  const event = input.headers.get("x-github-event")?.trim() ?? "";
  if (!deliveryId || deliveryId.length > 200 || !/^[a-z_]{1,100}$/.test(event)) {
    return { status: 400, error: "missing delivery or event header" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.body.toString("utf8"));
  } catch {
    return { status: 400, error: "body is not JSON" };
  }
  const allowed = ALLOWED_GITHUB_EVENTS.has(event);
  const body = storableBody(event, payload);
  if (body === null) return { status: 413, error: "payload too large to store" };

  const [row] = await db
    .insert(webhookInbox)
    .values({
      provider: "github",
      integrationId: integration.id,
      deliveryId,
      eventType: event,
      signatureValid: true,
      body,
      bodySha256: createHash("sha256").update(input.body).digest(),
      status: allowed ? "received" : "ignored",
      processedAt: allowed ? null : new Date(),
    })
    .onConflictDoNothing({ target: [webhookInbox.provider, webhookInbox.deliveryId] })
    .returning({ id: webhookInbox.id });
  if (!row) return { status: 200, duplicate: true };
  return { status: 202, inboxId: row.id, process: allowed };
}

// --- Processing ------------------------------------------------------------------

const repositorySchema = z.object({ full_name: z.string() });

const pushSchema = z.object({
  ref: z.string(),
  after: z.string(),
  deleted: z.boolean().nullish(),
  repository: repositorySchema,
  commits: z
    .array(
      z.object({
        id: z.string(),
        message: z.string().nullish(),
        timestamp: z.string().nullish(),
        url: z.string().nullish(),
        author: z.object({ username: z.string().nullish(), name: z.string().nullish() }).nullish(),
      }),
    )
    .default([]),
});

const eventSchemas = {
  pull_request: z.object({ repository: repositorySchema, pull_request: pullRequestSchema }),
  check_run: z.object({ repository: repositorySchema, check_run: checkRunSchema }),
  check_suite: z.object({ repository: repositorySchema, check_suite: checkSuiteSchema }),
};

/** Exponential backoff for failed deliveries: 30 s, 1 min, 2 min … capped at 1 h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
}

class PermanentPayloadError extends Error {}

/** Normalizes a delivery into events for links matching its repository. */
async function applyDelivery(db: DbOrTx, row: typeof webhookInbox.$inferSelect): Promise<void> {
  if (row.eventType === "ping") return;
  const repoName = repositorySchema.safeParse((row.body as { repository?: unknown })?.repository);
  if (!repoName.success) throw new PermanentPayloadError("payload has no repository");
  const [owner, repo] = repoName.data.full_name.split("/");
  const links = await db
    .select()
    .from(repositoryLinks)
    .where(
      and(
        eq(repositoryLinks.integrationId, row.integrationId!),
        sql`lower(${repositoryLinks.owner}) = lower(${owner ?? ""})`,
        sql`lower(${repositoryLinks.repo}) = lower(${repo ?? ""})`,
        sql`${repositoryLinks.archivedAt} IS NULL`,
      ),
    );
  if (!links.length) return; // Not a repository SiteSync tracks: nothing to do.

  for (const link of links) {
    let events: NormalizedEvent[] = [];
    if (row.eventType === "push") {
      const push = pushSchema.parse(row.body);
      const branch = push.ref.startsWith("refs/heads/") ? push.ref.slice("refs/heads/".length) : null;
      events = push.commits
        .map((c) =>
          normalizeCommit(
            {
              sha: c.id,
              html_url: c.url,
              commit: { message: c.message, committer: { date: c.timestamp }, author: { name: c.author?.name, date: c.timestamp } },
              author: c.author?.username ? { login: c.author.username } : null,
            },
            branch,
          ),
        )
        .filter((e): e is NormalizedEvent => e !== null);
      if (branch === link.productionBranch && !push.deleted && /^[0-9a-f]{40}$/.test(push.after)) {
        await db
          .update(repositoryLinks)
          .set({ syncCursor: { headSha: push.after, headCheckedAt: new Date().toISOString() } })
          .where(eq(repositoryLinks.id, link.id));
      }
    } else if (row.eventType === "pull_request") {
      events = [normalizePullRequest(eventSchemas.pull_request.parse(row.body).pull_request)];
    } else if (row.eventType === "check_run") {
      events = [normalizeCheckRun(eventSchemas.check_run.parse(row.body).check_run)];
    } else if (row.eventType === "check_suite") {
      events = [normalizeCheckSuite(eventSchemas.check_suite.parse(row.body).check_suite)];
    }
    await upsertRepositoryEvents(db, link.id, events, "webhook");
  }
}

export type ProcessOutcome = "processed" | "failed" | "dead_lettered" | "skipped";

/** Claims one delivery (received or failed) and processes it. Safe to call twice. */
export async function processWebhookDelivery(
  db: Db,
  inboxId: string,
  options: { now?: Date; apply?: typeof applyDelivery } = {},
): Promise<ProcessOutcome> {
  const now = options.now ?? new Date();
  const [row] = await db
    .update(webhookInbox)
    .set({ status: "processing", attempts: sql`${webhookInbox.attempts} + 1` })
    .where(and(eq(webhookInbox.id, inboxId), inArray(webhookInbox.status, ["received", "failed"])))
    .returning();
  if (!row) return "skipped";
  try {
    await db.transaction((tx) => (options.apply ?? applyDelivery)(tx, row));
    await db
      .update(webhookInbox)
      .set({ status: "processed", processedAt: now, nextAttemptAt: null, lastError: null })
      .where(eq(webhookInbox.id, inboxId));
    return "processed";
  } catch (error) {
    const dead = row.attempts >= MAX_ATTEMPTS;
    await db
      .update(webhookInbox)
      .set({
        status: dead ? "dead_lettered" : "failed",
        nextAttemptAt: dead ? null : new Date(now.getTime() + retryDelayMs(row.attempts)),
        lastError: describeError(error).slice(0, 2000),
      })
      .where(eq(webhookInbox.id, inboxId));
    return dead ? "dead_lettered" : "failed";
  }
}

/** Failed deliveries whose backoff has elapsed. */
export async function deliveriesDueForRetry(db: DbOrTx, now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: webhookInbox.id })
    .from(webhookInbox)
    .where(and(eq(webhookInbox.status, "failed"), lte(webhookInbox.nextAttemptAt, now)))
    .limit(100);
  return rows.map((r) => r.id);
}

/** Sends a dead-lettered (or failed) delivery round again from the start. */
export async function replayDelivery(db: Db, actor: Actor, inboxId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(webhookInbox).where(eq(webhookInbox.id, inboxId)).for("update");
    if (!row) throw notFound("Webhook delivery");
    if (row.status !== "dead_lettered" && row.status !== "failed") {
      throw new DomainError("conflict", "Only failed or dead-lettered deliveries can be replayed.");
    }
    await tx
      .update(webhookInbox)
      .set({ status: "received", attempts: 0, nextAttemptAt: null })
      .where(eq(webhookInbox.id, inboxId));
    await writeAudit(tx, {
      actor: auditActor(actor),
      action: "webhook.replayed",
      subjectType: "webhook_delivery",
      subjectId: inboxId,
      summary: `Webhook delivery ${row.deliveryId} (${row.eventType}) replayed`,
      metadata: { previousStatus: row.status, attempts: row.attempts },
      requestId: actor.requestId,
    });
  });
}

/** Retention (§3.24): processed and ignored deliveries go after 30 days; dead letters stay. */
export async function pruneWebhookInbox(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(webhookInbox)
    .where(and(inArray(webhookInbox.status, ["processed", "ignored"]), lt(webhookInbox.receivedAt, cutoff)))
    .returning({ id: webhookInbox.id });
  return deleted.length;
}

export async function listWebhookDeliveries(db: DbOrTx, limit = 50) {
  return db
    .select({
      id: webhookInbox.id,
      deliveryId: webhookInbox.deliveryId,
      eventType: webhookInbox.eventType,
      status: webhookInbox.status,
      attempts: webhookInbox.attempts,
      receivedAt: webhookInbox.receivedAt,
      nextAttemptAt: webhookInbox.nextAttemptAt,
      lastError: webhookInbox.lastError,
      integrationName: integrations.name,
    })
    .from(webhookInbox)
    .leftJoin(integrations, eq(integrations.id, webhookInbox.integrationId))
    .orderBy(desc(webhookInbox.receivedAt))
    .limit(limit);
}
