# SiteSync Control Centre — Specification

Status: **v1 — approved by operator** (Phase S, 2026-11-03). Amended in Phase 3b: Cloudflare Pages added as a hosting provider (decision 0010). Amended in Phase 4: release mechanism verified, Cloudflare uses `build_from_ref`, two approval columns added (decision 0011).

This document is the source of truth for product behaviour and schema. The build prompt remains the source of truth for process, safety rules and stack. Where this spec and the prompt conflict on safety, the stricter rule wins.

Operator decisions on the original open questions are recorded in §11.

---

## 1. Product summary

SiteSync Control Centre is a local-first web app for **one operator** to run a small web studio: clients, their websites, projects against those websites, project stages, tasks, changes, release readiness and deployments.

- Runs on the operator's machine, bound to `127.0.0.1`.
- Everything works manually with zero provider credentials.
- GitHub, Netlify and Vercel are **read-synced** for facts (commits, PRs, checks, deploys). Production deploys initiated from SiteSync go through a human approval gate (§8).
- Providers remain authoritative for source and deployment facts. SiteSync stores normalized, redacted snapshots and its own operational history. It never clones or stores source code.

### 1.1 Known limitation (shown in UI and docs)

> **SiteSync cannot stop a hosting provider from auto-deploying to production on push or merge.** If auto-publishing is enabled on the provider, code merged to the production branch can go live without passing through SiteSync's approval gate. To make the gate meaningful, lock auto-publishing on the provider:
> - **Netlify:** lock the published deploy ("Lock to stop auto publishing") or set the production branch builds to not auto-publish.
> - **Vercel:** disable automatic production deployments for the production branch (e.g. via the project's Git settings / `git.deploymentEnabled`, or by deploying production with "auto-assign custom domains" off so production requires a promote).
>
> Exact provider settings are verified against official docs in Phase 3b and recorded in `docs/decisions/`.

This text appears on: website detail (per hosting link with auto-publish on/unknown), the preflight screen, the integrations screen, and the README.

---

## 2. Conventions

### 2.1 Column conventions (all tables unless stated)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `DEFAULT gen_random_uuid()` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | Maintained by shared trigger `set_updated_at()` |

Exception: append-only tables (`audit_events`, `stage_history`) have `created_at` only, because rows can never be updated (see decision 0002).

- **Archive, don't delete.** Any row that can be referenced by history, deployments or audit has `archived_at timestamptz NULL` and `archived_by uuid NULL REFERENCES users(id)`. All FKs are `ON DELETE RESTRICT` unless stated. Uniqueness that should only apply to live rows uses partial indexes `WHERE archived_at IS NULL`.
- **Enums** are `text` + `CHECK (col IN (...))` rather than Postgres `ENUM` types, so adding values is an additive migration.
- **Bounded JSON.** Every `jsonb` column has `CHECK (octet_length(col::text) <= N)`. Default N = 16 KiB for metadata, 64 KiB for provider snapshots, 256 KiB for webhook bodies.
- **Bounded text.** Free text has a length check (`name` ≤ 200, `title` ≤ 300, `notes`/`description` ≤ 20 000, `reason` 3–2 000).
- **Identifiers from providers** are stored as `text` (never parsed as numbers).
- **Env var name columns** match `^[A-Z][A-Z0-9_]{0,63}$`. Values are never stored.
- **Hostnames/domains** stored lower-case, checked with `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`.
- **Commit SHAs** checked with `^[0-9a-f]{40}$` (full SHA only; short SHAs are display-only).
- **URLs** stored from providers are validated as `https://` (or `http://localhost` in tests) and length ≤ 2 048. They are displayed as links, never fetched server-side.

### 2.2 Shared database objects

- Extension: `pgcrypto` (for `gen_random_uuid()`), `citext`.
- Function `set_updated_at()` — `BEFORE UPDATE` trigger setting `NEW.updated_at = now()`.
- Function `reject_mutation()` — raises `EXCEPTION 'append-only table: % is not permitted', TG_OP`. Attached `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement) on append-only tables.
- The application connects as role `sitesync_app`, which owns no tables and has no `TRUNCATE` grant or `ALTER` on append-only tables. Migrations run as `sitesync_owner`. (Triggers are the enforcement; the role split is defence in depth.)

---

## 3. Schema

Tables are listed in dependency order. "Additions" beyond the prompt's minimum list are marked **(added)** with a reason.

### 3.1 `users`

| Column | Type | Constraints |
|---|---|---|
| `email` | `citext NOT NULL` | unique; length ≤ 254 |
| `display_name` | `text NOT NULL` | 1–200 |
| `role` | `text NOT NULL DEFAULT 'admin'` | `CHECK (role IN ('admin'))` — reserved for future roles |
| `password_hash` | `text NOT NULL` | scrypt output, base64 |
| `password_salt` | `text NOT NULL` | 16 random bytes, base64 |
| `password_params` | `jsonb NOT NULL` | `{"N":131072,"r":8,"p":1,"keylen":64}`; ≤ 256 bytes |
| `password_changed_at` | `timestamptz NOT NULL` | |
| `last_login_at` | `timestamptz NULL` | |
| `disabled_at` | `timestamptz NULL` | |

Password hashing: `crypto.scrypt(password, salt, 64, { N: 2**17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })`. Comparison with `crypto.timingSafeEqual`. Params are stored per row so they can be raised later; a successful login with outdated params rehashes. Password policy: 12–256 characters, checked against a small bundled list of common passwords; no composition rules.

### 3.2 `sessions`

| Column | Type | Constraints |
|---|---|---|
| `user_id` | `uuid NOT NULL` | FK `users` |
| `token_hash` | `bytea NOT NULL` | unique; SHA-256 of the 32-byte random cookie token |
| `expires_at` | `timestamptz NOT NULL` | absolute expiry (default 12 h) |
| `idle_expires_at` | `timestamptz NOT NULL` | sliding (default 2 h), bumped at most once/minute |
| `revoked_at` | `timestamptz NULL` | |
| `user_agent` | `text NULL` | ≤ 512 |
| `ip` | `inet NULL` | |

Index: `(user_id) WHERE revoked_at IS NULL`. The cookie (`ss_session`) holds the raw token; the DB stores only its hash. Cookie: `HttpOnly; SameSite=Lax; Path=/; Secure` (localhost is a secure context in modern browsers). All sessions are revoked on password change.

### 3.3 `login_attempts` **(added)**

Needed so throttling survives restarts.

| Column | Type | Constraints |
|---|---|---|
| `email_hash` | `bytea NOT NULL` | SHA-256 of lower-cased submitted email |
| `ip` | `inet NULL` | |
| `succeeded` | `boolean NOT NULL` | |

Index `(email_hash, created_at DESC)`, `(ip, created_at DESC)`. Policy: after 5 failures for an email in 15 min, require a growing delay (1 s, 2 s, 4 s … capped at 60 s) and show a generic message. Rows older than 30 days are pruned by a job (this table is operational, not audit).

### 3.4 `app_settings`

| Column | Type | Constraints |
|---|---|---|
| `key` | `text NOT NULL` | unique; `^[a-z][a-z0-9_.]{0,99}$` |
| `value` | `jsonb NOT NULL` | ≤ 16 KiB; validated by a Zod schema per key |
| `schema_version` | `integer NOT NULL DEFAULT 1` | |
| `updated_by` | `uuid NULL` | FK `users` |

Known keys: `release_checklist.template` (array of `{key,label,required}`), `session.idle_minutes`, `session.absolute_hours`, `approval.ttl_minutes` (fixed 30 in v1, read-only), `sync.poll_interval_minutes`, `backup.last_run`, `app.first_run_completed_at`.

### 3.5 `audit_events` (append-only)

| Column | Type | Constraints |
|---|---|---|
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | no `updated_at` |
| `actor_type` | `text NOT NULL` | `IN ('user','system','provider')` |
| `actor_user_id` | `uuid NULL` | FK `users`; `CHECK (actor_type <> 'user' OR actor_user_id IS NOT NULL)` |
| `action` | `text NOT NULL` | dotted verb, `^[a-z_]+(\.[a-z_]+)+$`, e.g. `project.stage_changed` |
| `subject_type` | `text NOT NULL` | table-ish name, e.g. `project` |
| `subject_id` | `uuid NULL` | |
| `client_id` | `uuid NULL` | denormalized for filtering; no FK (survives archive) |
| `website_id` | `uuid NULL` | as above |
| `project_id` | `uuid NULL` | as above |
| `summary` | `text NOT NULL` | ≤ 500, human readable |
| `before` | `jsonb NULL` | ≤ 16 KiB, redacted |
| `after` | `jsonb NULL` | ≤ 16 KiB, redacted |
| `metadata` | `jsonb NULL` | ≤ 16 KiB, redacted |
| `request_id` | `uuid NULL` | correlates events from one request/job |

Triggers: `reject_mutation()` on UPDATE, DELETE, TRUNCATE. Indexes: `(created_at DESC)`, `(subject_type, subject_id, created_at DESC)`, `(project_id, created_at DESC)`, `(client_id, created_at DESC)`, `(action)`.

### 3.6 `clients`

| Column | Type | Constraints |
|---|---|---|
| `name` | `text NOT NULL` | 1–200 |
| `slug` | `text NOT NULL` | `^[a-z0-9]+(-[a-z0-9]+)*$`; unique `WHERE archived_at IS NULL` |
| `status` | `text NOT NULL DEFAULT 'active'` | `IN ('prospect','active','paused','former')` |
| `notes` | `text NULL` | ≤ 20 000 |
| `archived_at`, `archived_by` | | |

Index: trigram GIN on `name` for search (`pg_trgm`).

### 3.7 `contacts`

| Column | Type | Constraints |
|---|---|---|
| `client_id` | `uuid NOT NULL` | FK `clients` |
| `name` | `text NOT NULL` | 1–200 |
| `email` | `citext NULL` | ≤ 254 |
| `phone` | `text NULL` | ≤ 50 |
| `role_title` | `text NULL` | ≤ 200 |
| `is_primary` | `boolean NOT NULL DEFAULT false` | |
| `notes` | `text NULL` | ≤ 5 000 |
| `archived_at`, `archived_by` | | |

Unique partial index: `(client_id) WHERE is_primary AND archived_at IS NULL` (one primary per client).

### 3.8 `websites`

| Column | Type | Constraints |
|---|---|---|
| `client_id` | `uuid NOT NULL` | FK `clients` |
| `name` | `text NOT NULL` | 1–200 |
| `primary_domain` | `text NULL` | hostname check; unique `WHERE archived_at IS NULL` |
| `status` | `text NOT NULL DEFAULT 'planned'` | `IN ('planned','in_development','live','retired')` |
| `notes` | `text NULL` | ≤ 20 000 |
| `archived_at`, `archived_by` | | |

**`UNIQUE (id, client_id)`** — target of the composite FK from `projects` (decision 0001).

### 3.9 `stage_templates`

| Column | Type | Constraints |
|---|---|---|
| `name` | `text NOT NULL` | unique `WHERE archived_at IS NULL` |
| `is_default` | `boolean NOT NULL DEFAULT false` | unique partial `(is_default) WHERE is_default AND archived_at IS NULL` |
| `description` | `text NULL` | ≤ 2 000 |
| `archived_at`, `archived_by` | | |

### 3.10 `stage_template_steps`

| Column | Type | Constraints |
|---|---|---|
| `stage_template_id` | `uuid NOT NULL` | FK `stage_templates` |
| `key` | `text NOT NULL` | `^[a-z][a-z0-9_]{0,49}$`; unique `(stage_template_id, key)` |
| `name` | `text NOT NULL` | 1–100 |
| `position` | `integer NOT NULL` | ≥ 0; unique `(stage_template_id, position) DEFERRABLE INITIALLY DEFERRED` (for reordering) |
| `kind` | `text NOT NULL DEFAULT 'linear'` | `IN ('linear','on_hold','archived')` |
| `role` | `text NULL` | `IN ('ready_to_deploy','live')`; unique partial per template; gates behaviour in §5.1 |
| `description` | `text NULL` | ≤ 2 000 |

Each template must contain exactly one `on_hold` step, one `archived` step, one step with `role='ready_to_deploy'` and one with `role='live'`, with `live` positioned after `ready_to_deploy`. Enforced in the service layer on save, and by a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` that validates the template at commit.

**Seed (once, in a data migration guarded by "no templates exist"):** template "Standard website project" (`is_default = true`):

| pos | key | name | kind | role |
|---|---|---|---|---|
| 0 | `enquiry` | Enquiry | linear | |
| 1 | `discovery` | Discovery | linear | |
| 2 | `design` | Design | linear | |
| 3 | `build` | Build | linear | |
| 4 | `client_review` | Client Review | linear | |
| 5 | `ready_to_deploy` | Ready to Deploy | linear | `ready_to_deploy` |
| 6 | `live` | Live | linear | `live` |
| 7 | `maintenance` | Maintenance | linear | |
| 100 | `on_hold` | On Hold | on_hold | |
| 101 | `archived` | Archived | archived | |

### 3.11 `projects`

| Column | Type | Constraints |
|---|---|---|
| `client_id` | `uuid NOT NULL` | FK `clients` |
| `website_id` | `uuid NOT NULL` | **composite FK `(website_id, client_id) REFERENCES websites (id, client_id)`** |
| `stage_template_id` | `uuid NOT NULL` | FK `stage_templates` (the template it was created from) |
| `name` | `text NOT NULL` | 1–200 |
| `code` | `text NULL` | ≤ 30, unique `WHERE archived_at IS NULL` (e.g. `ACME-2026-01`) |
| `description` | `text NULL` | ≤ 20 000 |
| `start_date` | `date NULL` | |
| `target_launch_date` | `date NULL` | `CHECK (target_launch_date IS NULL OR start_date IS NULL OR target_launch_date >= start_date)` |
| `held_from_project_stage_id` | `uuid NULL` | FK `project_stages`; set while On Hold |
| `archived_at`, `archived_by` | | set/cleared only by the Archived stage transition |

Indexes: `(client_id)`, `(website_id)`, trigram on `name`.

Service-layer rules: changing `website_id` must keep the same `client_id` (DB enforces), and is refused once the project has any `deployments` row (prevents rewriting deploy history).

### 3.12 `project_stages`

A per-project snapshot of the template's steps, copied at project creation (decision 0003). Template edits never change existing projects.

| Column | Type | Constraints |
|---|---|---|
| `project_id` | `uuid NOT NULL` | FK `projects` |
| `template_step_id` | `uuid NULL` | FK `stage_template_steps` (provenance) |
| `key`, `name`, `position`, `kind`, `role` | | as in template; unique `(project_id, key)`, `(project_id, position)` |
| `status` | `text NOT NULL DEFAULT 'upcoming'` | `IN ('upcoming','current','completed','skipped')` |
| `entered_at` | `timestamptz NULL` | latest entry |
| `exited_at` | `timestamptz NULL` | latest exit |

**Unique partial index `(project_id) WHERE status = 'current'`** — exactly one current stage per project (the "at least one" half is enforced by the stage service and a deferred constraint trigger).

### 3.13 `stage_history` (append-only)

| Column | Type | Constraints |
|---|---|---|
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | no `updated_at` |
| `project_id` | `uuid NOT NULL` | FK `projects` |
| `from_project_stage_id` | `uuid NULL` | FK `project_stages`; NULL for initial |
| `to_project_stage_id` | `uuid NOT NULL` | FK `project_stages` |
| `transition` | `text NOT NULL` | `IN ('initial','advance','skip_forward','move_back','hold','resume','archive','restore','go_live')` |
| `actor_type` | `text NOT NULL` | `IN ('user','system')` |
| `actor_user_id` | `uuid NULL` | FK `users` |
| `reason` | `text NULL` | 3–2 000; required for `skip_forward`, `move_back`, `hold`, `archive`, `restore` |
| `deployment_id` | `uuid NULL` | FK `deployments`; required for `go_live` |
| `audit_event_id` | `uuid NOT NULL` | FK `audit_events` (written in same transaction) |

Triggers: `reject_mutation()`. Index `(project_id, created_at DESC)`.

### 3.14 `tasks`

| Column | Type | Constraints |
|---|---|---|
| `project_id` | `uuid NOT NULL` | FK `projects` |
| `title` | `text NOT NULL` | 1–300 |
| `description` | `text NULL` | ≤ 20 000 |
| `status` | `text NOT NULL DEFAULT 'open'` | `IN ('open','in_progress','blocked','done','cancelled')` |
| `priority` | `text NOT NULL DEFAULT 'normal'` | `IN ('low','normal','high','critical')` |
| `due_date` | `date NULL` | |
| `reference_url` | `text NULL` | `https?://`, ≤ 2 048; display only, never fetched |
| `project_stage_id` | `uuid NULL` | FK `project_stages` (optional "belongs to stage") |
| `completed_at` | `timestamptz NULL` | `CHECK ((status = 'done') = (completed_at IS NOT NULL))` |
| `completed_by` | `uuid NULL` | FK `users` |
| `archived_at`, `archived_by` | | |

Indexes: `(project_id, status)`, `(due_date) WHERE status NOT IN ('done','cancelled') AND archived_at IS NULL`, `(priority) WHERE priority = 'critical' AND status NOT IN ('done','cancelled')`.

Complete/reopen: `done` ↔ `open`; each writes an audit event.

### 3.15 `changes`

A log of scoped changes to a project (what was asked, what shipped).

| Column | Type | Constraints |
|---|---|---|
| `project_id` | `uuid NOT NULL` | FK `projects` |
| `title` | `text NOT NULL` | 1–300 |
| `description` | `text NULL` | ≤ 20 000 |
| `category` | `text NOT NULL` | `IN ('feature','fix','content','design','technical','scope','deployment','other')` |
| `status` | `text NOT NULL DEFAULT 'proposed'` | `IN ('proposed','accepted','in_progress','done','rejected')` |
| `requested_by_contact_id` | `uuid NULL` | FK `contacts` (service checks same client) |
| `task_id` | `uuid NULL` | FK `tasks` (same project, service-checked) |
| `shipped_in_deployment_id` | `uuid NULL` | FK `deployments` |
| `archived_at`, `archived_by` | | |

Index `(project_id, created_at DESC)`, `(project_id, category)`.

### 3.16 `release_checklist_items`

Instantiated per project from `app_settings['release_checklist.template']` when the project is created (or on demand "Add checklist from template" for older projects; existing keys are skipped).

| Column | Type | Constraints |
|---|---|---|
| `project_id` | `uuid NOT NULL` | FK `projects` |
| `key` | `text NOT NULL` | `^[a-z][a-z0-9_]{0,49}$`; unique `(project_id, key)` |
| `label` | `text NOT NULL` | 1–300 |
| `required` | `boolean NOT NULL DEFAULT true` | non-required items never block |
| `position` | `integer NOT NULL` | |
| `checked_at` | `timestamptz NULL` | |
| `checked_by` | `uuid NULL` | FK `users`; `CHECK ((checked_at IS NULL) = (checked_by IS NULL))` |
| `note` | `text NULL` | ≤ 2 000 |
| `archived_at`, `archived_by` | | |

Default template (seeded into `app_settings`): DNS & SSL verified; Analytics installed; Forms tested; 404 page; Redirects mapped; Favicon/metadata/OG; Accessibility smoke check; Performance check; Backups/restore path known; Client sign-off received.

### 3.17 `readiness_waivers`

Readiness itself is **computed**, not stored (§6). Waivers record an explicit operator decision to accept a specific blocker.

| Column | Type | Constraints |
|---|---|---|
| `project_id` | `uuid NOT NULL` | FK `projects` |
| `blocker_key` | `text NOT NULL` | ≤ 200, stable key, e.g. `task:<uuid>`, `checklist:<key>`, `check_run:<repo_link>:<name>` |
| `blocker_type` | `text NOT NULL` | `IN ('critical_task','checklist_item','failing_check','pr_open','preview_not_ready','other')` |
| `blocker_snapshot` | `jsonb NOT NULL` | ≤ 4 KiB; what the blocker said when waived |
| `reason` | `text NOT NULL` | 3–2 000 |
| `waived_by` | `uuid NOT NULL` | FK `users` |
| `commit_sha` | `text NULL` | if set, waiver only applies while the proposed commit equals this SHA |
| `revoked_at` | `timestamptz NULL` | |
| `revoked_by` | `uuid NULL` | FK `users` |
| `audit_event_id` | `uuid NOT NULL` | FK `audit_events` |

Unique partial `(project_id, blocker_key) WHERE revoked_at IS NULL`. Waivers are revoked, never deleted.

### 3.18 `integrations`

One row per configured provider connection.

| Column | Type | Constraints |
|---|---|---|
| `provider` | `text NOT NULL` | `IN ('github','netlify','vercel','cloudflare')` ; cloudflare added in Phase 3b (decision 0010) |
| `name` | `text NOT NULL` | 1–100; unique `(provider, name) WHERE archived_at IS NULL` |
| `token_env_var` | `text NOT NULL` | env var **name** only |
| `account_ref` | `text NULL` | ≤ 200 — GitHub owner / Netlify account slug / Vercel team ID |
| `webhook_enabled` | `boolean NOT NULL DEFAULT false` | |
| `webhook_secret_env_var` | `text NULL` | env var name; `CHECK (NOT webhook_enabled OR webhook_secret_env_var IS NOT NULL)` |
| `health` | `text NOT NULL DEFAULT 'unconfigured'` | `IN ('unconfigured','ok','degraded','error','disabled')` |
| `health_detail` | `text NULL` | ≤ 1 000, redacted |
| `last_tested_at` | `timestamptz NULL` | |
| `last_sync_started_at` | `timestamptz NULL` | |
| `last_sync_succeeded_at` | `timestamptz NULL` | |
| `last_error_at` | `timestamptz NULL` | |
| `last_error` | `text NULL` | ≤ 2 000, redacted |
| `rate_limit_remaining` | `integer NULL` | |
| `rate_limit_reset_at` | `timestamptz NULL` | |
| `poll_enabled` | `boolean NOT NULL DEFAULT true` | |
| `archived_at`, `archived_by` | | |

### 3.19 `repository_links`

| Column | Type | Constraints |
|---|---|---|
| `website_id` | `uuid NOT NULL` | FK `websites` |
| `integration_id` | `uuid NOT NULL` | FK `integrations` (service checks `provider='github'`) |
| `owner` | `text NOT NULL` | `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` |
| `repo` | `text NOT NULL` | `^[A-Za-z0-9._-]{1,100}$` |
| `provider_repo_id` | `text NULL` | GitHub numeric id as text, set on first sync |
| `production_branch` | `text NOT NULL` | ≤ 255, git ref name rules |
| `is_primary` | `boolean NOT NULL DEFAULT true` | unique partial `(website_id) WHERE is_primary AND archived_at IS NULL` |
| `last_synced_at` | `timestamptz NULL` | |
| `sync_cursor` | `jsonb NULL` | ≤ 4 KiB (ETags, since-timestamps) |
| `archived_at`, `archived_by` | | |

Unique `(website_id, owner, repo) WHERE archived_at IS NULL`.

### 3.20 `repository_events`

Normalized, redacted snapshots of commits, PRs and check runs.

| Column | Type | Constraints |
|---|---|---|
| `repository_link_id` | `uuid NOT NULL` | FK `repository_links` |
| `event_type` | `text NOT NULL` | `IN ('commit','pull_request','check_run','check_suite','push','branch_protection')` |
| `provider_event_id` | `text NOT NULL` | commit SHA / PR number / check run id / delivery-derived id |
| `source` | `text NOT NULL` | `IN ('poll','webhook')` |
| `commit_sha` | `text NULL` | full SHA check |
| `ref` | `text NULL` | ≤ 255 |
| `title` | `text NULL` | ≤ 300 (commit subject / PR title / check name), escaped on render |
| `author_login` | `text NULL` | ≤ 100 |
| `state` | `text NULL` | ≤ 30 (`open`/`closed`/`merged`/`queued`/`in_progress`/`completed`) |
| `conclusion` | `text NULL` | ≤ 30 (`success`/`failure`/`neutral`/`cancelled`/`timed_out`/`action_required`/`skipped`) |
| `html_url` | `text NULL` | https, ≤ 2 048 |
| `occurred_at` | `timestamptz NOT NULL` | |
| `provider_updated_at` | `timestamptz NULL` | for idempotent upsert ordering |
| `snapshot` | `jsonb NOT NULL DEFAULT '{}'` | ≤ 64 KiB, allowlisted fields only, redacted |

**Unique `(repository_link_id, event_type, provider_event_id)`**. Upsert updates only when `provider_updated_at` is newer. Indexes `(repository_link_id, event_type, occurred_at DESC)`, `(commit_sha)`.

### 3.21 `hosting_links`

| Column | Type | Constraints |
|---|---|---|
| `website_id` | `uuid NOT NULL` | FK `websites` |
| `integration_id` | `uuid NULL` | FK `integrations`; NULL = manual hosting record (no sync) |
| `provider` | `text NOT NULL` | `IN ('netlify','vercel','cloudflare','other')`; must match integration's provider |
| `provider_project_id` | `text NULL` | Netlify site id / Vercel project id; required when `integration_id` set |
| `provider_project_name` | `text NULL` | ≤ 200 |
| `environment` | `text NOT NULL` | `IN ('production','preview','staging')` |
| `domain` | `text NULL` | hostname check |
| `repository_link_id` | `uuid NULL` | FK `repository_links` (same website, service-checked) |
| `auto_publish` | `text NOT NULL DEFAULT 'unknown'` | `IN ('enabled','locked','disabled','unknown')` |
| `auto_publish_checked_at` | `timestamptz NULL` | |
| `current_deployment_id` | `uuid NULL` | FK `deployments` (deferrable); provider-reported current live deploy |
| `last_synced_at` | `timestamptz NULL` | |
| `sync_cursor` | `jsonb NULL` | ≤ 4 KiB |
| `archived_at`, `archived_by` | | |

Unique `(integration_id, provider_project_id, environment) WHERE archived_at IS NULL AND integration_id IS NOT NULL`. Unique partial `(website_id) WHERE environment='production' AND archived_at IS NULL` (one production target per website in v1).

### 3.22 `deployments`

One row per deploy known to SiteSync, whether observed from the provider, initiated by SiteSync, or recorded manually.

| Column | Type | Constraints |
|---|---|---|
| `hosting_link_id` | `uuid NOT NULL` | FK `hosting_links` |
| `website_id` | `uuid NOT NULL` | FK `websites` (denormalized, must match hosting link) |
| `project_id` | `uuid NULL` | FK `projects`; set for SiteSync-initiated, or when operator attributes |
| `provider` | `text NOT NULL` | `IN ('netlify','vercel','cloudflare','other')` |
| `provider_deployment_id` | `text NULL` | **unique `(provider, provider_deployment_id)` where not null** |
| `environment` | `text NOT NULL` | `IN ('production','preview','staging')` |
| `origin` | `text NOT NULL` | `IN ('provider_observed','sitesync_initiated','manual_record')` |
| `kind` | `text NOT NULL DEFAULT 'deploy'` | `IN ('deploy','promote','rollback')` |
| `state` | `text NOT NULL` | normalized, see §5.2: `IN ('queued','building','ready','published','failed','canceled','superseded','unknown')` |
| `provider_state` | `text NULL` | raw provider state, ≤ 50 |
| `dispatch_state` | `text NULL` | SiteSync-initiated only: `IN ('pending','dispatched','dispatch_failed','confirming','confirmed_success','confirmed_failure','timed_out')`; `CHECK ((origin = 'sitesync_initiated') = (dispatch_state IS NOT NULL))` |
| `commit_sha` | `text NULL` | full SHA |
| `branch` | `text NULL` | ≤ 255 |
| `deploy_url` | `text NULL` | https, ≤ 2 048 (unique deploy URL / preview URL) |
| `provider_created_at` | `timestamptz NULL` | |
| `ready_at` | `timestamptz NULL` | |
| `published_at` | `timestamptz NULL` | |
| `last_confirmed_at` | `timestamptz NULL` | last time provider state was re-read |
| `confirmation_source` | `text NULL` | `IN ('provider')`; `CHECK (origin <> 'manual_record' OR confirmation_source IS NULL)` — manual records are history only and can never trigger `go_live` (decision 0004) |
| `error_summary` | `text NULL` | ≤ 2 000, redacted |
| `idempotency_key` | `uuid NULL` | **unique**; required for `sitesync_initiated` |
| `approval_id` | `uuid NULL` | FK `production_approvals`; **unique** (one deployment per approval) |
| `target_deployment_id` | `uuid NULL` | FK `deployments` — for promote/rollback, the built deploy being promoted |
| `previous_live_deployment_id` | `uuid NULL` | FK `deployments` — what was live when dispatched (rollback reference) |
| `initiated_by` | `uuid NULL` | FK `users` |
| `snapshot` | `jsonb NOT NULL DEFAULT '{}'` | ≤ 64 KiB, allowlisted + redacted |

Checks: `CHECK (origin <> 'sitesync_initiated' OR (approval_id IS NOT NULL OR environment <> 'production'))` — production SiteSync deploys always carry an approval. Indexes `(hosting_link_id, provider_created_at DESC)`, `(project_id, created_at DESC)`, `(commit_sha)`, `(state) WHERE state IN ('queued','building')`.

Deployments are never deleted or archived; they are history.

### 3.23 `production_approvals`

| Column | Type | Constraints |
|---|---|---|
| `project_id` | `uuid NOT NULL` | FK `projects` |
| `website_id` | `uuid NOT NULL` | FK `websites` |
| `hosting_link_id` | `uuid NOT NULL` | FK `hosting_links` |
| `provider` | `text NOT NULL` | |
| `provider_project_id` | `text NOT NULL` | |
| `environment` | `text NOT NULL` | **`CHECK (environment = 'production')`** |
| `action` | `text NOT NULL` | `IN ('promote','rollback','build_from_ref')` |
| `target_provider_deployment_id` | `text NULL` | required for `promote`/`rollback` |
| `target_commit_sha` | `text NOT NULL` | full SHA |
| `expected_current_provider_deployment_id` | `text NULL` | what was live at approval time |
| `preflight_snapshot` | `jsonb NOT NULL` | ≤ 64 KiB — everything shown on the preflight screen |
| `preflight_hash` | `bytea NOT NULL` | SHA-256 of canonical JSON of `preflight_snapshot` |
| `reason` | `text NOT NULL` | 3–2 000 |
| `approved_by` | `uuid NOT NULL` | FK `users` |
| `approved_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `expires_at` | `timestamptz NOT NULL` | `CHECK (expires_at = approved_at + interval '30 minutes')` |
| `status` | `text NOT NULL DEFAULT 'awaiting_confirmation'` | `IN ('awaiting_confirmation','consumed','expired','revoked','refused')` |
| `confirmed_at` | `timestamptz NULL` | password re-entry time |
| `consumed_at` | `timestamptz NULL` | `CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))` |
| `refusal_reason` | `text NULL` | ≤ 1 000 |
| `revoked_at`, `revoked_by` | | |

Unique partial `(hosting_link_id) WHERE status = 'awaiting_confirmation'` — at most one live approval per production target. A trigger forbids any transition out of `consumed`/`expired`/`revoked`/`refused` (terminal states).

**Phase 4 additions (decision 0011):** `target_deployment_id uuid NULL` (FK `deployments`, same hosting link; required with `target_provider_deployment_id` for promote/rollback) and `production_branch text NULL` (required for `build_from_ref`). The trigger also forbids changing what was approved. No DELETE grant.

### 3.24 `webhook_inbox`

| Column | Type | Constraints |
|---|---|---|
| `provider` | `text NOT NULL` | `IN ('github','netlify','vercel','cloudflare')` |
| `integration_id` | `uuid NULL` | FK `integrations` |
| `delivery_id` | `text NOT NULL` | ≤ 200; **unique `(provider, delivery_id)`** |
| `event_type` | `text NOT NULL` | ≤ 100; must be in allowlist to be stored as `received` (else `ignored`) |
| `signature_valid` | `boolean NOT NULL` | invalid signatures are rejected with 401 and **not** stored; column exists for clarity/forward use |
| `body` | `jsonb NOT NULL` | ≤ 256 KiB after redaction |
| `body_sha256` | `bytea NOT NULL` | of raw bytes |
| `received_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `status` | `text NOT NULL DEFAULT 'received'` | `IN ('received','processing','processed','ignored','failed','dead_lettered')` |
| `attempts` | `integer NOT NULL DEFAULT 0` | `CHECK (attempts >= 0)` |
| `next_attempt_at` | `timestamptz NULL` | |
| `last_error` | `text NULL` | ≤ 2 000, redacted |
| `processed_at` | `timestamptz NULL` | |

