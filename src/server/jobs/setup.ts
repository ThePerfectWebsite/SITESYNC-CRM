// Owner-side job store setup, run by db:migrate (decision 0009). pg-boss
// installs or upgrades its own `pgboss` schema, the queues and schedules are
// created, and the runtime role gets DML (no DDL) on it.
import pg from "pg";
import { PgBoss } from "pg-boss";
import { JOB_SCHEMA, PGBOSS_SCHEDULER_QUEUE, QUEUE_OPTIONS, SCHEDULES } from "./queues";

export async function setupJobStore(ownerUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: JOB_SCHEMA,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
    application_name: "sitesync-migrate",
  });
  boss.on("error", () => {
    /* surfaced by the awaited calls below */
  });
  await boss.start();
  try {
    for (const [name, options] of Object.entries(QUEUE_OPTIONS)) {
      if (await boss.getQueue(name)) {
        // A queue's policy is fixed at creation; the rest can change.
        const rest = { ...options };
        delete rest.policy;
        await boss.updateQueue(name, rest);
      } else {
        await boss.createQueue(name, options);
      }
    }
    // pg-boss's scheduler sends through this internal queue and creates it when it
    // starts, which takes DDL rights the runtime role doesn't have: create it here.
    if (!(await boss.getQueue(PGBOSS_SCHEDULER_QUEUE))) await boss.createQueue(PGBOSS_SCHEDULER_QUEUE);
    for (const { queue, cron } of SCHEDULES) await boss.schedule(queue, cron);
  } finally {
    await boss.stop({ graceful: false, close: true });
  }

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`GRANT USAGE ON SCHEMA ${JOB_SCHEMA} TO sitesync_app`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JOB_SCHEMA} TO sitesync_app`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${JOB_SCHEMA} TO sitesync_app`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${JOB_SCHEMA} TO sitesync_app`);
  } finally {
    await client.end();
  }
}
