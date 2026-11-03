# SiteSync Control Centre

A local-first web app for one operator to run a small web studio: clients, websites, projects, stages, tasks, release readiness and deployments. It runs on your machine, bound to `127.0.0.1`, and works with zero provider credentials.

- Product spec: [docs/SiteSync-Control-Centre-Specification.md](docs/SiteSync-Control-Centre-Specification.md)
- Build plan: [docs/implementation-plan.md](docs/implementation-plan.md) · progress: [docs/implementation-status.md](docs/implementation-status.md)
- Decisions: [docs/decisions/](docs/decisions/)

> **Known limitation.** SiteSync cannot stop a hosting provider from auto-deploying to production on push or merge. If auto-publishing is enabled on the provider, code merged to the production branch can go live without passing through SiteSync's approval gate. Turn auto-publishing off on the provider to make the gate meaningful: on Cloudflare Pages, untick "Enable automatic production branch deployments"; on Netlify, lock the published deploy; on Vercel, turn off "Auto-assign Custom Production Domains". See [docs/hosting.md](docs/hosting.md).

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

## GitHub (optional)

SiteSync can read commits, pull requests and check runs from GitHub, and counts failing checks in release readiness. It's read only, works from a token you keep in `.env`, and everything else works without it. Webhooks are off by default. See [docs/github.md](docs/github.md).

## Hosting (optional)

SiteSync reads each website's deploys from **Cloudflare Pages**, Netlify or Vercel: what's live, recent previews, and whether the host auto-deploys. A website without a production host can't be released (readiness says so). A manual host record works without any token. See [docs/hosting.md](docs/hosting.md).

## Releases

Production releases go through an approval gate:
1. **Preflight:** live vs proposed, checks and readiness.
2. **Approve** with a reason. The approval lasts 30 minutes.
3. **Confirm** with your password: SiteSync re-checks everything and sends the release once.
4. **Live:** the project moves to Live only when the host confirms the approved commit is live.

Cloudflare Pages releases build the production branch, after checking its head is the approved commit. Netlify and Vercel promote a built deploy. All three can roll back through the same gate. See [docs/hosting.md](docs/hosting.md#releasing) and decision [0011](docs/decisions/0011-cloudflare-release-flow.md).

## Background jobs

The server runs a small job runner (pg-boss, in the same process). It polls GitHub and hosts, confirms releases with the host, expires lapsed approvals, processes webhook deliveries and prunes old records. `npm run db:migrate` sets up its `pgboss` schema as the owner role; the app only uses it. Set `SITESYNC_JOBS=off` to run without it: manual refreshes then run immediately instead. See decision [0009](docs/decisions/0009-pg-boss-job-runner.md).

## Continuous integration

Every push to `main` and every pull request runs [.github/workflows/ci.yml](.github/workflows/ci.yml). It has two jobs, which are also the GitHub checks SiteSync shows for this repository:
- **Lint and typecheck.**
- **Tests (unit, integration, E2E):** run against a throwaway Postgres 18.6 service with the same roles the Docker init script creates.

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
- Provider tokens live only in the environment; the database stores env var *names*, and SiteSync's own variables (`DATABASE_*`, `POSTGRES_*`, `SITESYNC_*` …) can't be used as one.
- Outbound requests go only to `api.github.com`, `api.cloudflare.com`, `api.netlify.com` and `api.vercel.com`, over https, with a timeout, and never follow redirects to other hosts. User-entered URLs are displayed, never fetched.
- Webhooks are off unless enabled per integration, and need a valid HMAC signature. Nothing is stored before the signature checks out.
