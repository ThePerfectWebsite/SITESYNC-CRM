# 0005 — Toolchain and dependency versions (verified 2026-11-03)

**Context.** The spec named Next.js 16, "current stable" Postgres, Drizzle and pg-boss without exact versions (Phase S handoff §5). Phase 0 verifies and pins them.

**Decision.** Exact versions in `package.json` (no ranges), checked with `npm view` / Docker Hub on 2026-11-03:

| Component | Version | Note |
|---|---|---|
| Node.js | 26.13.0 | `.nvmrc` = 26, `engines.node >= 26` |
| Next.js / eslint-config-next | 16.4.4 | App Router, Turbopack, `proxy.ts` (Middleware is deprecated in 16) |
| React / React DOM | 19.3.0 | the pair `create-next-app@16.4.4` installs |
| TypeScript | **5.9.3** (not 7.0.2) | `typescript-eslint` 8.72 (used by `eslint-config-next`) supports `>=4.8.4 <6.1.0`; TS 7 is the native port. Revisit when typescript-eslint supports it. |
| ESLint | **9.39.5** (not 10.x) | `eslint-plugin-react` 7.37 peer range stops at `^9.7` |
| Tailwind CSS | 4.3.4 via `@tailwindcss/turbopack` | the current `create-next-app` setup; no PostCSS config |
| shadcn/ui CLI | 4.23.0, style `radix-nova`, `radix-ui` 1.8.1, `cn` 0.5.2 | `cn` is shadcn-ui's own class-merge helper (repo `shadcn-ui/cn`); `shadcn` is a runtime dependency because `globals.css` imports `shadcn/tailwind.css` |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 | driver `pg` 8.23.1 |
| Zod | 4.6.7 | |
| Postgres | **18.6** (`postgres:18.6-alpine`) | latest stable major. PG 18 images keep data under `/var/lib/postgresql/<major>/docker`, so the volume mounts `/var/lib/postgresql` |
| Vitest / Playwright | 5.1.0 / 1.64.1 | |
| pg-boss | 12.38.0 | pinned in Phase 3a (Node ≥ 22.12); schema handled by the owner role, see decision 0009 |

`cacheComponents` (on by default in new `create-next-app` projects) is left **off**: every page is session-dependent and the per-request CSP nonce requires dynamic rendering.

`npm audit` reports 20 moderate advisories, all in dev-only tooling (an old `esbuild` pulled by `drizzle-kit`, `minimatch` via ESLint plugins). None ship in the app bundle. Re-check when those tools release updates; do not `npm audit fix --force` (it downgrades/upgrades majors).

npm 11 no longer runs dependency install scripts by default; `esbuild`'s postinstall is skipped and it still works (verified: `tsx`, `drizzle-kit` run).

**Alternatives.** TS 7 / ESLint 10 — rejected for now because the lint toolchain's declared peer ranges exclude them.
