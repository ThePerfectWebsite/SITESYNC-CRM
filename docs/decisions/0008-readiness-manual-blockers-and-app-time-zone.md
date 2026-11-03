# 0008 — Phase 2 readiness covers manual blockers only; "today" uses the app's time zone

## A. Readiness before providers exist

**Context.** Spec §6 lists six blocker types. Four depend on provider data that only arrives in Phases 3a–4: `failing_check`, `pr_open`, `preview_not_ready` and `no_production_target` (`hosting:missing`, which can't be waived). The plan's Phase 2 scope is "manual blockers only", and its E2E test expects readiness to clear. If `hosting:missing` were computed now, every project would be permanently blocked, because no hosting links can exist yet.

**Decision.**
- `computeReadiness()` in Phase 2 computes `critical_task` and `checklist_item` only.
- The pure `evaluateReadiness()` already supports unwaivable blockers, and that path is unit-tested.
- Phases 3a/3b add the provider blockers. `hosting:missing` will come from the same `DeploymentFacts` interface as the stage rules (decision 0007).
- The overview says readiness "covers critical tasks and the release checklist; provider checks join when hosting and GitHub are connected", so the operator isn't misled.
- **Waivers:**
  - A waiver can only be created for a blocker that exists at that moment.
  - A commit-scoped waiver applies only when the proposed target's commit equals its SHA. With no proposed commit, as on the overview today, it does not apply, which is the conservative choice.
  - A waiver whose blocker is gone is shown as inactive and can still be revoked.
- `readiness_waivers` rows are revoked, never deleted; the runtime role has no `DELETE`.

**Consequences.** "Ready" in Phase 2 means "no open critical tasks and the required checklist is done (or waived)". It does not yet mean "deployable". The Phase 4 approval gate must recompute readiness with the provider blockers and the proposed commit.

## B. What "today" is

**Context.** Overdue tasks and "deadlines in the next 14 days" compare date-only `due_date` values with today. The server clock is UTC-based, and the database container runs in UTC. Late in the evening, or for an operator east of UTC, the UTC day differs from the operator's calendar day, so a task due today would flip to overdue early or late.

**Decision.**
- "Today" is the calendar date in the app's time zone. That zone is `app_settings['app.time_zone']` (an IANA name, editable in Settings and stored canonically), falling back to the server's own zone.
- Due dates are plain calendar dates; date arithmetic never involves time zones.
- A task due today is not overdue; it becomes overdue once its day has passed in the app's time zone.
- Project "overdue" (target launch date passed and Live not reached) uses the same "today".

**Consequences.** Unit tests cover the same instant falling on different dates in different zones, a DST transition, and month, year and leap-day arithmetic. Integration tests cover the setting and its fallback.

## C. Same-project links enforced by the database

`tasks.project_stage_id` and `changes.task_id` must point within the same project. The spec says "service-checked"; following decision 0001, both are also composite FKs:
- `tasks (project_stage_id, project_id) → project_stages (id, project_id)`;
- `changes (task_id, project_id) → tasks (id, project_id)`.

The services check first to give a friendly field error. `changes.requested_by_contact_id` belongs to the project's client and stays service-checked, because `changes` has no `client_id` column to pair with. `changes.shipped_in_deployment_id` gets its FK when `deployments` exists (decision 0007).