Index `(status, next_attempt_at)`. Retention: processed/ignored rows pruned after 30 days; dead-lettered kept until resolved.

### 3.25 Job storage

pg-boss creates and manages its own `pgboss` schema. It is excluded from Drizzle migrations; its version is pinned and its schema migration is run by pg-boss at startup against the app database (documented in a decision record in Phase 3a).

### 3.26 Relationship summary

```
clients 1─* contacts
clients 1─* websites 1─* repository_links 1─* repository_events
                    1─* hosting_links     1─* deployments
clients 1─* projects *─1 websites   (composite FK: same client)
projects 1─* project_stages, stage_history, tasks, changes,
             release_checklist_items, readiness_waivers, production_approvals
production_approvals 1─0..1 deployments
integrations 1─* repository_links, hosting_links, webhook_inbox
```

---

## 4. Authentication and request security

- **First run:** if `users` is empty, every route except `/health` and static assets redirects to `/setup`. `/setup` creates the first admin (email, name, password + confirm) inside a transaction that re-checks `users` is empty with `LOCK TABLE users IN EXCLUSIVE MODE`. After that `/setup` returns 404. No default password exists anywhere.
- **Login:** `/login`, throttled per §3.3. Generic error message. Successful login rotates the session.
- **Every Server Action and Route Handler** calls `requireSession()` first (except `/setup` while empty, `/login`, `/health`, and webhook endpoints which use HMAC instead).
- **CSRF:** Server Actions rely on Next.js's built-in Origin/Host check; `serverActions.allowedOrigins` is left at default (same-origin). Route Handlers that mutate check `Origin` (or `Referer` fallback) equals the configured app origin and reject otherwise. Webhook routes are exempt (HMAC-authenticated).
- **Binding:** `next dev`/`next start` launched with `-H 127.0.0.1`. LAN mode (`SITESYNC_LAN_MODE=true` + `SITESYNC_PUBLIC_ORIGIN=https://…`) changes the bind host only when both are set; documentation states it requires HTTPS via an operator-run reverse proxy with a trusted cert.
- **Headers:** CSP (`default-src 'self'`, nonce-based scripts), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`.
- **Outbound HTTP:** a single `providerFetch()` wrapper (server-only) that rejects any host not in `{api.github.com, api.netlify.com, api.vercel.com, api.cloudflare.com}`, forces https, sets timeouts (10 s), and never follows redirects to other hosts. User-supplied URLs are never fetched.
- **Redaction:** central `redact()` applied to logs, error strings, `audit_events` JSON, provider snapshots and webhook bodies. Removes keys matching `/(token|secret|password|authorization|cookie|api[-_]?key|signature|session)/i`, strips `access_token`/`token`/`code`/`sig` query params from URLs, and masks strings matching known token shapes (`ghp_`, `github_pat_`, `gho_`, `nfp_`, Vercel tokens, JWTs).

---

## 5. State machines

### 5.1 Project stage

States are the project's `project_stages` rows. Let `L` = linear steps ordered by position, `RTD` = step with role `ready_to_deploy`, `LIVE` = step with role `live`.

| Transition | From | To | Who | Requirements |
|---|---|---|---|---|
| `initial` | — | first linear step (or chosen linear step ≤ RTD) | user | on project creation |
| `advance` | linear step *n* | linear step *n+1* | user | target ≠ LIVE |
| `skip_forward` | linear *n* | linear *m > n+1* | user | reason; target ≠ LIVE; skipping *over* LIVE is only allowed when the website has no integration-backed production hosting link |
| `move_back` | linear *n* | linear *m < n* | user | reason |
| `go_live` | RTD (or any linear step after LIVE, for re-deploys — no stage change then) | LIVE | **system** | a `deployments` row for this project, environment `production`, `state='published'`, `confirmation_source='provider'`, on a hosting link with an integration (decision 0004) |
| `hold` | any linear | On Hold | user | reason; stores `held_from_project_stage_id` |
| `resume` | On Hold | `held_from` stage (or another linear ≠ LIVE with reason) | user | |
| `archive` | any (incl. On Hold) | Archived | user | reason; sets `projects.archived_at`; refused if an approval is `awaiting_confirmation` or a SiteSync deploy is in flight |
| `restore` | Archived | stage held before archive (from history) | user | reason; clears `archived_at` |

Rules:
- Nothing — including a user action — can move a project into LIVE except `go_live`. The UI shows LIVE as "Reached automatically after a confirmed production deploy".
- A project whose website has no production hosting link backed by an integration **stops at Ready to Deploy**. Its overview shows: "This website has no connected hosting provider, so SiteSync can't confirm a deploy. Connect Netlify or Vercel to let this project reach Live." The operator can still move it on to Maintenance via `skip_forward` with a reason (LIVE is then marked `skipped`), so manual work is never blocked.
- Moving *backward out of* LIVE or Maintenance is allowed (e.g. a new phase of work), with reason.
- Entering RTD is not gated, but the UI shows the readiness summary in the confirmation dialog.
- Each transition, in **one transaction**: lock project row (`SELECT … FOR UPDATE`), verify current stage equals the client-submitted `expected_current_stage_id` (optimistic concurrency), update `project_stages` statuses (`current` → `completed`/`skipped`/`upcoming` as appropriate), insert `audit_events`, insert `stage_history` referencing it. Any failure rolls back all three.
- Skipped intermediate steps become `skipped`; moving back sets steps after the target to `upcoming`.

### 5.2 Deployment (normalized provider state)

```
queued ──► building ──► ready ──► published ──► superseded
   │           │          │
   └──────┬────┴──────────┴──► failed | canceled
          └──► unknown  (provider state unmappable; re-polled)
