# Implementation Status

| Phase | Status | Session date |
|---|---|---|
| S — Specification | **Done — approved by operator** | 2026-11-03 |
| 0 — Foundation | **Done** | 2026-11-03 |
| 1 — Core records | **Done** | 2026-11-03 |
| 2 — Work tracking | **Done** | 2026-11-03 |
| 3a — GitHub read sync | Not started (ready) | |
| 3b — Hosting read sync | Not started | |
| 4 — Approval-gated deployment | Not started | |
| 5 — Operations & polish | Not started | |

**Current phase for the next session:** Phase 3a — GitHub read sync.

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
