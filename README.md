# SiteSync Control Centre

A local-first web app for one operator to run a small web studio: clients, websites, projects, stages, tasks, release readiness and deployments. It runs on your machine, bound to `127.0.0.1`, and works with zero provider credentials.

- Product spec: [docs/SiteSync-Control-Centre-Specification.md](docs/SiteSync-Control-Centre-Specification.md)
- Build plan: [docs/implementation-plan.md](docs/implementation-plan.md) · progress: [docs/implementation-status.md](docs/implementation-status.md)
- Decisions: [docs/decisions/](docs/decisions/)

> **Known limitation.** SiteSync cannot stop a hosting provider from auto-deploying to production on push or merge. If auto-publishing is enabled on the provider, code merged to the production branch can go live without passing through SiteSync's approval gate. Lock auto-publishing on the provider (Netlify: lock the published deploy; Vercel: disable automatic production deployments) to make the gate meaningful. Exact settings are verified in Phase 3b.

## Requirements

- Node.js 26 (`.nvmrc`)
- Docker Desktop with Compose (Postgres 18 runs in a container)
- Git

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create `.env` from `.env.example` and fill every value. Generate strong random passwords for `POSTGRES_PASSWORD`, `SITESYNC_OWNER_PASSWORD` and `SITESYNC_APP_PASSWORD`, and put the same passwords into the four `DATABASE_*` URLs. `.env` is git-ignored; never commit it.
3. Start Postgres (bound to `127.0.0.1:5432`). On first start it creates the `sitesync_owner` and `sitesync_app` roles and the `sitesync` and `sitesync_test` databases:
   ```bash
   docker compose up -d
   ```
4. Apply migrations (as `sitesync_owner`):
   ```bash
   npm run db:migrate
   ```
5. Start the app and open <http://127.0.0.1:3000> (use `127.0.0.1`, not `localhost`: sign-out checks the request origin against `SITESYNC_APP_ORIGIN`):
   ```bash
   npm run dev
   ```
6. On first visit you're sent to `/setup` to create the admin account. There is no default password. After that, `/setup` returns 404.

The Docker init script only runs on an **empty** volume. If you change the role passwords later, change them in Postgres too (or recreate the volume, which deletes all data).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js, always bound to `127.0.0.1` |
| `npm run lint` / `typecheck` | ESLint; route type generation + `tsc --noEmit` |
| `npm test` | Unit + integration tests (integration needs the Docker DB; it resets `sitesync_test`) |
| `npm run test:unit` / `test:integration` | Either half on its own |
| `npm run test:e2e` | Builds, starts the app on port 3100 against `sitesync_test`, runs Playwright (first time: `npx playwright install chromium`) |
| `npm run db:migrate` (`-- --test`) | Apply migrations to the app (or test) database |
| `npm run db:status` (`-- --test`) | List applied/pending migrations; exit code 2 if any are pending |
| `npm run db:generate` | Generate a migration from `src/server/db/schema.ts` (add `-- --custom --name=x` for hand-written SQL) |
| `npm run db:backup` | `pg_dump -Fc` into `backups/` (git-ignored) and record `backup.last_run` |
| `npm run db:restore -- <file>` | Restore into a new `sitesync_restore_<timestamp>` database, verify it, and explain how to switch. Never edits `.env` or drops anything |

## Health

`GET /health` (no auth) returns the app version, whether the database is reachable, and applied/pending migrations. It returns 503 if the database is unreachable and `"status": "degraded"` if migrations are pending.

## Security model (summary)

- Binds to `127.0.0.1` only. LAN access needs HTTPS through your own reverse proxy: see [docs/lan-mode.md](docs/lan-mode.md).
- One admin account, scrypt-hashed password (12–256 characters, common passwords refused). Sessions are server-side: the cookie holds a random token, the database only its SHA-256. Sessions expire after 2 h idle or 12 h absolute.
- Login is throttled per email after 5 failures in 15 minutes (1 s, 2 s, 4 s … up to 60 s).
- Every protected page, Server Action and Route Handler checks the session itself. Mutating Route Handlers also check `Origin`.
- Nonce-based CSP, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `nosniff`.
- `audit_events` is append-only, enforced by database triggers. The app's database role also lacks `UPDATE`/`DELETE`/`TRUNCATE` on it.
- Secrets, tokens and credentials are redacted from logs, error text and audit records.