```

- `ready` = built successfully but not the current production deploy (all previews end here).
- `published` = provider reports this is the current production deploy for the hosting link. When another deploy becomes `published`, the previous one becomes `superseded`.
- Mapping tables (Netlify `state`/`published_at`, Vercel `readyState`/`target`/alias assignment) live in the adapters with unit tests; confirmed against provider docs in Phase 3b.
- Transitions are applied only if the provider timestamp is not older than what's stored (idempotent, order-tolerant).

### 5.3 SiteSync dispatch (for `origin='sitesync_initiated'`)

```
pending ──► dispatched ──► confirming ──► confirmed_success
   │            │               ├──────► confirmed_failure
   │            │               └──────► timed_out ──(late provider confirmation)──► confirmed_success|confirmed_failure
   └──► dispatch_failed
```

- `pending`: row created inside the executor transaction (§8.4).
- `dispatched`: provider API accepted the request.
- `confirming`: pg-boss job polls the provider (backoff 5 s → 60 s) for up to 20 minutes.
- `confirmed_success`: target deploy is `published` on the provider → triggers `go_live` if the project is at RTD.
- `confirmed_failure` / `dispatch_failed` / `timed_out`: project stays at RTD; UI shows recovery options (re-check now, open provider dashboard, start a new approval, rollback approval).
- A late confirmation after `timed_out` is still applied and audited.

### 5.4 Production approval

```
            ┌──────────── revoke (user) ─────────► revoked
            │
