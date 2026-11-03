# Connecting GitHub

SiteSync reads from GitHub: commits on each website's production branch, open pull requests, and check runs. It never writes to GitHub, and it never clones or stores source code. Everything else works without it.

## 1. Create a read-only token

Use a **fine-grained personal access token** limited to the repositories of the websites you manage:

- **Repository access:** only the repositories you'll link.
- **Repository permissions** (all *Read-only*): **Metadata**, **Contents**, **Pull requests**, **Checks**, **Commit statuses**.

These permissions are the minimum expected for the endpoints SiteSync calls:
- `GET /user`;
- `GET /repos/{owner}/{repo}`;
- `.../branches/{branch}`, `.../commits`, `.../pulls` and `.../commits/{sha}/check-runs`.

Checked live (2026-11-03): with these permissions, a fine-grained token can authenticate, read a repository and list its pull requests. A private repository the token wasn't granted answers 404, which SiteSync reports as "GitHub can't see owner/repo". Reading commits and check runs hasn't yet been tried live against a repository that has them. If a sync reports that GitHub refused the token, add the permission named in the error.

A classic token with the `repo` scope also works but grants write access; prefer fine-grained.

## 2. Put it in the environment, not in SiteSync

Add it to `.env` (git-ignored) under a name of your choice, for example:

```
GITHUB_TOKEN=github_pat_...
```

Restart SiteSync. SiteSync stores only the **name** `GITHUB_TOKEN`, reads the value when it calls GitHub, and redacts token-shaped strings from logs, errors and audit records. Names starting with `DATABASE_`, `POSTGRES_`, `SITESYNC_`, `PG` or `NODE_` (and a few system names) are refused. That stops an integration from sending one of SiteSync's own secrets to GitHub as a "token".

## 3. Add the integration and link repositories

1. **Integrations → Add a GitHub integration.** Give it a name and the env var name, then **Test connection**.
2. On a website, **Link a GitHub repository**: owner, repository, production branch. The first sync starts straight away. After that SiteSync polls every 10 minutes, and **Refresh from GitHub** asks for one now.

Sync limits: the production branch head, the last 50 commits, up to 100 open pull requests, and check runs for the latest 10 commits. SiteSync only calls `api.github.com`, over https, with a 10 s timeout. Rate limits are respected: it backs off on 403/429 and skips polling an integration that's under 10% of its limit until the reset.

## 4. Readiness

For a project whose website has a primary repository link, readiness also counts every check run on the production branch head (the "proposed commit") that:
- **failed** (`failure`, `timed_out`, `action_required` or `cancelled`), or
- **hasn't finished**.

Waivers can be limited to one commit SHA. If the integration is disabled, not configured or erroring, readiness shows a note ("GitHub checks unavailable") instead of a blocker. GitHub problems never block manual work.

Open pull requests into the production branch are shown on the website page for information. They aren't blockers (spec OQ-7).

## 5. Webhooks (optional, off by default)

Polling is enough. Webhooks only make updates arrive sooner, and GitHub must be able to reach this machine. SiteSync never opens a tunnel itself; if you want webhooks, run one you trust (for example Cloudflare Tunnel or `ngrok`) that forwards to `http://127.0.0.1:3000`.

1. Choose a long random secret and add it to `.env`, e.g. `GITHUB_WEBHOOK_SECRET=...`. Restart.
2. In the integration's **Edit settings**, tick **Accept GitHub webhooks** and enter the secret's env var name. The page then shows the webhook URL, `…/api/webhooks/github/<integration id>`; use your tunnel's public host in place of `127.0.0.1:3000`.
3. In the repository's GitHub settings, add a webhook with:
   - that URL;
   - content type `application/json`;
   - the same secret;
   - events: pushes, pull requests, check runs, check suites.

**What happens to each delivery:**
- **Rejected, nothing stored:**
  - bad or missing signature → 401;
  - over 1 MiB → 413;
  - webhooks off, or unknown integration → 404.
- **Repeat of a delivery already received** → 200, ignored.
- **Event type not listed above** → stored as *ignored*.
- **Everything else** is processed in the background. A failed delivery retries with backoff, and after 8 failures it is *dead-lettered*. Dead letters can be replayed from **Integrations → Webhook deliveries**.
