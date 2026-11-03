# 0010 — Hosting providers: Cloudflare Pages added; endpoints, states and auto-deploy settings verified

**Context.** Phase 3b reads deployments from hosting providers. Spec §1.1 and §7 asked for provider endpoints, state mappings and the settings that stop auto-deploy to be verified against official docs and recorded here. During this phase the operator chose **Cloudflare Pages** as the host for client sites (its free plan allows commercial use; Vercel's Hobby plan does not). The spec named only Netlify and Vercel.

## Decision

1. **Providers.** `cloudflare` is added to the provider lists:
   - `integrations`, `hosting_links`, `deployments`, `webhook_inbox`;
   - the outbound allowlist (`api.cloudflare.com`, spec §4).

   This is a spec amendment. The migration widens two existing CHECK constraints (drop + re-add with an added value), which keeps all existing data. Netlify and Vercel stay supported, since their adapters were already built and tested. Cloudflare is the operator's primary host.
2. **Verified against official docs on 2026-11-03.** No live account has been used yet.

   | | Cloudflare Pages | Netlify | Vercel |
   |---|---|---|---|
   | Base | `https://api.cloudflare.com/client/v4` (v4 envelope `{success, result, result_info}`) | `https://api.netlify.com/api/v1` | `https://api.vercel.com` |
   | Auth | API token, `Bearer`; permission **Pages Read** | Personal access token, `Bearer` | Access token, `Bearer`; `teamId` query for team projects |
   | Test | `GET /accounts/{account_id}/pages/projects?per_page=1` | `GET /user` | `GET /v2/user` |
   | Project | `GET /accounts/{account_id}/pages/projects/{project_name}` | `GET /sites/{site_id}` | `GET /v9/projects/{idOrName}` |
   | Deployments | `GET …/projects/{name}/deployments?per_page=&page=` (most recent first) | `GET /sites/{site_id}/deploys?per_page=&page=` | `GET /v7/deployments?projectId=&limit=` |
   | Current production | `canonical_deployment.id` | `published_deploy.id` | `targets.production.id` (see 5) |

3. **State mapping** (§5.2), in `src/server/providers/hosting.ts`, unit-tested value by value:
   - **Cloudflare** (`latest_stage` = name × status):
     - stage `queued` → `queued`;
     - `initialize`/`clone_repo`/`build`/`deploy` while idle, active or succeeded (before deploy) → `building`;
     - `deploy`/`success` → `ready`, or `superseded` for an earlier production deploy;
     - status `failure` → `failed`; `canceled`/`skipped`, or `is_skipped` → `canceled`;
     - anything else → `unknown`.
   - **Netlify** (`state`, 15 swagger values):
     - `new`/`pending_review`/`accepted`/`enqueued`/`retrying` → `queued`;
     - `building`…`processed` → `building`;
     - `ready` → `ready`, or `superseded` for a previously published production deploy;
     - `error` → `failed`; `rejected` or `skipped` → `canceled`.
   - **Vercel** (`readyState`):
     - `QUEUED`/`INITIALIZING`/`BLOCKED` → `queued`; `BUILDING` → `building`;
     - `READY` → `ready`, or `superseded` when a production deploy has `readySubstate: PROMOTED` but isn't current;
     - `ERROR` → `failed`; `CANCELED`/`DELETED` → `canceled`.
   - **All providers:**
     - the provider's current production deploy is `published`;
     - when it changes, the old one becomes `superseded`; exactly one deploy per link is `published`;
     - environments are `production`/`preview` (plus Vercel `staging`).
4. **What stops auto-deploy** (§1.1), shown per host on the website page when it isn't confirmed off:
   - **Cloudflare Pages:** Settings → Builds & deployments → Configure Production deployments → untick "Enable automatic production branch deployments", and save. API: `source.config.production_deployments_enabled: false` → `disabled`, meaning pushes don't build production at all. Projects with no Git source (direct upload) are also `disabled`. The deprecated `deployments_enabled: false` is treated the same way.
   - **Netlify:** "Lock to stop auto publishing" on the published deploy. New deploys build but aren't published: `published_deploy.locked: true` → `locked`. `build_settings.stop_builds: true` → `disabled`.
   - **Vercel:** turn off "Auto-assign Custom Production Domains". Production deploys are then *Staged* until promoted: `autoAssignCustomDomains: false` → `locked`.
   - **Otherwise** the state is `enabled`, or `unknown` until synced, and the caveat stays on screen.
5. **Gaps to confirm with a live account:**
   - **Cloudflare current deploy:** the docs describe `canonical_deployment` as "the most recent production deployment". SiteSync treats it as the live one, which needs checking after a rollback.
   - **Cloudflare page size:** the deployments endpoint documents no `per_page` maximum, so SiteSync asks for 25 (not the spec's 50) until one is confirmed.
   - **Vercel current deploy:** `targets` has no published schema. When `targets.production.id` is absent, SiteSync falls back to the newest READY production deploy that isn't `STAGED`.
   - **Promote/rollback endpoints** (Phase 4) aren't used yet.
6. **Order tolerance.** `deployments.provider_updated_at` is an addition to §3.22. An upsert changes a row only when the provider's timestamp isn't older than the stored one. The "current deploy" pointer comes from the project read on every sync, and always wins.
7. **Integrity added in the database.**
   - `deployments (hosting_link_id, website_id)` references `hosting_links (id, website_id)`. The spec said "must match"; the database now enforces it.
   - `hosting_links (current_deployment_id, id)` references `deployments (id, hosting_link_id)`, deferrable, so a link's live deploy is one of its own.
   - The deferred FKs from decision 0007 now exist: `stage_history.deployment_id` and `changes.shipped_in_deployment_id`. `deployments.approval_id` gets its FK in Phase 4.
8. **Deployment facts and readiness.**
   - `databaseDeploymentFacts` replaces `noDeploymentsYet` in the app (decision 0007).
   - Readiness adds `hosting:missing` (unwaivable; any production host counts, including a manual record) and `preview:<id>` when a proposed deploy isn't built (decision 0008).
9. **OQ-2.** At Ready to Deploy, if the provider published a production deploy that SiteSync didn't initiate, the overview offers "Mark Live with this deploy". In one transaction, that:
   - attributes the deploy to the project;
   - runs the system `go_live`, which still requires `provider_observed`, `published`, `confirmation_source = 'provider'` and an integration-backed link (decision 0004).

   The operator's click is audited separately (`deployment.attributed`).

## Consequences

- Without a production host, every project's readiness is blocked. That's by design: there is nothing to release to.
- An operator who isn't ready to connect a provider can add a **manual** host record. It clears that blocker, but Live still needs a connected provider.
- Cloudflare's dashboard toggle turns automatic production builds off entirely rather than holding them. Phase 4's approval flow therefore has to create or promote the production deployment itself; its dispatch mechanism must be verified then (spec §8.1).

## Alternatives

- **Netlify and Vercel only:** rejected by the operator's choice of host.
- **Replace Netlify and Vercel with Cloudflare:** unnecessary, since they were already built and tested.
