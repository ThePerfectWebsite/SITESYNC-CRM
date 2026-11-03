# Implementation Status

| Phase | Status | Session date |
|---|---|---|
| S — Specification | **Done — approved by operator** | 2026-11-03 |
| 0 — Foundation | **Done** | 2026-11-03 |
| 1 — Core records | **Done** | 2026-11-03 |
| 2 — Work tracking | **Done** | 2026-11-03 |
| 3a — GitHub read sync | **Done** | 2026-11-03 |
| 3b — Hosting read sync | **Done** | 2026-11-03 |
| 4 — Approval-gated deployment | **Done** (not yet tried on a live host) | 2026-11-03 |
| 5 — Operations & polish | Not started (ready) | |

**Current phase for the next session:** Phase 5 — Operations & polish.

---

## Handoff — Phase 4 (2026-11-03)

### 1. Phase completed and key areas changed
Phase 4 — Approval-gated deployment. The operator chose "whichever is best, and free" for Cloudflare. Decision 0011 records the mechanism, which is spec §8.1's verification record. Spec amended (§3.23, §8.1).
- **Migrations:**
  - `0011_deployment_gate` (generated):
    - `production_approvals` (§3.23), plus `target_deployment_id` and `production_branch`;
    - one awaiting approval per host; the 30-minute expiry check;
    - the `deployments.approval_id` FK.
  - `0012_deployment_gate_triggers_grants` (hand-written):
    - same-website and same-link composite FKs;
    - a trigger that makes every decided state terminal and freezes what was approved;
    - `updated_at`;
    - `SELECT, INSERT, UPDATE` only.
- **Adapters:**
  - `getDeployment`, `promote`, `rollback` and `buildFromRef` for all three hosts, with `HOSTING_CAPABILITIES`: Cloudflare builds the branch; Netlify and Vercel promote.
  - `http.ts` `sendJson`: writes are never retried after they may have reached the provider (only on 429), and never follow redirects.
- **Services (`src/server/deploy/`):**
  - `preflight.ts`: everything the screen shows, the canonical snapshot and SHA-256 hash, problems, the 5-minute freshness rule, the release stage rule, and release options.
  - `approvals.ts`:
    - approve (hash re-check, readiness, unique awaiting), revoke, the expiry sweeper;
    - the executor (§8.4): lock, expiry, live re-check of host/target/commit/current deploy, GitHub branch head for builds, readiness, consume plus a pending deployment, refusals terminal and audited;
    - a single dispatch under the per-link lock;
    - `confirmAndExecute` (password through the login throttle, audited);
    - queries.
  - `confirm.ts`: `judgeRelease` (pure), `evaluateRelease`, `checkRelease`, the 20-minute timeout, late confirmations, stuck-pending detection, `go_live` in a savepoint, website → live.
  - `auth/service.ts`: `verifyOperatorPassword`.
  - `stages/service.ts`: `goLiveWithinTransaction`.
  - Deployment facts count awaiting approvals as in-flight work.
  - Hosting sync takes the per-link advisory lock, and keeps a release record published while its target is live.
- **Jobs:**
  - `deploy-confirm` queue (5 s → 60 s backoff, re-queues itself), `enqueueDeployConfirm` with an inline fallback;
  - hosting sync settles releases on the link; the hosting poll expires lapsed approvals.
- **Screens:**
  - preflight (15) `/projects/[id]/deploy/preflight?action=…&target=…`: target, live vs proposed, compare link, checks, open PRs, readiness/waivers, freshness with **Refresh from provider**, problems, Approve with a reason.
  - final confirmation (16) `/approvals/[id]/confirm`: summary, countdown, password, revoke, and the decided-state view.
  - overview **Release** section: options per host, latest release state, **Re-check now**, recovery text, rollback list, waiting-approval notice.
  - dashboard: approvals waiting and release alerts.
  - The auto-publish pill and caveat are now shared components.
- **Docs:**
  - decision 0011;
  - `docs/hosting.md` "Releasing", now with the Cloudflare **Pages Edit** permission;
  - README "Releases" and the updated known-limitation note;
  - spec amendments;
  - `.env.example`.

### 2. Commands run and actual results
- `npm run lint` → clean. `npm run typecheck` → passes.
- `npm run db:migrate` and `-- --test` → 13/13 (dev DB too).
- `npm test` → **18 files, 335 tests passed**. New in Phase 4:
  - `deploy` unit tests (9): canonical hash, the stage rule, backoff, `judgeRelease` cases, provider writes (no retry on 5xx, 429 retried, no redirects; Vercel/Cloudflare paths, team ID and form field; unsupported actions).
  - `deploy` integration tests (21), all of spec §8.6 plus the plan's extras, against stateful fake Netlify, Cloudflare and GitHub:
    - no approval; expired (and the sweeper); consumed replay; target mismatch (commit changed, host unlinked);
    - branch moved (`build_from_ref`); live changed since approval;
    - concurrent double-submit → exactly one POST; wrong password → no calls, approval unchanged, audited;
    - unwaived blocker at execution; preview deploys never promotable;
    - hash mismatch on approve; stale data (> 5 min) disables approve; one awaiting approval per host; manual host / early stage refused;
    - promote end to end (Live, website live, record stays published after re-sync);
    - Cloudflare build end to end (no duplicate row); built-the-wrong-commit → failure;
    - rollback through the gate; dispatch error → `dispatch_failed`, never retried;
    - late confirmation after the timeout; the terminal and immutability trigger; no DELETE grant.
