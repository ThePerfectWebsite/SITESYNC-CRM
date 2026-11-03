# SiteSync Control Centre — Implementation Plan

One phase per session. Each phase ends with the definition of done: `npm run lint`, `npm run typecheck`, migrations applied to a disposable test DB, the phase's tests passing, a diff review (secrets, destructive migrations, non-localhost binding, server-side auth/validation, approval checks, accessibility, stale docs), and an updated `docs/implementation-status.md` + handoff.

Spec references (§) point to `docs/SiteSync-Control-Centre-Specification.md`.

---

## Phase S — Specification ✅ (approved 2026-11-03)

Deliverables: spec, this plan, status doc, initial decision records. No app code.
Exit: operator has reviewed the spec and answered the open questions (spec §11).

## Phase 0 — Foundation ✅ (2026-11-03)

Build:
- `git init`, `.gitignore` (env files, `backups/`, `.next/`, `node_modules/`, Playwright output), `.nvmrc` (26), `engines`.
- Next.js 16 App Router + TypeScript strict, Tailwind, shadcn/ui, ESLint. App shell: sidebar, breadcrumbs, empty search/quick-create placeholders, visual tokens (§9).
- `docker-compose.yml`: Postgres (current stable major, verified), named volume, healthcheck; a second database for tests (`sitesync_test`) created by an init script.
- Drizzle config + first migrations: extensions, `set_updated_at()`, `reject_mutation()`, roles, `users`, `sessions`, `login_attempts`, `app_settings`, `audit_events` (with triggers).
- `src/server/`: `db`, `env` (Zod-parsed, server-only), `redact`, `audit`, `auth` (scrypt, sessions, throttling), `requireSession`, Origin check helper for Route Handlers, security headers.
- Routes: `/setup`, `/login`, logout, `/health`.
- Scripts: `dev`, `build`, `start` (all `-H 127.0.0.1`), `lint`, `typecheck`, `test`, `test:e2e`, `db:migrate`, `db:status`, `db:backup`, `db:restore` (backup/restore functional but drilled in Phase 5).
- `.env.example` with names only; README setup section; LAN-mode doc stub.

Tests:
- Unit: scrypt hash/verify/rehash, redaction, env parsing, Origin check.
- Integration (test DB): first-run creates exactly one admin, second call refused (incl. concurrent); login throttling; session expiry (idle + absolute) and revocation; audit UPDATE/DELETE/TRUNCATE rejected by trigger.
- E2E: setup → login → shell renders → logout; unauthenticated redirect.

Decide first: OQ-5 (session lifetimes), OQ-8 (Docker installed).

## Phase 1 — Core records ✅ (2026-11-03)

Build: migrations for `clients`, `contacts`, `websites`, `stage_templates`, `stage_template_steps` (+ seed), `projects` (composite FK), `project_stages`, `stage_history` (append-only). Services with Zod validation + audit for CRUD/archive/restore. Stage service implementing §5.1 (everything except `go_live`, which exists but is only callable by the system path and is unit-tested with a fake deployment). Search (trigram) and filters. Screens 4 (skeleton), 5, 6, 7 (no integrations yet), 8, 9, 12, 14, 19 (shell).

Tests: composite FK rejects cross-client website (DB + service); stage transitions incl. invalid ones; `go_live` refuses manual-record / non-provider deployments and skipping over LIVE is refused when an integration-backed production link exists (decision 0004); atomicity (inject failure after history insert → nothing persisted); user cannot move to LIVE; one-current-stage index; archive/restore; archived records hidden by default; template change doesn't affect existing projects; E2E create client → website → project → advance stage → activity shows it.

## Phase 2 — Work tracking ✅ (2026-11-03)

Build: `tasks`, `changes`, `release_checklist_items`, `readiness_waivers`; checklist template in settings; `computeReadiness()` (§6) with manual blockers only; waive/revoke with audit; dashboard metrics (stage counts chart, overdue, deadlines, recent activity); tabs 10, 11, checklist on 14, readiness on 9.

Tests: readiness blocker computation and waiver matching (incl. `commit_sha`-scoped); waiver requires reason; task complete/reopen invariants; overdue logic around date boundaries/time zones; E2E task + checklist → readiness clears.

## Phase 3a — GitHub read sync ✅ (2026-11-03)

Build: `integrations`, `repository_links`, `repository_events`, `webhook_inbox`; `providerFetch()` allowlist; GitHub adapter (§7); pg-boss setup + decision record; jobs: initial sync, poll, manual refresh with singleton keys; rate-limit-aware retry; integrations screen (17) basic; failing checks feed readiness. Webhook route disabled by default (§7.3), inbox processing, retry → dead-letter, replay UI.

Tests (MSW/nock, no real network — a test guard fails any un-mocked request): adapter normalization, pagination bounds, 429/`Retry-After` backoff, auth error → health `error`; upsert idempotency; webhook HMAC valid/invalid/missing, oversize, duplicate delivery, non-allowlisted, retry/dead-letter, replay; SSRF guard rejects non-allowlisted host; disconnected integration doesn't block manual flows.

## Phase 3b — Hosting read sync ✅ (2026-11-03)

Build: `hosting_links`, `deployments` (read side); Netlify adapter then Vercel; state mapping (§5.2) with tests; auto-publish detection + caveat UI (§1.1); website deploy history (7) and project deployments tab (13); dashboard deployment alerts and sync errors. Decision record with verified provider endpoints and the settings that prevent auto-deploy.

Tests: state mapping tables per provider; supersede logic; out-of-order updates; auto-publish detection; OQ-2 prompt behaviour (if accepted).

## Phase 4 — Approval-gated deployment

Build: `production_approvals`; decision record verifying promote/restore APIs; adapter `promote()`; preflight (15), approve, final confirmation (16), executor (§8.4), confirmation job (§5.3), `go_live` wiring, rollback approvals, recovery UI.

Tests: all of spec §8.6, plus terminal-state trigger, hash mismatch on approve, stale data (>5 min) disables approve, late confirmation after timeout.

## Phase 5 — Operations & polish

Build: backup/restore finalized and **restore drill run once** (documented with real output); integrations polish (dead-letter, reconciliation); audit/activity screen (18) with filters; settings (19) complete; accessibility pass (axe in Playwright, keyboard walkthrough); README finalized against acceptance criteria.

Tests: backup/restore script on test DB; axe checks on every screen; full acceptance-criteria walkthrough.
