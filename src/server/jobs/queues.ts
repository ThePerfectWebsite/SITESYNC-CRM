// Job queues (spec §3.25, §7.2). Created by the owner role during db:migrate;
// the runtime role only sends and works jobs (decision 0009).
import type { Queue } from "pg-boss";

export const JOB_SCHEMA = "pgboss";

/** pg-boss 12's internal scheduler queue (timekeeper.js `QUEUES.SEND_IT`). */
export const PGBOSS_SCHEDULER_QUEUE = "__pgboss__send-it";

export const QUEUES = {
  /** Sync one repository link. `stately` + singletonKey = link id: at most one queued and one active per link. */
  githubSync: "github-sync",
  /** Cron: enqueue syncs for links due a poll. */
  githubPoll: "github-poll",
  /** Sync one hosting link (Netlify, Vercel, Cloudflare Pages), same per-link rule. */
  hostingSync: "hosting-sync",
  /** Cron: enqueue syncs for hosting links due a poll. */
  hostingPoll: "hosting-poll",
  /** Confirm one SiteSync release with the provider (spec §5.3); re-queues itself with backoff. */
  deployConfirm: "deploy-confirm",
  /** Process one webhook delivery. */
  webhookProcess: "webhook-process",
  /** Cron: re-run failed deliveries whose backoff has elapsed. */
  webhookRetry: "webhook-retry",
  /** Cron: retention (login attempts, webhook inbox). */
  maintenance: "maintenance",
} as const;

export const QUEUE_OPTIONS: Record<string, Omit<Queue, "name">> = {
  [QUEUES.githubSync]: { policy: "stately", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 15 * 60 },
  [QUEUES.githubPoll]: { policy: "singleton", retryLimit: 0, expireInSeconds: 5 * 60 },
  [QUEUES.hostingSync]: { policy: "stately", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 15 * 60 },
  [QUEUES.hostingPoll]: { policy: "singleton", retryLimit: 0, expireInSeconds: 5 * 60 },
  [QUEUES.deployConfirm]: { policy: "standard", retryLimit: 3, retryDelay: 30, expireInSeconds: 5 * 60 },
  [QUEUES.webhookProcess]: { policy: "standard", retryLimit: 0, expireInSeconds: 5 * 60 },
  [QUEUES.webhookRetry]: { policy: "singleton", retryLimit: 0, expireInSeconds: 5 * 60 },
  [QUEUES.maintenance]: { policy: "singleton", retryLimit: 1, expireInSeconds: 15 * 60 },
};

/** Cron schedules (server time zone; none of these are calendar-sensitive). */
export const SCHEDULES: { queue: string; cron: string }[] = [
  { queue: QUEUES.githubPoll, cron: "*/5 * * * *" },
  { queue: QUEUES.hostingPoll, cron: "*/5 * * * *" },
  { queue: QUEUES.webhookRetry, cron: "* * * * *" },
  { queue: QUEUES.maintenance, cron: "17 3 * * *" },
];