awaiting_confirmation ── now > expires_at ───────► expired
            │
            ├── final confirm + executor checks pass ─► consumed
            └── final confirm + executor checks fail ─► refused (reason recorded)
```

- All non-`awaiting_confirmation` states are terminal (trigger-enforced).
- Expiry is evaluated at use time (`now() > expires_at` ⇒ refuse and mark expired) and by a sweeper job for display.
- A wrong password at final confirmation does **not** consume or refuse the approval; it counts toward login throttling and is audited.

### 5.5 Webhook inbox

```
(HTTP) ─ bad sig / oversize / unknown integration ─► 401/413, nothing stored
(HTTP) ─ duplicate delivery_id ─► 200, nothing new stored
(HTTP) ─ event not allowlisted ─► stored as ignored, 202
(HTTP) ─ ok ─► received ─► processing ─► processed
                               │
                               └─► failed ─(attempts < 8, backoff)─► processing
                                       └─(attempts = 8)─► dead_lettered ─(manual replay)─► received
```

### 5.6 Integration health

`unconfigured` (env var not set) → `ok` (last test/sync succeeded) ⇄ `degraded` (rate-limited, or last sync failed but token valid) ⇄ `error` (auth failure / 401 / 403). `disabled` is operator-set. Health never blocks manual work.

---

## 6. Readiness

Computed on read for a project by `computeReadiness(projectId, proposedTarget?)`. Returns `{ ready: boolean, blockers: Blocker[], waived: Blocker[] }`.

| Blocker type | Key | Condition |
|---|---|---|
| `critical_task` | `task:<id>` | task with priority `critical`, status not `done`/`cancelled`, not archived |
| `checklist_item` | `checklist:<key>` | required, unchecked, not archived |
| `failing_check` | `check_run:<repo_link_id>:<name>` | latest check run for the proposed commit has conclusion in (`failure`,`timed_out`,`action_required`,`cancelled`) or is still in progress |
| `pr_open` | `pr:<repo_link_id>:<number>` | an open PR targeting the production branch is marked by the operator as "must merge before release" (opt-in flag stored in event snapshot annotations) — v1 may defer; see plan |
| `preview_not_ready` | `preview:<deployment_id>` | proposed deploy is not in `ready` state |
| `no_production_target` | `hosting:missing` | website has no production hosting link (cannot be waived) |

A blocker is "waived" if an un-revoked waiver with the same `blocker_key` exists and (if the waiver has `commit_sha`) it matches the proposed commit. Provider-derived blockers only appear when the relevant integration is configured; a disconnected integration shows an informational "checks unavailable" note, not a blocker — except at the approval gate, where unknown check state for a linked repo is shown as a warning that must be acknowledged in the approval reason.

Waive/revoke each write an audit event; waiver requires actor + reason.

---

## 7. Provider adapters

### 7.1 Interfaces

```ts
interface SourceAdapter {           // GitHub
  testConnection(): Promise<ConnectionResult>;
  getRepository(owner, repo): Promise<RepoInfo>;
  listCommits(link, { since, limit }): Promise<Page<NormalizedCommit>>;
  listOpenPullRequests(link): Promise<Page<NormalizedPR>>;
  listCheckRuns(link, sha): Promise<NormalizedCheck[]>;
  getBranchHead(link, branch): Promise<string>; // full SHA
}

