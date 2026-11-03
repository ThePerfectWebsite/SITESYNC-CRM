// GitHub read sync (spec §7.2): production branch head, recent commits, open
// PRs and check runs, stored as normalized repository events. Upserts are
// idempotent and only newer provider data overwrites (§3.20).
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client";
import { integrations, repositoryEvents, repositoryLinks } from "../db/schema";
import type { NormalizedEvent } from "../providers/github";
import { redact } from "../redact";
import { githubAdapterFactory, withIntegrationAdapter, type AdapterFactory } from "./service";

export const INITIAL_COMMITS = 50;
export const CHECKED_COMMITS = 10;
const SNAPSHOT_BUDGET = 60 * 1024;

function boundSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const redacted = redact(snapshot) as Record<string, unknown>;
  return Buffer.byteLength(JSON.stringify(redacted), "utf8") <= SNAPSHOT_BUDGET ? redacted : { _truncated: true };
}

/** Inserts or refreshes events. An existing row changes only if the provider's copy is newer. */
export async function upsertRepositoryEvents(
  db: DbOrTx,
  repositoryLinkId: string,
  events: NormalizedEvent[],
  source: "poll" | "webhook",
): Promise<number> {
  if (!events.length) return 0;
  // One statement can't touch the same row twice: keep the newest copy of each identity.
  const unique = new Map<string, NormalizedEvent>();
  for (const event of events) {
    const key = `${event.eventType}:${event.providerEventId}`;
    const existing = unique.get(key);
    if (!existing || (event.providerUpdatedAt?.getTime() ?? 0) >= (existing.providerUpdatedAt?.getTime() ?? 0)) {
      unique.set(key, event);
    }
  }
  const rows = [...unique.values()].map((event) => ({
    repositoryLinkId,
    source,
    eventType: event.eventType,
    providerEventId: event.providerEventId,
    commitSha: event.commitSha,
    ref: event.ref,
    title: event.title,
    authorLogin: event.authorLogin,
    state: event.state,
    conclusion: event.conclusion,
    htmlUrl: event.htmlUrl,
    occurredAt: event.occurredAt,
    providerUpdatedAt: event.providerUpdatedAt,
    snapshot: boundSnapshot(event.snapshot),
  }));
  const written = await db
    .insert(repositoryEvents)
    .values(rows)
    .onConflictDoUpdate({
      target: [repositoryEvents.repositoryLinkId, repositoryEvents.eventType, repositoryEvents.providerEventId],
      set: {
        source: sql`excluded.source`,
        commitSha: sql`excluded.commit_sha`,
        ref: sql`excluded.ref`,
        title: sql`excluded.title`,
        authorLogin: sql`excluded.author_login`,
        state: sql`excluded.state`,
        conclusion: sql`excluded.conclusion`,
        htmlUrl: sql`excluded.html_url`,
        occurredAt: sql`excluded.occurred_at`,
        providerUpdatedAt: sql`excluded.provider_updated_at`,
        snapshot: sql`excluded.snapshot`,
      },
      setWhere: sql`${repositoryEvents.providerUpdatedAt} IS NULL AND excluded.provider_updated_at IS NOT NULL
        OR excluded.provider_updated_at > ${repositoryEvents.providerUpdatedAt}`,
    })
    .returning({ id: repositoryEvents.id });
  return written.length;
}

export type SyncMode = "initial" | "poll" | "manual";

export type SyncResult =
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: unknown }
  | { status: "ok"; headSha: string; commits: number; pulls: number; checks: number; written: number };

/**
 * Syncs one repository link. Never throws for provider problems: they are
 * recorded on the integration's health instead.
 */
