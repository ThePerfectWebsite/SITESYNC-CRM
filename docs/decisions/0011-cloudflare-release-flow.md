# 0011 — Release mechanism: approval-gated promote, rollback and (Cloudflare) build of the production branch

**Status:** accepted on 2026-11-03. The operator chose "whichever is best, and free" for the Cloudflare flow, and this is it. Built in Phase 4. Endpoints were checked against each provider's official API docs on 2026-11-03; none has been tried against a live account yet. This is the decision record spec §8.1 asked for.

## Context

Spec §8.1 expected each host to make a specific, already-built deploy live, so that an approval binds to exact build output. Cloudflare Pages, the operator's host (decision 0010), can't do that for a new release:
- With automatic production deploys off, pushes don't build production at all.
- Its create-deployment endpoint builds a branch's **HEAD**. `commit_hash` is metadata only, so a specific commit can't be chosen.
- Rollback can return production to an earlier *successful* production deploy.

That is the spec's `build_from_ref` fallback.

## Decision

1. **Mechanism per provider** (`HOSTING_CAPABILITIES` in `src/server/providers/hosting.ts`):

   | | Release a new version | Roll back |
   |---|---|---|
   | **Cloudflare Pages** | `build_from_ref`: `POST /accounts/{account_id}/pages/projects/{name}/deployments`, form field `branch` (builds HEAD) | `POST …/deployments/{deployment_id}/rollback` |
   | **Netlify** | `promote`: `POST /api/v1/sites/{site_id}/deploys/{deploy_id}/restore` on a built production deploy that auto-publishing (locked) didn't publish | the same `restore`, on an earlier published deploy |
   | **Vercel** | `promote`: `POST /v10/projects/{id}/promote/{deploymentId}` on a staged production deployment (no rebuild) | `POST /v1/projects/{id}/rollback/{deploymentId}` |

   Single-deploy reads for re-checks:
   - Cloudflare: `GET …/deployments/{id}`;
   - Netlify: `GET /api/v1/sites/{site_id}/deploys/{id}`;
   - Vercel: `GET /v13/deployments/{id}`.

   Tokens:
   - **Cloudflare:** needs **Account → Cloudflare Pages → Edit** to release. Read is enough for sync.
   - **Netlify and Vercel:** personal and access tokens already carry write access.

   Previews are never promoted (spec §8.1): only production deploys are offered and accepted.
2. **Cloudflare `build_from_ref` flow:**
   1. **Preflight:** the target commit is the production branch head that SiteSync last synced from GitHub, at most 5 minutes old.
   2. **Executor:** reads the branch head from GitHub live, while holding the approval lock, and refuses if it isn't the approved commit ("has moved").
   3. **Dispatch:** creates the deployment and records the returned deploy ID on SiteSync's own row.
   4. **Confirmation:** succeeds only when that deploy is the provider's current production deploy **and** its reported `commit_hash` is the approved commit. If someone pushed in the seconds between the check and the build, the result is `confirmed_failure` ("built X, not the approved Y"): no `go_live`, and a rollback is offered.
3. **No provider idempotency keys exist** on these endpoints, so "exactly one dispatch" is guaranteed by SiteSync:
   - the approval row lock (spec §8.4);
   - `deployments.approval_id` unique;
   - a dispatch that runs only from `pending`, under the row lock.

   Writes are never retried once they may have reached the provider: only a 429 (which the provider didn't act on) is retried, network errors and 5xx never are, and redirects aren't followed. The outcome is always decided from the provider's own state afterwards.
4. **Confirmation** (spec §5.3):
   - A `deploy-confirm` job re-syncs the link, then judges each in-flight release. It re-runs after 5, 10, 20 and 40 s, then every 60 s, for up to 20 minutes.
   - After that it's `timed_out`. Every later hosting sync, and **Re-check now**, still applies a late answer, audited as `late`.
   - A dispatch left `pending` for 2 minutes (the process stopped mid-dispatch) becomes `timed_out` with an explanation.
   - Success makes the SiteSync row `published` with `confirmation_source = 'provider'`, sets the website to `live`, and runs `go_live` in a savepoint (not for rollbacks). If the project has moved on, the release still stands and the skip is audited.
5. **Per-link work lock:** a transaction-scoped advisory lock serializes a link's sync upserts with a dispatch recording the new deploy ID, so the provider's new deploy always lands on SiteSync's own row, never a duplicate.
6. **Additions to spec §3.23:**
   - `target_deployment_id` (SiteSync's row for a promote/rollback target), required with `target_provider_deployment_id`;
   - `production_branch`, required for `build_from_ref`.

   The terminal-state trigger also forbids changing what was approved (target, hash, snapshot, reason, expiry). Approvals have no DELETE grant.
7. **Release stage rule:** release work starts at Ready to Deploy, or later linear stages (a re-deploy). Rollbacks go through the same gate, readiness included (spec §8.5), and don't move the stage.
8. **The preflight hash** covers everything that decides the release:
   - project, host, live and proposed deploy, target commit and branch;
   - checks on the commit, open PR numbers;
   - blocker keys, waivers used.

   It leaves out sync timestamps, so a background poll doesn't invalidate an approval page. Freshness (5 minutes) is checked separately, at approval.

## Cost

Everything is on the providers' free plans: Cloudflare API tokens are free, and builds count against the free monthly allowance. No paid feature is used.

## Alternatives

- **Deploy hooks (Cloudflare):** they also build only HEAD, but return no deployment ID and put a secret in a URL.
- **Direct Upload (build locally, upload exact files):** exact-commit deploys, but SiteSync would have to run builds. That's out of scope.
- **Leave auto-deploy on and only observe:** free, but there's no approval gate (spec §1.1).

## To confirm with a live account

- Cloudflare: the create response's `id` is the new deployment's; `canonical_deployment` moves to it on success, and to the target after a rollback; rollback refuses preview or failed deploys.
- Netlify: after `restore` with auto-publishing locked, the lock stays on, so later builds still don't publish.
- Vercel: `targets.production` updates after promote/rollback (decision 0010 §5); promote's empty response.