interface HostingAdapter {          // Netlify, Vercel
  testConnection(): Promise<ConnectionResult>;
  getProject(id): Promise<HostingProjectInfo>; // includes autoPublish
  listDeployments(link, { limit, since }): Promise<Page<NormalizedDeployment>>;
  getDeployment(id): Promise<NormalizedDeployment>;
  getCurrentProduction(link): Promise<NormalizedDeployment | null>;
  promote(link, deployId, idempotencyKey): Promise<DispatchResult>;  // Phase 4
}
```

All adapters: server-only, use `providerFetch()`, Zod-parse every response (unknown fields dropped), map rate-limit headers into `integrations.rate_limit_*`, retry 429/5xx with exponential backoff + jitter respecting `Retry-After`/reset headers (max 5 attempts), never retry 4xx auth errors.

### 7.2 Sync bounds

- Initial GitHub sync: last 50 commits on production branch, all open PRs (max 100), check runs for the latest 10 commits.
- Initial hosting sync: last 50 deployments.
- Polling default every 10 min per link (configurable 5–60), skipped while `rate_limit_remaining` < 10% until reset.
- Manual refresh: enqueue an immediate job; one in-flight sync per link (pg-boss `singletonKey`).

### 7.3 Webhooks (Phase 3a, disabled by default)

Route: `POST /api/webhooks/github/<integration_id>`. Steps: check `webhook_enabled` (else 404) → read raw body with 1 MiB cap → HMAC-SHA256 with secret from env var, compare `X-Hub-Signature-256` via `timingSafeEqual` → dedupe on `X-GitHub-Delivery` → allowlist (`push`, `pull_request`, `check_run`, `check_suite`, `ping`) → insert inbox row → 202 within 1 s → pg-boss job processes. Docs explain an operator-run tunnel; SiteSync never launches one. Netlify/Vercel webhooks are out of scope for v1 (polling only) unless decided otherwise.

---

## 8. Production deployment gate

### 8.1 Mechanism (verified in decision 0011)

> **Phase 4 amendment (decision 0011).** Verified on 2026-11-03. Vercel `POST /v10/projects/{id}/promote/{deploymentId}`; Netlify `restore` as below; **Cloudflare Pages has no promote and uses `build_from_ref`** (`POST …/pages/projects/{name}/deployments` with `branch`, which builds HEAD), with the built commit also checked at confirmation. Rollback: Cloudflare `…/deployments/{id}/rollback`, Netlify `restore`, Vercel `POST /v1/projects/{id}/rollback/{deploymentId}`. The providers take no idempotency key; single dispatch is guaranteed by SiteSync (approval lock, unique `approval_id`, dispatch only from `pending`, writes never retried after they may have arrived).

- **Vercel:** promote an existing READY deployment to production by deployment ID (Vercel "promote" API). Binds approval to exact build output.
- **Netlify:** publish/restore a specific deploy by deploy ID (`POST /sites/{site_id}/deploys/{deploy_id}/restore`), with auto-publishing locked so later builds don't replace it.
- **Fallback (`build_from_ref`):** only if a provider/site can't promote a specific build — the executor re-reads the production branch head immediately before dispatch and refuses if it differs from `target_commit_sha`.

Preview deploys are never gated and never dispatched by SiteSync in v1 (they come from provider builds).

### 8.2 Preflight screen (`/projects/[id]/deploy/preflight?target=<deployment_id>`)

Shows: client, website, production domain, provider + provider project; **current live** deploy ID/commit/published time vs **proposed** deploy ID/commit/preview URL/state; diff link (GitHub compare URL, display only); GitHub checks for proposed SHA; open PRs into production branch; readiness blockers and waivers; open critical tasks; auto-publish status with the §1.1 caveat if `enabled`/`unknown`; data freshness (last confirmed times). A "Refresh from provider" button re-reads everything before approval.

The approve button is disabled while any unwaived blocker exists or the data is older than 5 minutes.

### 8.3 Approve → final confirm

1. **Approve** (Server Action): re-runs preflight server-side, builds the snapshot, computes `preflight_hash`, verifies it equals the hash the screen rendered (submitted hidden field) — mismatch ⇒ "Data changed, review again". Inserts `production_approvals` (`awaiting_confirmation`, `expires_at = approved_at + 30 min`) + audit event.
2. **Final confirmation** (separate screen `/approvals/[id]/confirm`): shows the exact target summary and countdown; operator re-enters password; Server Action verifies password (throttled), then calls the executor.

### 8.4 Executor (server-only)

Transaction A:
1. `SELECT … FROM production_approvals WHERE id = $1 FOR UPDATE`.
2. Refuse unless `status = 'awaiting_confirmation'` and `now() <= expires_at` (else mark `expired`/leave terminal and refuse).
3. Re-validate against provider (calls made while holding the row lock, with a 10 s timeout): hosting link still active and matches `provider_project_id`; target deploy exists, belongs to that project, is `ready`, and has `commit_sha = target_commit_sha`; current production still equals `expected_current_provider_deployment_id` (else refuse: "live site changed since approval"); for `build_from_ref`, branch head equals approved SHA.
4. Recompute readiness for the target; refuse if any unwaived blocker.
5. Set approval `consumed`, `confirmed_at`, `consumed_at`; insert `deployments` (`origin='sitesync_initiated'`, `dispatch_state='pending'`, fresh `idempotency_key`, `approval_id`); audit both. Commit.

Outside transaction:
6. Dispatch via adapter with the idempotency key; update `dispatch_state` (`dispatched`/`dispatch_failed`) + audit.
7. Enqueue confirmation job (§5.3).

If any refusal occurs in steps 2–4 the approval becomes `refused` with `refusal_reason` (terminal), audited. Concurrent double-submit: the second request blocks on the row lock and then sees `consumed` ⇒ refused; `deployments.approval_id` unique is the backstop.

### 8.5 Outcomes and rollback

- Success confirmed by provider ⇒ deployment `published`, `confirmation_source='provider'` ⇒ `go_live` if project at RTD; website status → `live`.
- Failure/timeout ⇒ stays RTD; recovery options shown.
- **Rollback** = new approval with `action='rollback'` targeting the most recent previous `published`/`superseded` production deploy for the hosting link. Same gate, same tests.

### 8.6 Required tests (mocked provider)

no approval → refused; expired → refused; consumed replay → refused; target mismatch (hosting link / provider project / deploy ID) → refused; ref/SHA mismatch → refused; live-changed-since-approval → refused; concurrent double-submit → exactly one dispatch (asserted on mock call count); preview deploys never require approval; wrong password → no dispatch and approval unchanged; unwaived blocker at execution → refused.

---

## 9. Screens

All screens: persistent sidebar, breadcrumbs, global search (⌘/Ctrl-K: clients, websites, projects, tasks by name/code/domain), quick-create menu (client, website, project, task, change), empty/loading/error states, keyboard reachable with visible focus. Status is always text + icon.

| # | Route | Screen | Phase |
|---|---|---|---|
| 1 | `/setup` | First-run admin creation | 0 |
| 2 | `/login` | Login | 0 |
| 3 | `/health` | JSON: app version, DB reachable, migrations applied/pending (no secrets) | 0 |
| 4 | `/` | Dashboard: projects per stage (counts), overdue tasks, deadlines next 14 days, recent activity, deployment alerts (failed/timed-out/in-flight), sync errors, pending approvals | 1 skeleton → 2 → 3/4 |
| 5 | `/clients` | Client list: search, status filter, archived toggle | 1 |
| 6 | `/clients/[id]` | Client detail: contacts, websites, projects, activity | 1 |
| 7 | `/websites/[id]` | Website detail: environments/hosting links (with auto-publish caveat), repository links, integrations health, deploy history table, projects | 1 → 3 |
| 8 | `/projects` | Project list: filter by stage, client, overdue; sort by target date | 1 |
| 9 | `/projects/[id]` | Overview tab: stage rail, readiness summary, key dates, current live vs latest preview | 1 → 2 |
| 10 | `/projects/[id]/tasks` | Tasks tab | 2 |
| 11 | `/projects/[id]/changes` | Changes tab | 2 |
| 12 | `/projects/[id]/activity` | Activity tab (stage history + audit for project) | 1 |
| 13 | `/projects/[id]/deployments` | Deployments tab (environment, provider, state, target, URL, ref, last-confirmed) | 3b |
| 14 | `/projects/[id]/settings` | Project settings: name, dates, website (if allowed), checklist, archive | 1 → 2 |
| 15 | `/projects/[id]/deploy/preflight` | Deployment preflight + approve | 4 |
| 16 | `/approvals/[id]/confirm` | Final confirmation (password) | 4 |
| 17 | `/integrations` | Integrations: health, last sync, errors, test, refresh, webhook inbox / dead-letter with replay | 3a → 5 |
| 18 | `/activity` | Audit/activity with filters (actor, action, subject, client, project, date) | 5 |
| 19 | `/settings` | Workflow templates, checklist template, session, local/LAN mode info, backup status, version | 1 shell → 5 |

Visual system: light neutral background (`slate-50`), deep navy sidebar/headings (`#0f1f3d`-ish), blue/teal accent, shadcn/ui components, compact tables with sticky headers. Desktop-first, usable to 768 px. Charts only on the dashboard stage-count bar (answers "where is my work piling up?").