- `npm run test:e2e` → **32 passed**, including 2 new:
  - a manual host can't be released (the Release section and the preflight explain why; Approve unavailable);
  - the confirmation screen: a wrong password leaves the approval waiting, and revoking ends it.

  `github.spec` now opens the "Add an integration" form itself, because an earlier spec may already have added an integration.
- Not done this phase: a visual screenshot pass of the new screens (E2E covers their rendering and flow).

### 3. Setup steps and env var names
- `npm run db:migrate` applies `0011`/`0012` and creates the `deploy-confirm` queue (done on this machine).
- To release on Cloudflare: the token in `CLOUDFLARE_API_TOKEN` (or your name) needs **Account → Cloudflare Pages → Edit**. The website also needs its GitHub repository linked, because SiteSync checks the branch head before building.

### 4. Credentials/config the operator still needs to provide
None to run. For a live release test: a Cloudflare token with Pages Edit, a Pages project with automatic production deploys off, and its GitHub repository linked in SiteSync.

### 5. Known limitations / unmet criteria
- **No live release yet** on any host. Decision 0011 lists what to confirm: Cloudflare's create response and `canonical_deployment` moving; rollback limits; Netlify's lock surviving `restore`; Vercel's `targets.production` after promote.
- Cloudflare builds the branch HEAD: if someone pushes in the seconds between SiteSync's check and Cloudflare starting the build, the wrong commit is built. SiteSync detects it and doesn't mark Live, but the build is still live on Cloudflare until you roll back.
- Rollbacks need a clear readiness check like any release (spec §8.5). In an emergency, waive blockers with a reason.
- With the job runner off (`SITESYNC_JOBS=off`), a release is checked once at dispatch. After that, the hosting poll or **Re-check now** settles it.

### 6. Next phase and decisions needed first
Next: **Phase 5 — Operations & polish** (backup/restore drill, integrations polish, activity screen 18, settings 19, accessibility pass, README against the acceptance criteria). No open decisions. A live release test (§4) is worth doing before or during Phase 5.

---

## Handoff — Phase 3b (2026-11-03)

### 1. Phase completed and key areas changed
Phase 3b — Hosting read sync. Committed on `main` after `3a82b13`. The operator chose **Cloudflare Pages** as the host during this phase, so it was added as a provider alongside Netlify and Vercel (decision 0010, spec amended).
- **Migrations:**
  - `0009_hosting_sync` (generated):
    - `hosting_links` and `deployments` (spec §3.21–§3.22, plus `provider_updated_at`);
    - one production host per website; deployment identity, idempotency and approval unique keys;
    - `cloudflare` added to the provider checks (widened, data-preserving);
    - the deferred FKs `stage_history.deployment_id` and `changes.shipped_in_deployment_id` (decision 0007).
  - `0010_hosting_sync_triggers_grants` (hand-written):
    - a deployment's website must match its link's;
    - a link's current deployment must be one of its own (deferrable composite FK);
    - `updated_at` triggers;
    - `SELECT, INSERT, UPDATE` only (deployments are history).
- **Adapters** (`src/server/providers/hosting.ts`): Cloudflare Pages, Netlify and Vercel, each with:
  - a §5.2 state-mapping function;
  - auto-publish detection (§1.1);
  - current-production detection.

  `api.cloudflare.com` was added to the `providerFetch` allowlist.
- **Services:**
  - `integrations/hosting-sync.ts`:
    - hosting links: integration-backed or manual;
    - sync: last deploys, an order-tolerant upsert, the provider's current deploy marked published and the old one superseded, auto-publish and domain recorded;
    - poll due-ness;
    - queries for history, live vs latest preview, and dashboard alerts.
  - `integrations/service.ts`: provider-generic adapters, health labels and test connection; a Cloudflare account ID is required.
  - `stages/deployment-facts.ts`: `databaseDeploymentFacts`, now used by the app.
  - `stages/service.ts`: `confirmLiveFromProviderDeploy` (OQ-2), which shares an in-transaction `go_live` with `systemGoLive`.
  - `records/readiness.ts`: `hosting:missing` (unwaivable) and `preview:<id>`.
- **Jobs:** `hosting-sync` (stately per link) and the `hosting-poll` cron, with `enqueueHostingSync` and the inline fallback.
- **Screens:**
  - integrations: choose a provider, with per-provider hints; webhooks only for GitHub.
  - website: hosting panels (auto-publish state, §1.1 caveat with provider-specific steps, live now, refresh/unlink), "Link a host" (connection or manual record), deploy history.
  - project Deployments tab (13).
  - overview: live vs latest preview, plus the OQ-2 "Mark Live with this deploy" prompt.
  - readiness: links to fix each blocker.
  - dashboard: deployment alerts and sync errors.
- **Docs:** decision 0010 (verified endpoints, mappings, lock settings, gaps), `docs/hosting.md`, spec amendment, README, `.env.example`.

