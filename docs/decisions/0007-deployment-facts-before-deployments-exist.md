# 0007 — Stage rules that depend on deployments, before deployments exist

**Context.** Phase 1 builds the stage machine (spec §5.1), but several of its rules depend on tables that only arrive in Phases 3b and 4:

- `go_live` needs a provider-confirmed production `deployments` row (decision 0004).
- `skip_forward` over Live is allowed only when the website has no integration-backed production `hosting_links` row.
- `archive` is refused while a `production_approvals` row is awaiting confirmation or a SiteSync deploy is in flight.
- A project's website can't change once it has deployments (§3.11).

`stage_history.deployment_id` is meant to reference `deployments`, which doesn't exist yet.

**Decision.**

1. The stage and project services read those facts through one interface, `DeploymentFacts` (`src/server/stages/deployment-facts.ts`). Phase 1 ships `noDeploymentsYet`, which answers "no" to everything and finds no deployment. That is the truth while the tables are absent: no website has an integration-backed link, nothing is in flight, and `go_live` is always refused. Phases 3b/4 replace it with a database-backed implementation; the rules themselves don't change.
2. `systemGoLive()` exists and is fully tested with fake facts, but no Server Action or route calls it. Only the deployment confirmation path (Phases 3b/4) will.
3. `stage_history.deployment_id` is a plain `uuid` column for now. The phase that creates `deployments` adds the FK (`ALTER TABLE … ADD CONSTRAINT … REFERENCES deployments`) in an additive migration. No rows can carry a value before then, because `go_live` is the only transition that sets it and the database requires `actor_type = 'system'` for it.
4. Defence in depth for "no user moves a project to Live":
   - The pure state machine refuses Live as a target for every user transition (`advance`, `skip_forward`, `move_back`, `resume`).
   - The service raises a non-domain error if a user plan ever targets Live anyway.
   - The database check `stage_history_go_live_check` makes `go_live` rows system-only and requires a `deployment_id`.

**Consequences.** Until hosting sync exists, every project without a provider stops at Ready to Deploy. The operator can skip past Live with a reason (Live is then `skipped`), as decision 0004 intends. When Phase 3b lands, these must be updated together: `DeploymentFacts`, the FK, and the overview's "no connected hosting provider" message. The message is currently shown whenever the facts say there's no link.

**Alternatives.**
- Create empty `hosting_links` / `deployments` tables now. Rejected: it would freeze their schema before the provider APIs are verified (Phase S handoff §5).
- Leave the rules out until Phase 3b. Rejected: the plan asks for the stage machine, including `go_live`, to be complete and tested in Phase 1.
