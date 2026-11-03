# 0006 — Database roles, migration layout and the env vars they need

**Context.** Spec §2.2 says the app connects as `sitesync_app` (no table ownership, no `TRUNCATE`, no DDL on append-only tables) and migrations run as `sitesync_owner`. The env var list in §10 has one `DATABASE_URL`, which can't express two roles.

**Decision.**

1. **Roles.** `docker/initdb/01-roles-and-databases.sh` (runs once on an empty volume) creates `sitesync_owner` and `sitesync_app`, makes `sitesync_owner` own both `sitesync` and `sitesync_test`, and revokes `CONNECT` from `PUBLIC`. The container superuser (`POSTGRES_USER`) is used only by that script and by `db:backup`/`db:restore` (via `docker compose exec`).
2. **Grants are explicit per table, never default privileges.** Each migration that creates a table grants exactly what `sitesync_app` needs. Append-only tables get `SELECT, INSERT` only. This avoids an `ALTER DEFAULT PRIVILEGES` silently giving `UPDATE`/`DELETE` on a future append-only table. **Every new table migration must include its `GRANT`** (Phase 1 onwards).
3. **Migration layout.** Drizzle-kit generates table DDL from `src/server/db/schema.ts`; things it can't express (extensions, functions, triggers, grants, seeds) go in custom migrations made with `drizzle-kit generate --custom`. The journal and snapshots stay consistent, so `npm run db:generate` keeps working. Migration SQL is pinned to LF in `.gitattributes` because Drizzle stores a SHA-256 of each file and `/health` / `db:status` compare against it.
4. **Env vars added** to the §10 list (names only; values in the git-ignored `.env`):
   - `SITESYNC_OWNER_PASSWORD`, `SITESYNC_APP_PASSWORD` — read by the init script.
   - `DATABASE_OWNER_URL`, `DATABASE_OWNER_URL_TEST` — owner connections for migrations, status, backup bookkeeping and the test-DB reset.
   `DATABASE_URL` / `DATABASE_URL_TEST` are the `sitesync_app` connections, as in the spec.
5. **Test database reset** drops and re-creates the `public` and `drizzle` schemas as the owner, then re-migrates. Truncation isn't possible because `audit_events` refuses it by design. Test helpers refuse any URL whose database name doesn't end in `_test`.

**Consequences.** The integration suite proves both layers: as `sitesync_app`, `UPDATE`/`DELETE`/`TRUNCATE` on `audit_events` fail with "permission denied"; as `sitesync_owner`, they fail in the `reject_mutation()` trigger.

**Alternatives.** One role for everything (simpler, but loses the defence in depth the spec asks for); default privileges (convenient, but unsafe for append-only tables as above).