export async function syncRepositoryLink(
  db: Db,
  linkId: string,
  options: { mode?: SyncMode; factory?: AdapterFactory; now?: Date } = {},
): Promise<SyncResult> {
  const now = options.now ?? new Date();
  const [row] = await db
    .select({ link: repositoryLinks, integration: integrations })
    .from(repositoryLinks)
    .innerJoin(integrations, eq(integrations.id, repositoryLinks.integrationId))
    .where(eq(repositoryLinks.id, linkId));
  if (!row) return { status: "skipped", reason: "link not found" };
  const { link, integration } = row;
  if (link.archivedAt) return { status: "skipped", reason: "link archived" };
  if (integration.archivedAt) return { status: "skipped", reason: "integration archived" };
  if (integration.health === "disabled") return { status: "skipped", reason: "integration disabled" };

  await db.update(integrations).set({ lastSyncStartedAt: now }).where(eq(integrations.id, integration.id));
  const repo = { owner: link.owner, repo: link.repo };
  const firstSync = !link.lastSyncedAt || options.mode === "initial";
  // Overlap the previous sync by a day so late-arriving commits aren't missed.
  const since = firstSync ? undefined : new Date(link.lastSyncedAt!.getTime() - 24 * 60 * 60 * 1000);

  const result = await withIntegrationAdapter(
    db,
    integration,
    options.factory ?? githubAdapterFactory(),
    async (adapter) => {
      const info = await adapter.getRepository(repo);
      const headSha = await adapter.getBranchHead(repo, link.productionBranch);
      const commits = await adapter.listCommits(repo, { branch: link.productionBranch, since, limit: INITIAL_COMMITS });
      const pulls = await adapter.listOpenPullRequests(repo);
      const checkShas = [headSha, ...commits.items.map((c) => c.commitSha!).filter((s) => s !== headSha)].slice(
        0,
        CHECKED_COMMITS,
      );
      const checks: NormalizedEvent[] = [];
      for (const commitSha of checkShas) checks.push(...(await adapter.listCheckRuns(repo, commitSha)).items);
      return { info, headSha, commits, pulls, checks };
    },
    { kind: "sync", now },
  );
  if (!result.ok) return { status: "failed", error: result.error };

  const { info, headSha, commits, pulls, checks } = result.value;
  const written = await db.transaction(async (tx) => {
    let count = 0;
    count += await upsertRepositoryEvents(tx, link.id, commits.items, "poll");
    count += await upsertRepositoryEvents(tx, link.id, pulls.items, "poll");
    count += await upsertRepositoryEvents(tx, link.id, checks, "poll");
    // PRs we hold as open that GitHub no longer lists as open have closed (or merged).
    if (!pulls.truncated) {
      const openNumbers = pulls.items.map((pr) => pr.providerEventId);
      await tx
        .update(repositoryEvents)
        .set({ state: "closed" })
        .where(
          and(
            eq(repositoryEvents.repositoryLinkId, link.id),
            eq(repositoryEvents.eventType, "pull_request"),
            eq(repositoryEvents.state, "open"),
            openNumbers.length ? notInArray(repositoryEvents.providerEventId, openNumbers) : undefined,
          ),
        );
    }
    await tx
      .update(repositoryLinks)
      .set({
        providerRepoId: info.providerRepoId,
        lastSyncedAt: now,
        syncCursor: { headSha, headCheckedAt: now.toISOString() },
      })
      .where(eq(repositoryLinks.id, link.id));
    return count;
  });

  return {
    status: "ok",
    headSha,
    commits: commits.items.length,
    pulls: pulls.items.length,
    checks: checks.length,
    written,
  };
}

/**
 * Links due a poll: live links on enabled, polled, configured integrations,
 * last synced longer ago than the interval, and not while the integration has
 * used 90% of its rate limit (until the reset).
 */
export async function linksDueForPoll(db: DbOrTx, intervalMinutes: number, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - intervalMinutes * 60 * 1000);
  const rows = await db
    .select({ link: repositoryLinks, integration: integrations })
    .from(repositoryLinks)
    .innerJoin(integrations, eq(integrations.id, repositoryLinks.integrationId))
    .where(
      and(
        isNull(repositoryLinks.archivedAt),
        isNull(integrations.archivedAt),
        eq(integrations.pollEnabled, true),
        inArray(integrations.health, ["ok", "degraded", "unconfigured"]),
      ),
    );
  return rows
    .filter(({ link }) => !link.lastSyncedAt || link.lastSyncedAt <= cutoff)
    .filter(({ integration }) => !rateLimitLow(integration, now))
    .map(({ link }) => link.id);
}

export function rateLimitLow(
  integration: Pick<typeof integrations.$inferSelect, "rateLimitRemaining" | "rateLimitLimit" | "rateLimitResetAt">,
  now: Date,
): boolean {
  const { rateLimitRemaining: remaining, rateLimitLimit: limit, rateLimitResetAt: resetAt } = integration;
  if (remaining === null || !limit) return false;
  if (resetAt && resetAt <= now) return false;
  return remaining < limit * 0.1;
}