---

## 10. Operations

- `db:backup`: `docker compose exec -T db pg_dump -Fc -U $POSTGRES_USER $POSTGRES_DB > backups/sitesync-YYYYMMDDTHHMMSSZ.dump`; `backups/` git-ignored; records `backup.last_run` in `app_settings`.
- `db:restore <file>`: creates `sitesync_restore_<timestamp>`, `pg_restore` into it, runs verification (migration table matches, row counts per table, audit trigger present), prints a report, then asks for typed confirmation to switch `DATABASE_URL` (writes a note telling the operator which env var to change; it does not edit env files or drop the old DB).
- Migrations additive by default; destructive changes need a decision record and a data-preserving path.
- Environment variable **names** (values never committed): `DATABASE_URL`, `DATABASE_URL_TEST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `SITESYNC_APP_ORIGIN`, `SITESYNC_LAN_MODE`, `SITESYNC_PUBLIC_ORIGIN`, plus whatever names the operator chooses for provider tokens and webhook secrets (suggested: `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `NETLIFY_TOKEN`, `VERCEL_TOKEN`).

---

## 11. Open questions — resolved

**Resolved by the operator on 2026-11-03.** OQ-1: strict (decision 0004). OQ-2 to OQ-8: the proposed defaults below are accepted and are now part of this spec. OQ-8 is an action, not a design choice: Docker must be installed before Phase 0 can run.