### 2. Commands run and actual results
- `npm run lint` → clean. `npm run typecheck` → passes.
- `npm run db:migrate -- --test` → 11/11. (Dev DB: see §3.)
- `npm test` → **16 files, 305 tests passed**. New in Phase 3b:
  - `hosting` unit tests (46): every documented state for all three providers, supersede rules, auto-publish detection, normalization, and the Cloudflare adapter's paths, account ID, page size and truncation.
  - `hosting` integration tests (16):
    - link rules (one production host, project ID required, GitHub isn't a host, blank form fields);
    - the DB integrity FKs; no deletes;
    - sync (published/superseded/building/failed, auto-publish, domain, health); live deploy moving; out-of-order upserts; 404 message; manual records not synced; poll due-ness;
    - live vs preview and alerts;
    - database facts (skipping over Live refused with an integration-backed host, allowed with a manual one);
    - OQ-2 (attribution + system `go_live`, refusals roll back);
    - readiness (`hosting:missing` unwaivable, any host clears it; `preview_not_ready` waivable).
  - Existing readiness tests now give their projects a production host. The `go_live` tests use real deployment rows, because the FK exists now.
- `npm run test:e2e` → **30 passed**, including 3 new hosting tests:
  - adding a Cloudflare integration requires a valid account ID;
  - linking a Cloudflare host shows the caveat with Cloudflare's own steps, and a second production host is refused;
  - the hosting blocker is unwaivable, links to the website, and the Deployments tab shows an empty state.
- Screens checked by screenshot.

### 3. Setup steps and env var names
- `npm run db:migrate` applies `0009`/`0010` (done on this machine: dev DB 11/11).
- Optional env var, name of your choice: `CLOUDFLARE_API_TOKEN` (Pages Read). See `docs/hosting.md`.

### 4. Credentials/config the operator still needs to provide
None required. To use Cloudflare: a Pages Read API token in `.env`, your account ID, then add the integration and link a website's Pages project.

### 5. Known limitations / unmet criteria
- **Not yet tried against a live Cloudflare, Netlify or Vercel account.** The decision 0010 gaps still need confirming: Cloudflare `canonical_deployment` after a rollback, Cloudflare's `per_page` maximum (25 used), and Vercel's `targets.production`.
- Every project is now blocked until its website has a production host, which is the intended spec §6 behaviour. A manual host record clears the blocker.
- On Cloudflare, "auto-deploy off" means production isn't built on push at all. Phase 4 must therefore create or promote the production deploy itself; verify the mechanism then.
- `deployments.approval_id` has no FK until `production_approvals` exists (Phase 4). No SiteSync-initiated deploys exist yet.
- During one E2E run the job runner logged 7 errors that printed as `[object Object]`. They didn't recur in 5 later runs. `describeError` now prints error objects (redacted), so any recurrence will be readable.

### 6. Next phase and decisions needed first
Next: **Phase 4 — Approval-gated deployment.** Before starting:
- Decide the release flow on Cloudflare: approve, then SiteSync triggers a production deployment of the approved commit (or rolls back to a specific deploy), with automatic production deploys off. The endpoints need verifying (spec §8.1; Cloudflare wasn't in the original spec).
- Live testing needs a Cloudflare token with **Pages Write** for dispatch, which is more than read-only.

---

## Handoff — Phase 3a (2026-11-03)

### 1. Phase completed and key areas changed
Phase 3a — GitHub read sync. Committed on `main` after Phase 2 (`c65e275`).
- **Migrations:**
  - `0007_github_sync` (generated): `integrations`, `repository_links`, `repository_events`, `webhook_inbox`, with every §3.18–§3.20/§3.24 check. That includes:
    - env-var-name format;
    - webhook secret required when enabled;
    - git branch-name rules, checked against valid and invalid names;
    - case-insensitive unique repo per website;
    - one primary repository link per website;
    - the event identity unique key;
    - delivery dedupe on `(provider, delivery_id)`.
  - `0008_github_sync_triggers_grants` (hand-written): `updated_at` triggers; `SELECT, INSERT, UPDATE` (no `DELETE`) on integrations, links and events; `DELETE` only on `webhook_inbox`, for 30-day retention.
- **Job store** (decision 0009): pg-boss 12.38.0 pinned.
  - `runMigrations()` now also runs `setupJobStore()` as the owner: the `pgboss` schema, queues, pg-boss's internal scheduler queue, cron schedules, and DML grants for `sitesync_app`.
  - `src/instrumentation.ts` starts the runner in the Next server as the runtime role. `SITESYNC_JOBS=off` disables it; the inline fallback keeps manual refresh and replay working.
- **Provider layer** (`src/server/providers/`):
  - `providerFetch`: https-only allowlist of the three API hosts, no credentials or ports in URLs, same-host redirects only, 10 s timeout.
  - `http`: Zod-parsed JSON. Rate limits are classified by GitHub's documented rules (403/429 with remaining 0 → wait for the reset; secondary limit or `Retry-After` → wait that long; any other 403/401 → auth). 429/5xx retry with backoff and jitter, at most 5 attempts; auth errors are never retried.
  - `github`: the §7.1 `SourceAdapter`, plus normalizers shared with webhooks.
- **Integration services** (`src/server/integrations/`):
  - `service`: CRUD, enable/disable/archive, env var names only, with a reserved-name guard so an integration can't send `DATABASE_*`/`POSTGRES_*`/`SITESYNC_*` values to GitHub; §5.6 health with audited transitions; test connection.
  - `repo-links`: one primary per website; repository summary; latest check per name.
  - `github-sync`: §7.2 bounds; idempotent upsert where only newer provider data overwrites; closes PRs that disappeared; poll due-ness with the rate-limit skip.
  - `webhooks`: §7.3/§5.5 receive with 1 MiB cap, HMAC, dedupe, allowlist and redacted bounded storage; process; 8-attempt backoff → dead-letter; replay (audited); prune.
- **Readiness:** `failing_check` blockers come from the latest check run per name on the proposed commit (the production branch head from the last sync or push webhook). A disconnected or erroring integration adds a note, never a blocker. Waivers are verified against current blockers, including check blockers.
- **Screens:**
  - 17 `/integrations`: health, env var set/not set (never values), last test/sync/error, rate limit, webhook URL, test/enable/disable/archive/edit, webhook deliveries with replay for dead letters, and the §1.1 auto-deploy caveat.
  - Website detail: repository links with checks on the head, recent commits, open PRs into production, refresh and unlink, plus the link form.
  - Overview readiness: notes, and check blockers that link out to GitHub.
  - Sidebar: Integrations enabled.
- **Route:** `POST /api/webhooks/github/[integrationId]`. HMAC-authenticated, so no session and no Origin check.
- **Docs:** decision 0009, `docs/github.md` (token permissions, env var, linking, readiness, webhooks via an operator-run tunnel), README sections, `.env.example` optional names, decision 0005 updated for pg-boss.

### 2. Commands run and actual results
- `npm run lint` → clean. `npm run typecheck` → passes.
- `npm run db:migrate` (dev) → `9/9 applied, 0 pending`, plus the job store set up.
- A pg-boss probe as `sitesync_app` confirmed send, work and stately dedupe with no permission errors.
- `npm test` → **14 files, 241 tests passed**. A guard fails any un-mocked network request, and adapters use a scripted fake GitHub. New in Phase 3a:
  - `providers` unit tests (33):
    - SSRF guard incl. metadata IP, localhost, ports, credentials, cross-host redirect;
    - rate-limit classification per GitHub docs; 429 Retry-After; 5xx backoff and give-up; auth never retried; far reset → give up;
    - rate-limit headers reported; bearer token and API version only to api.github.com;
    - normalization (subject line, unknown fields dropped, merged PRs, check states); pagination bounds and truncation; branch paths with slashes; malformed response;
    - HMAC valid/invalid/missing/tampered; retry backoff schedule;
    - reserved env var names; §5.6 health transitions; redacted error detail.
  - `github` integration tests (23):
    - env var names only (token value appears nowhere in the DB or audit); reserved/webhook validation; test connection ok/auth error/missing env var with audited health changes; disabled never called; archive guard;
    - sync stores head/commits/PRs/checks; idempotent; older data never overwrites; disappeared PRs closed; rate limit → degraded + poll skip until reset; poll enqueues only due links;
    - readiness: failing/running checks block, passing/neutral don't; commit-scoped waiver applies to that head only; disconnected integration → note, and tasks/stage moves still work;
    - repo link validation and primary handling;
    - webhooks: 404 when disabled/unknown; 401 for bad/missing/wrong signature with nothing stored; 413; duplicate → 200; non-allowlisted → ignored; push moves the head and records commits; check_run updates checks; body redaction; retry → dead-letter at 8 → replay (audited); retention keeps dead letters;
    - runtime role runs pg-boss incl. scheduler/maintenance with no errors and no DDL; allowlist enforced; no `DELETE` on events/integrations.
- `npm run test:e2e` → **27 passed**:
  - add an integration (reserved name refused), test without the env var → Not configured;
  - link a repository (validation) → readiness note, no check blocker;
  - webhook endpoint 404 while disabled → enable → wrong/missing signature 401, valid 202, duplicate 200, oversize 413 → ping processed by the job runner;
  - webhook route vs Origin-checked routes;
  - earlier phases unchanged.
  - The server log showed no job-runner errors.
- `npm run build` → succeeds.
- Screens checked at 1280 px and 768 px. Secret scan → clean (the only token-shaped strings are fake values in tests).

### 3. Setup steps and env var names
- `npm install` (adds `pg-boss`), then `npm run db:migrate`.
- Optional, names of your choice (spec §10 suggests): `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`.
- New optional switch: `SITESYNC_JOBS=off`.
- See `docs/github.md`.

### 4. Credentials/config the operator still needs to provide
None required. To use GitHub: a fine-grained read-only token in `.env`, then add the integration and test it.

### 5. Known limitations / unmet criteria
- **Verified against the real GitHub API (2026-11-03)**, with a fine-grained token on `ThePerfectWebsite/SITESYNC-CRM` (this project, pushed there; public).
  - **Confirmed live:** auth (`GET /user`), repository info, rate-limit headers, branch head, commits (correct subjects), the open-PR list, check runs from the repo's own CI (seen moving queued → in_progress → completed/success), a full sync (health ok), readiness judged at the real head with passing checks (no blockers), and idempotent re-sync (0 writes).
  - **Live findings, fixed and tested:** a private repo the token isn't granted returns 404, now reported as "GitHub can't see owner/repo…". An empty repository returns 404 for the branch and 409 "Git Repository is empty" for commits; it now syncs as OK with "no commits yet".
  - **Not yet seen live:** a *failing* check (blocking is covered by integration tests using the response shapes confirmed live), and access to a private repository.
- **CI** (`.github/workflows/ci.yml`, added after Phase 3a): lint + typecheck, and unit + integration + E2E against a Postgres 18.6 service with the init script's roles. First run on `70af0dc` passed both jobs.
- `pr_open` stays informational, as OQ-7 allows: open PRs into production are shown, not blocking. Flagging a PR as "must merge" isn't built.
- Polling runs every 5 minutes, and a link is synced when it's older than `sync.poll_interval_minutes` (default 10). There's no UI for the interval yet; set the `app_settings` key, range 5–60.
- One process runs the job runner. Webhook processing is retried by our inbox logic, not pg-boss retries (decision 0009).
- Webhook ordering: an older delivery processed late can't overwrite newer data (upserts compare `provider_updated_at`), but a push webhook always moves the stored branch head.
- Netlify/Vercel are refused for now (Phase 3b).

### 6. Next phase and decisions needed first
Next: **Phase 3b — Hosting read sync.** Before starting:
- Netlify and Vercel tokens are only needed for live use; 3b can be built and tested against fakes like 3a.
- 3b must:
  - verify the provider APIs and auto-publish settings against official docs (Phase S handoff §5, spec §1.1) and record them in a decision;
  - add `hosting_links` and `deployments`, plus the deferred FKs from decision 0007 (`stage_history.deployment_id`, `changes.shipped_in_deployment_id`) and a database-backed `DeploymentFacts`, so the "no connected host" message, skip-over-Live rule and `go_live` start using real data;
  - add `preview_not_ready` and the unwaivable `hosting:missing` blockers to readiness (decision 0008).
- Reuse `providerFetch`, `createHttpClient`, the integrations table and health logic, the job runner, and `tests/support/fake-github.ts` as the pattern for fake Netlify/Vercel APIs.

---

## Handoff — Phase 2 (2026-11-03)

### 1. Phase completed and key areas changed
Phase 2 — Work tracking. Committed on `main` after Phase 1 (`bc21374`).
- **Migrations:**
  - `0005_work_tracking` (generated): `tasks`, `changes`, `release_checklist_items`, `readiness_waivers`. It includes:
    - every §3.14–§3.17 check and index;
    - `tasks` `done ⇔ completed_at`;
    - the one-active-waiver partial unique index;
    - a trigram index on task titles.
    - The statement order was hand-fixed so `project_stages (id, project_id)` is unique before the FK that needs it.
  - Two composite FKs keep links within one project: a task's stage, and a change's task (decision 0008 §C).
  - `0006_work_tracking_triggers_grants_seed` (hand-written): `updated_at` triggers; `SELECT, INSERT, UPDATE` grants (no `DELETE`); and the default `release_checklist.template` seed (10 items, `ON CONFLICT DO NOTHING`).
- **Services** (`src/server/records/`):
  - `tasks`: complete/reopen are the only way in and out of `done`; an archived project's work is read-only; overdue and due-between queries.
  - `changes`: the requesting contact must belong to the project's client; the task must be in the same project.
  - `checklist`: template get/save (existing keys kept, new keys from labels); instantiated on project creation; "add from template" skips existing keys; check/uncheck with a note; archive/restore.
  - `readiness`: pure `evaluateReadiness`/`waiverApplies`, `computeReadiness`, waive (only current, waivable blockers; reason required; optional commit SHA), revoke.
  - `dates`: app time zone, `todayIn`, `addDays`, `isOverdue`.
  - `search` now includes tasks.
- **Screens:**
  - 10 Tasks tab: open/all/archived views, add, complete/reopen, detail and edit page.
  - 11 Changes tab: list, log, detail and edit page.
  - 9 Overview: readiness summary with waive/revoke, and a readiness note on "Advance to Ready to Deploy" (§5.1).
  - 14 Project settings: release checklist with check/note/remove/restore and "Add checklist from template".
  - 4 Dashboard: stage chart, overdue projects and tasks, next 14 days (tasks due, target launches), recent activity.
  - 19 Settings: checklist template editor and time zone.
  - Quick-create Task (`/tasks/new`) and Change (`/changes/new`, picks the project first).
- **Decision 0008:** readiness covers manual blockers only until providers exist; "today" comes from the app time zone; the same-project composite FKs.

### 2. Commands run and actual results
- `npm run lint` → clean. `npm run typecheck` → passes.
- `npm run db:migrate` (dev) → `7/7 applied, 0 pending`. The test DB is reset and re-migrated by the suites.
- `npm test` → **12 files, 185 tests passed**. New in Phase 2:
  - `readiness-and-dates` unit tests (16): waiver matching incl. commit-scoped, unwaivable blockers, inactive waivers; dates across time zones, DST, month/year/leap boundaries; "due today isn't overdue"; checklist key derivation.
  - `work` integration tests (22):
    - task validation and the complete/reopen invariants, in the service and the DB check;
    - the composite FKs;
    - archived projects are read-only;
    - overdue and next-14-days boundaries;
    - the `app.time_zone` setting and its fallback;
    - task search;
    - change contact/task rules and audit;
    - checklist instantiation, "add from template" skipping existing keys, template key stability, check/uncheck DB check;
    - readiness: critical tasks; done/cancelled/archived clear; non-required/archived items don't block; waive needs a reason and is audited; one active waiver; revoke; re-waive; commit-scoped; no `DELETE` grants.
- `npm run test:e2e` → **23 passed** (17 from earlier phases + 6 new):
  - project starts with 10 checklist blockers;
  - a critical task blocks readiness until done; the priority choice survives a validation error;
  - checking 9 items, then waive (reason required) → ready, revoke → not ready, check the last → ready; activity shows the waive and the revoke;
  - change needs a category;
  - quick-create task → dashboard overdue → Ctrl-K finds it;
  - template gains an item, time zone validated and canonicalised, older project picks the item up.
- `npm run build` → succeeds; all routes dynamic.
- Screens checked at 1280 px and 768 px. The checklist rows were cramped at 768 px; they now stack below 1024 px.
- Auth coverage: every `(app)` page calls `requireSession()` (directly or via `loadProjectTab`), and every exported record Server Action calls `requireActor(...)`.
- Secret scan → clean.

### 3. Setup steps and env var names
No new env vars. Run `npm run db:migrate`. The time zone defaults to the server's; set it under Settings → Time zone.

### 4. Credentials/config the operator still needs to provide
None.

### 5. Known limitations / unmet criteria
- **Readiness = manual blockers only** (decision 0008). Failing checks, open PRs, preview state and "no production target" arrive with Phases 3a–4. The Phase 4 gate must recompute readiness with them and the proposed commit.
- Commit-scoped waivers can be created now but never match on the overview, because there's no proposed commit until deployments exist.
- `changes.shipped_in_deployment_id` has no FK and no UI until deployments exist (decision 0007).
- If saving the checklist template fails validation (e.g. an existing item's label cleared), the form shows the error but resets to the saved template, so other unsaved edits in that submit are lost.
- Quick-create Task has no stage picker (set it on the task page). Quick-create Change picks the project, then logs the change on that project's Changes tab.
- Projects created in Phase 1 (before this migration) have no checklist until you use "Add checklist from template" on their Settings tab.

### 6. Next phase and decisions needed first
Next: **Phase 3a — GitHub read sync.** Before starting:
- Decide on a GitHub token: a fine-grained PAT with read-only access to the relevant repos is suggested; its env var name is the operator's choice (spec §10 suggests `GITHUB_TOKEN`). Without one, Phase 3a can still be built and tested against a mocked API.
- pg-boss gets pinned in 3a (decision 0005 lists 12.38.0 as the latest seen), and `pruneLoginAttempts()` gets scheduled then (Phase 0 limitation).
- Readiness needs the `failing_check` blocker for the proposed commit. Plug it into `computeReadiness` alongside `manualBlockers` (decision 0008).

---

## Handoff — Phase 1 (2026-11-03)

### 1. Phase completed and key areas changed
Phase 1 — Core records. Committed on `main` after Phase 0 (`e96517e`).
- **Migrations:**
  - `0003_core_records` (generated): `clients`, `contacts`, `websites`, `stage_templates`, `stage_template_steps`, `projects`, `project_stages`, `stage_history`. It includes:
    - every spec §3.6–§3.13 check, partial unique index and trigram index;
    - the composite FK `projects_website_same_client_fk` (decision 0001);
    - the one-current-stage index;
    - `stage_history` checks that make `go_live` system-only and require a deployment.
  - `0004_core_records_triggers_grants_seed` (hand-written):
    - the deferrable `(template, position)` unique constraint;
    - `updated_at` triggers;
    - append-only triggers on `stage_history`;
    - two deferred constraint triggers: template shape, and exactly one current stage per project;
    - grants: `SELECT, INSERT, UPDATE` on core tables (no `DELETE`: archive, don't delete); `SELECT, INSERT` on `stage_history`;
    - the "Standard website project" template seed, guarded by "no templates exist".
- **Stage machine** (`src/server/stages/`):
  - `machine.ts`: pure §5.1 rules (initial, advance, skip_forward, move_back, hold, resume, archive, restore, go_live) plus `inferTransition` for the UI.
  - `service.ts`: one transaction per transition — lock, optimistic `expectedCurrentStageId`, status updates, audit, history.
  - `systemGoLive()` exists for Phases 3b/4 but nothing calls it.
  - `deployment-facts.ts`: the interface for hosting/deployment facts, answering "none" until those tables exist (decision 0007).
- **Record services** (`src/server/records/`):
  - `clients`, `contacts` (one primary per client), `websites` (domain normalized), `projects` (copies template steps, decision 0003), `templates` (step rename), `search` (ILIKE + `pg_trgm` `%`), `activity`;
  - shared Zod `fields`, `errors` (`DomainError`), `actor`.
  - Every create, update, archive and restore writes a redacted audit event.
- **Screens:**
  - 4 Dashboard skeleton: projects per stage, overdue projects, recent activity without sign-ins.
  - 5 `/clients`: search, status, archived toggle.
  - 6 `/clients/[id]`: contacts, websites, projects, activity.
  - 7 `/websites/[id]`: no integrations yet.
  - 8 `/projects`: filters for stage, client and overdue; archived toggle; sorted by target date.
  - 9 `/projects/[id]`: stage rail and moves; "no connected hosting provider" explanation.
  - 12 `/projects/[id]/activity`.
  - 14 `/projects/[id]/settings`: details, archive.
  - 19 `/settings`: read-only templates, session, mode, backup, version.
  - Also: `/search`, plus new/edit pages for clients, websites and projects.
  - Header: global search (Ctrl/Cmd-K focuses it) and a working "New" quick-create menu.
- **Decision 0007:** stage rules that depend on deployments, before the deployments tables exist.

### 2. Commands run and actual results
- `npm run lint` → no problems. `npm run typecheck` → passes.
- `npm run db:migrate` (dev) and `npm run db:migrate -- --test` → `5/5 applied, 0 pending`.
- `npm test` → **10 files, 147 tests passed**. New in Phase 1:
  - `stage-machine` unit tests (31): every transition, invalid ones, Live never reachable by a user, skip-over-Live with and without an integration-backed link, go_live deployment checks.
  - `stages` integration tests:
    - composite FK rejects a cross-client website in the DB (23503) and in the service;
    - website change refused once deployments exist;
    - transitions persist history and audit; stale expected stage refused;
    - go_live refuses manual-record and unconfirmed deploys, and succeeds as system with a fake confirmed deploy;
    - DB refuses a user `go_live` row;
    - **atomicity:** an injected failure after the history insert leaves stages, audit and history untouched (user path and go_live path);
    - one-current-stage unique index and deferred trigger;
    - `stage_history` append-only for both roles;
    - archive/restore, including from On Hold and code clashes;
    - a template edit doesn't affect existing projects;
    - list filters, including overdue.
  - `records` integration tests: validation, slug generation, audit before/after, archive/restore and "archive children first", one primary contact, domain rules, search incl. typo and wildcard escaping, scoped activity.
- `npm run test:e2e` → **17 passed** (11 Phase 0 + 6 new):
  - create client → contact → website → project → advance → skip with reason → activity shows both moves and the reason, with no console errors;
  - Ready to Deploy explanation, and no "Advance to Live";
  - Ctrl-K search by project code;
  - archive hides from list, restore returns to the same stage;
  - stage filter and dashboard count;
  - malformed and unknown ids return 404.
- `npm run build` → succeeds; all routes dynamic.
- Screens checked by screenshot at 1280 px and 768 px.
- Secret scan of changed files → clean; no `0.0.0.0` binding.

### 3. Setup steps and env var names
No new env vars or setup steps. Run `npm run db:migrate` to apply `0003`/`0004`.

### 4. Credentials/config the operator still needs to provide
None.

### 5. Known limitations / unmet criteria
- **No project can reach Live yet.** `go_live` only runs from the deployment confirmation path (Phases 3b/4). Until then projects stop at Ready to Deploy, or skip past Live with a reason (Live is recorded as skipped). This follows decisions 0004 and 0007.
- `stage_history.deployment_id` has no FK until `deployments` exists. Phase 3b must add it, together with a real `DeploymentFacts` (decision 0007).
- Template editing UI is not built. The service can rename steps; the full editor is in a later phase.
- Global search is a results page reached from the header box (Ctrl/Cmd-K focuses it), not an as-you-type popup. Tasks join search in Phase 2.
- Tasks, Changes and Deployments tabs and the readiness summary are placeholders.
- "Overdue" compares the target launch date with today in the server's local time zone. Date-boundary tests for tasks are Phase 2.
- Sticky table headers apply at ≥1024 px only. Below that, tables scroll horizontally, and a sticky header inside the scroll container would overlap rows.
- Archiving a client or website is refused while it has live projects (or a client has live websites). Archive the children first.

### 6. Next phase and decisions needed first
Next: **Phase 2 — Work tracking.** No open decisions. Reminders:
- New tables need explicit grants (decision 0006). Follow Phase 1 and grant no `DELETE` where records are archived.
- `readiness_waivers` and checklist items hang off projects. Readiness feeds the RTD confirmation and the overview's "Readiness" placeholder.
- Add tasks to `searchRecords` and to the quick-create menu (currently disabled items).
- Use `requireActor(...boundIds)` in record Server Actions and `runForm` for DomainError → form state. Forms use `key={state.key}` so they remount with echoed values: React resets fields after an action, and a select's `defaultValue` can't change after mount.

---

## Handoff — Phase 0 (2026-11-03)

### 1. Phase completed and key areas changed
Phase 0 — Foundation. Project folder: `C:\Users\jorda\SiteSync-App` (git repo on `main`; Phase 0 is the first commit).
- **Tooling:** pinned versions (decision 0005): Next 16.4.4, React 19.3.0, TypeScript 5.9.3, ESLint 9.39.5, Tailwind 4.3.4, shadcn/ui (radix-nova), Drizzle 0.45.4, Zod 4.6.7, Vitest 5.1.0, Playwright 1.64.1, Postgres 18.6. `.nvmrc` 26, `engines`, `.gitignore`, `.gitattributes` (LF for migrations).
- **Database:** `docker-compose.yml` (Postgres bound to `127.0.0.1:5432`, named volume, healthcheck); `docker/initdb/01-roles-and-databases.sh` creates `sitesync_owner` / `sitesync_app` and the `sitesync` + `sitesync_test` databases (decision 0006).
- **Migrations** (`drizzle/`): `0000` extensions (`pgcrypto`, `citext`, `pg_trgm`) + `set_updated_at()` + `reject_mutation()`; `0001` `users`, `sessions`, `login_attempts`, `app_settings`, `audit_events` with all spec checks and indexes; `0002` `updated_at` triggers, append-only triggers on `audit_events`, explicit grants for `sitesync_app`.
- **Server** (`src/server/`): `env-schema`/`env` (Zod, server-only), `redact`, `audit` (redacted, size-bounded), `db` (pool + Drizzle), `db/migrations-info`, `auth/` (scrypt `password`, `session`, `throttle`, `policy`, `service` for setup/login/logout, `next` with `requireSession()` and cookie helpers), `http/origin` (Origin/Referer check), `http/csp`, `http/request`.
- **App:** `src/proxy.ts` (per-request CSP nonce), static security headers in `next.config.ts`; routes `/setup`, `/login`, `POST /logout`, `/health`, dashboard `/` inside the app shell (sidebar, breadcrumbs, disabled search and quick-create placeholders, skip link, visual tokens).
- **Scripts:** `db:migrate`, `db:status`, `db:generate`, `db:backup`, `db:restore` (+ `--test` for migrate/status).
- **Docs:** `README.md` (setup, scripts, security summary, §1.1 caveat), `docs/lan-mode.md` (stub), decisions `0005` (toolchain versions) and `0006` (DB roles, migration layout, extra env vars).

### 2. Commands run and actual results
- `npm run lint` → no problems.
- `npm run typecheck` → passes.
- `npm run db:migrate` → applied to `sitesync`; `npm run db:status` → `3/3 applied, 0 pending`. `npm run db:migrate -- --test` → applied.
- `npm test` → **7 files, 75 tests passed** (unit: scrypt hash/verify/rehash, policy, redaction, env parsing, Origin check, CSP, token decoding, throttle curve; integration: first-run creates exactly one admin incl. 4 concurrent submissions, second setup refused, login success/failure/disabled/rehash/rotation, throttling incl. window/reset/cap/prune, idle + absolute expiry, idle bump ≤ 1/min, settings-driven lifetimes, revocation, logout, audit UPDATE/DELETE/TRUNCATE rejected by trigger as owner and by grants as app role, audit constraints).
- `npm run test:e2e` → **11 passed** (health; pre-setup redirects; setup validation + creation; `/setup` 404 afterwards; unauthenticated redirect; generic login error; login → shell → logout with cookie flags checked; cross-origin logout → 403; security headers; hydration with no CSP violations or console errors; skip link).
- `npm run build` → succeeds; every route is dynamic (`ƒ`).
- `npm run db:backup` then `npm run db:restore -- <file>` (non-interactive) → backup written; restore created `sitesync_restore_…`, report showed 3/3 migrations, row counts, audit triggers present, **Verification: PASSED**. The smoke-test restore database and dump were then removed. Full drill is Phase 5.
- Secret scan of untracked files for the generated DB passwords → none found; `.env` is git-ignored.
- `npm audit` → 20 moderate advisories, all dev-only tooling (decision 0005).

### 3. Setup steps and env var names
See `README.md` § Setup. Env var names (values only in git-ignored `.env`, which this session generated with random passwords): `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `SITESYNC_OWNER_PASSWORD`, `SITESYNC_APP_PASSWORD`, `DATABASE_URL`, `DATABASE_OWNER_URL`, `DATABASE_URL_TEST`, `DATABASE_OWNER_URL_TEST`, `SITESYNC_APP_ORIGIN`, `SITESYNC_LAN_MODE`, `SITESYNC_PUBLIC_ORIGIN`. The four `*_PASSWORD`/`*_OWNER_URL` names are additions to spec §10 (decision 0006). Playwright needs `npx playwright install chromium` once (done on this machine).

### 4. Credentials/config the operator still needs to provide
None. The dev database is migrated but has **no admin yet**: open <http://127.0.0.1:3000> after `npm run dev` and create it at `/setup`.

### 5. Known limitations / unmet criteria
- **Use `http://127.0.0.1:3000`, not `localhost`.** Sign-out checks `Origin` against `SITESYNC_APP_ORIGIN` exactly.
- The session cookie is `Secure` per spec. Chromium (E2E) and current Firefox accept it on `http://127.0.0.1`; Safari historically didn't, so sign-in may not stick there without LAN-mode HTTPS.
- The throttle check and the attempt record aren't one atomic step, so truly parallel guesses can slip inside one delay window. Acceptable for a single local operator; revisit if LAN mode is used.
- `pruneLoginAttempts()` exists and is tested but isn't scheduled until pg-boss lands (Phase 3a).
- Global search and quick-create are visible but disabled until Phase 1. Sidebar sections not built yet show "Soon".
- Redaction's Vercel token pattern (`vc?_…`) is a guess, to be checked against docs in Phase 3b.
- LAN mode: env handling and docs stub only; no reverse-proxy walkthrough or test yet (Phase 5).
- Backup/restore: smoke-tested on an empty database only; the restore drill with real data is Phase 5.

### 6. Next phase and decisions needed first
Next: **Phase 1 — Core records.** No open decisions. Reminders for Phase 1:
- Every new table migration must `GRANT` exactly what `sitesync_app` needs (decision 0006); `stage_history` gets `SELECT, INSERT` only plus the `reject_mutation()` triggers.
- `pg_trgm` is already installed for the trigram search indexes.
- Use `requireSession()` as the first call in every new Server Action and Route Handler, and `rejectCrossOrigin()` in mutating Route Handlers.

---

## Handoff — Phase S (2026-11-03)

### 1. Phase completed and key areas changed
Phase S. Created:
- `docs/SiteSync-Control-Centre-Specification.md` — full schema (25 tables incl. one addition, `login_attempts`), constraints and indexes, auth/security rules, state machines (project stage, deployment, SiteSync dispatch, approval, webhook inbox, integration health), readiness rules, adapter interfaces, deployment gate, screen list, operations, open questions.
- `docs/implementation-plan.md` — per-phase build and test scope.
- `docs/implementation-status.md` — this file.
- `docs/decisions/0001`–`0003`.

No application code was written.

### 2. Commands run and actual results
- `node --version` → `v26.13.0` (matches Node 26 target).
- `docker --version` → no output (Docker not found on PATH).
- `git --version` → `2.45.1.windows.1`. The folder is not yet a git repository; Phase 0 runs `git init`.
- Lint, typecheck, migrations and tests: **not run — there is no code yet.** Not applicable to Phase S.

### 3. Setup steps and env var names
None yet. Planned names are listed in spec §10.

### 4. Credentials/config the operator still needs to provide
None for Phase 0. Provider tokens are only needed from Phase 3a, and only if the operator wants sync.

### 5. Known limitations / unmet criteria
- Provider API details (Vercel promote, Netlify restore/lock, auto-publish settings) are written from general knowledge and **must be verified against official docs** in Phases 3b/4 before implementation.
- Exact dependency versions (Next.js 16.x, Postgres major, Drizzle, pg-boss) not yet verified; done in Phase 0.

### 6. Next phase and decisions needed first
Next: **Phase 0 — Foundation.** Before starting, the operator should:
1. ~~Review the spec and answer open questions.~~ Done 2026-11-03: OQ-1 strict (decision 0004); OQ-2 to OQ-8 defaults accepted.
2. ~~Install Docker Desktop.~~ Done: `docker --version` → 29.9.2, `docker compose version` → v5.6.1, daemon running (linux engine).
3. Choose a permanent project folder.
