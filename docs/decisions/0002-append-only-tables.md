# 0002 — Append-only tables enforced by triggers; no `updated_at`

**Context.** `audit_events` must be unmodifiable, enforced by the database. `stage_history` is also a historical record that should never change. The general convention says every table has `updated_at`.

**Decision.** A shared `reject_mutation()` trigger function is attached `BEFORE UPDATE OR DELETE` (row level) and `BEFORE TRUNCATE` (statement level) on `audit_events` and `stage_history`. These two tables have `created_at` only; an `updated_at` column that can never change would be misleading. As defence in depth the app connects as a role without `TRUNCATE` or DDL rights on these tables; migrations run as the owner role.

**Alternatives.** (a) App convention only — rejected by the prompt. (b) Revoke UPDATE/DELETE grants only — a superuser or owner connection bypasses it silently; triggers fail loudly even for the owner (unless deliberately disabled, which is itself a visible DDL action).