| ID | Question | Proposed default |
|---|---|---|
| **OQ-1** ✅ | "Live only after provider-confirmed deploy" conflicts with "manual workflows always work with zero credentials". | **Resolved 2026-11-03 — strict, provider only.** No operator-attested path. Projects without a connected hosting provider stop at Ready to Deploy (or skip past Live with a reason). See decision 0004. |
| **OQ-2** | Should a production deploy the provider made on its own (auto-publish on push) move a project at Ready to Deploy to Live? | No automatic move. Show a prompt "Provider published a production deploy not initiated by SiteSync — mark Live?" which performs `go_live` using that provider-confirmed deployment (confirmation is still from the provider). |
| **OQ-3** | Should approval be blocked by unwaived readiness blockers, or only warn? | Block. Waivers are the escape hatch, with reason + audit. |
| **OQ-4** | One production hosting link per website (v1)? | Yes. Multi-region / multi-provider production is out of scope. |
| **OQ-5** | Session lifetimes. | Idle 2 h, absolute 12 h. |
| **OQ-6** | Netlify/Vercel webhooks in v1? | No — polling only for hosting; GitHub webhook built but disabled by default (per prompt). |
| **OQ-7** | `pr_open` blocker (open PRs into production branch). | Ship as informational on preflight in v1; not a blocker unless operator flags a PR. |
| **OQ-8** | Docker is not currently detected on this machine; Postgres via Docker Compose is required by the stack. | Operator installs Docker Desktop before Phase 0. |
