// What each job does. Plain functions over a db so tests can call them
// without pg-boss; runtime.ts wires them to queues.
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { appSettings } from "../db/schema";
import { pruneLoginAttempts } from "../auth/throttle";
import { linksDueForPoll, syncRepositoryLink, type SyncMode } from "../integrations/github-sync";
import { hostingLinksDueForPoll, syncHostingLink } from "../integrations/hosting-sync";
import type { AdapterFactory } from "../integrations/service";
import type { HostingAdapter } from "../providers/hosting";
import { deliveriesDueForRetry, processWebhookDelivery, pruneWebhookInbox } from "../integrations/webhooks";

export const POLL_INTERVAL_SETTING = "sync.poll_interval_minutes";
export const DEFAULT_POLL_MINUTES = 10;

/** Poll interval (spec §7.2): 5–60 minutes, default 10. */
export async function getPollIntervalMinutes(db: Db): Promise<number> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, POLL_INTERVAL_SETTING));
  const parsed = z.number().int().min(5).max(60).safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_POLL_MINUTES;
}

export type SyncJob = { linkId: string; mode: SyncMode };

export function runSyncJob(db: Db, job: SyncJob, factory?: AdapterFactory) {
  return syncRepositoryLink(db, job.linkId, { mode: job.mode, factory });
}

/** Enqueues a poll sync for every link that is due. */
export async function runPollJob(db: Db, enqueue: (job: SyncJob) => Promise<unknown>, now: Date = new Date()) {
  const due = await linksDueForPoll(db, await getPollIntervalMinutes(db), now);
  for (const linkId of due) await enqueue({ linkId, mode: "poll" });
  return due.length;
}

export type HostingSyncJob = { linkId: string };

export function runHostingSyncJob(db: Db, job: HostingSyncJob, factory?: AdapterFactory<HostingAdapter>) {
  return syncHostingLink(db, job.linkId, { factory });
}

/** Enqueues a sync for every hosting link that is due (same interval as GitHub). */
export async function runHostingPollJob(db: Db, enqueue: (job: HostingSyncJob) => Promise<unknown>, now: Date = new Date()) {
  const due = await hostingLinksDueForPoll(db, await getPollIntervalMinutes(db), now);
  for (const linkId of due) await enqueue({ linkId });
  return due.length;
}

export async function runWebhookRetryJob(db: Db, now: Date = new Date()) {
  const ids = await deliveriesDueForRetry(db, now);
  for (const id of ids) await processWebhookDelivery(db, id, { now });
  return ids.length;
}

export async function runMaintenanceJob(db: Db, now: Date = new Date()) {
  const loginAttempts = await pruneLoginAttempts(db, now);
  const deliveries = await pruneWebhookInbox(db, now);
  return { loginAttempts, deliveries };
}
