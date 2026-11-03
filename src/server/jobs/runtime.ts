import "server-only";
// The in-process job runner (decision 0009): pg-boss as the runtime role,
// started once per server process from instrumentation.ts. If it isn't running
// (disabled, or the database was down at start), enqueue falls back to doing
// the work inline so manual actions still work.
import { PgBoss } from "pg-boss";
import { db } from "../db";
import { env } from "../env";
import { describeError } from "../redact";
import { processWebhookDelivery } from "../integrations/webhooks";
import {
  runDeployConfirmJob,
  runHostingPollJob,
  runHostingSyncJob,
  runMaintenanceJob,
  runPollJob,
  runSyncJob,
  runWebhookRetryJob,
  type DeployConfirmJob,
  type HostingSyncJob,
  type SyncJob,
} from "./handlers";
import { JOB_SCHEMA, QUEUES } from "./queues";

type JobState = { boss: PgBoss | null; starting: Promise<void> | null };
const globalJobs = globalThis as typeof globalThis & { __sitesyncJobs?: JobState };
const state: JobState = (globalJobs.__sitesyncJobs ??= { boss: null, starting: null });

export function jobsRunning(): boolean {
  return state.boss !== null;
}

export function startJobs(): Promise<void> {
  state.starting ??= start().catch((error) => {
    state.starting = null;
    console.error(`[jobs] not started: ${describeError(error)}`);
  });
  return state.starting;
}

async function start(): Promise<void> {
  const boss = new PgBoss({
    connectionString: env().databaseUrl,
    schema: JOB_SCHEMA,
    migrate: false, // the owner role migrates during db:migrate
    createSchema: false,
    supervise: true,
    schedule: true,
    application_name: "sitesync-jobs",
    max: 4,
  });
  boss.on("error", (error) => console.error(`[jobs] ${describeError(error)}`));
  await boss.start();

  const database = db();
  await boss.work<SyncJob>(QUEUES.githubSync, async (jobs) => {
    for (const job of jobs) await runSyncJob(database, job.data);
  });
  await boss.work(QUEUES.githubPoll, async () => {
    await runPollJob(database, (job) => enqueueSync(job.linkId, job.mode));
  });
  await boss.work<HostingSyncJob>(QUEUES.hostingSync, async (jobs) => {
    for (const job of jobs) await runHostingSyncJob(database, job.data);
  });
  await boss.work(QUEUES.hostingPoll, async () => {
    await runHostingPollJob(database, (job) => enqueueHostingSync(job.linkId));
  });
  await boss.work<DeployConfirmJob>(QUEUES.deployConfirm, async (jobs) => {
    for (const job of jobs) await runDeployConfirmJob(database, job.data, (next, delay) => sendDeployConfirm(boss, next, delay));
  });
  await boss.work<{ inboxId: string }>(QUEUES.webhookProcess, async (jobs) => {
    for (const job of jobs) await processWebhookDelivery(database, job.data.inboxId);
  });
  await boss.work(QUEUES.webhookRetry, async () => {
    await runWebhookRetryJob(database);
  });
  await boss.work(QUEUES.maintenance, async () => {
    await runMaintenanceJob(database);
  });
  state.boss = boss;
}

/** Queues a sync for a link (at most one queued + one running per link). Returns how it ran. */
export async function enqueueSync(linkId: string, mode: SyncJob["mode"]): Promise<"queued" | "already_queued" | "ran_inline"> {
  if (state.boss) {
    const id = await state.boss.send(QUEUES.githubSync, { linkId, mode }, { singletonKey: linkId });
    return id ? "queued" : "already_queued";
  }
  await runSyncJob(db(), { linkId, mode });
  return "ran_inline";
}

/** Queues a hosting sync (at most one queued + one running per link). */
export async function enqueueHostingSync(linkId: string): Promise<"queued" | "already_queued" | "ran_inline"> {
  if (state.boss) {
    const id = await state.boss.send(QUEUES.hostingSync, { linkId }, { singletonKey: linkId });
    return id ? "queued" : "already_queued";
  }
  await runHostingSyncJob(db(), { linkId });
  return "ran_inline";
}

export async function enqueueWebhook(inboxId: string): Promise<void> {
  if (state.boss) {
    await state.boss.send(QUEUES.webhookProcess, { inboxId });
    return;
  }
  await processWebhookDelivery(db(), inboxId);
}

function sendDeployConfirm(boss: PgBoss, job: DeployConfirmJob, delaySeconds: number) {
  return boss.send(QUEUES.deployConfirm, job, { startAfter: delaySeconds });
}

/**
 * Starts confirming a release (§5.3). Without the job runner it checks once
 * now; the hosting poll and "Re-check now" settle it later.
 */
export async function enqueueDeployConfirm(deploymentId: string): Promise<void> {
  if (state.boss) {
    await sendDeployConfirm(state.boss, { deploymentId, attempt: 1 }, 5);
    return;
  }
  await runDeployConfirmJob(db(), { deploymentId, attempt: 1 }, async () => undefined);
}
