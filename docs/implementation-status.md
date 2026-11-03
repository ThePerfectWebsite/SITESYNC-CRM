# Implementation Status

| Phase | Status | Session date |
|---|---|---|
| S — Specification | **Done — approved by operator** | 2026-11-03 |
| 0 — Foundation | **Done** | 2026-11-03 |
| 1 — Core records | Not started (ready) | |
| 2 — Work tracking | Not started | |
| 3a — GitHub read sync | Not started | |
| 3b — Hosting read sync | Not started | |
| 4 — Approval-gated deployment | Not started | |
| 5 — Operations & polish | Not started | |

**Current phase for the next session:** Phase 1 — Core records.

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
