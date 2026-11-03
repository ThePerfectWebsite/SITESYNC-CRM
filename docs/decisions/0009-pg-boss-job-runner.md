# 0009 — Background jobs: pg-boss in-process, migrated by the owner role

**Context.** Phase 3a needs background work:
- polling GitHub every few minutes;
- one sync at a time per repository;
- processing webhook deliveries with retries;
- retention (old login attempts and webhook rows).

Spec §3.25 chose pg-boss with its own schema, migrated by pg-boss, and asked for this decision record. Decision 0006 requires that the runtime role (`sitesync_app`) has no DDL rights.

**Decision.**

1. **Version.** `pg-boss` 12.38.0, pinned (verified on npm 2026-11-03; requires Node ≥ 22.12). Its peer `@opentelemetry/api` is installed by npm automatically.
2. **Who migrates.** `runMigrations()` applies the Drizzle migrations and then `setupJobStore()`, as `sitesync_owner`. This covers `npm run db:migrate`, the test reset and E2E global setup. `setupJobStore()`:
   - starts pg-boss with `migrate: true, createSchema: true`;
   - creates or updates our queues;
   - creates pg-boss's internal scheduler queue `__pgboss__send-it` (pg-boss would otherwise create it at runtime, which needs rights the runtime role doesn't have — found by E2E);
   - registers the cron schedules;
   - grants `sitesync_app` `USAGE` on the schema, DML on its tables, sequence usage and `EXECUTE` on its functions.
   - The grants are re-applied on every migrate, so a pg-boss upgrade that adds tables is covered.
3. **Who runs.** The Next.js server starts pg-boss once, from `src/instrumentation.ts`:
   - as `sitesync_app`, with `migrate: false, createSchema: false` and scheduling and maintenance on;
   - it doesn't run during `next build`;
   - `SITESYNC_JOBS=off` disables it.
   - An integration test proves the runtime role can start pg-boss, send, dedupe and work jobs with scheduling on, and still can't create tables in the `pgboss` schema.
4. **Queues:**

   | Queue | Policy | Purpose |
   |---|---|---|
   | `github-sync` | `stately`, `singletonKey` = link id | at most one queued + one running sync per link (§7.2) |
   | `github-poll` | `singleton`, cron `*/5 * * * *` | enqueues links not synced within `sync.poll_interval_minutes` (default 10, range 5–60); skips integrations under 10% of their rate limit until the reset |
   | `webhook-process` | standard | process one delivery |
   | `webhook-retry` | `singleton`, cron every minute | retry failed deliveries whose backoff has passed |
   | `maintenance` | `singleton`, daily 03:17 | prune login attempts (30 d) and processed/ignored webhook rows (30 d) |

   A queue's policy can't change after creation; other options are updated on migrate.
5. **Webhook retries are ours, not pg-boss's.** The inbox row holds `attempts`, `next_attempt_at` and `status`. Backoff is 30 s doubling to a 1 h cap, and the 8th failure dead-letters the row (§5.5). This keeps the state visible on the Integrations screen and replayable, independent of job-table retention.
6. **Fallback.** If the runner isn't running (disabled, or the database was down at start), a manual refresh or replay runs inline in the request. Manual work never waits on background jobs.

**Consequences.**
- One process, so `npm run dev` / `npm start` is all an operator runs.
- Several server processes would each run workers. That's safe: singleton policies and row claims prevent double work. But it's unnecessary for one operator, and LAN mode still runs one process.
- pg-boss tables are outside Drizzle's snapshots. The `pgboss` schema is dropped and re-created by the test resets.

**Alternatives.**
- A separate worker process (`npm run worker`): cleaner isolation, but a second thing to keep running.
- Letting the runtime role migrate pg-boss: contradicts decision 0006.
- `setInterval` timers with no queue: loses singleton-per-link and durable retries.
