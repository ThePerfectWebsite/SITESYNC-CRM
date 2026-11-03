# Connecting a host (Cloudflare Pages, Netlify or Vercel)

SiteSync reads each website's deployments from its host: what's live in production, recent preview builds, and whether the host auto-deploys. It changes something on the host only when you release or roll back through the approval gate (see [Releasing](#releasing)). Everything else works without a host connection.

## Cloudflare Pages

1. **Create an API token:** Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token, limited to your account, with permission **Account → Cloudflare Pages → Edit** to release from SiteSync (**Read** is enough to only see deploys).
2. **Find your account ID:** it's in the dashboard URL (`dash.cloudflare.com/<account id>/…`) or on the account overview page (32 characters).
3. **Add the token to `.env`** under a name of your choice, then restart SiteSync:
   ```
   CLOUDFLARE_API_TOKEN=...
   ```
4. **Add the integration:** Integrations → Add an integration → **Cloudflare Pages**, with the env var name and your account ID. Then click **Test connection**.
5. **Link the host:** on a website, **Link a host** → choose the connection and enter the **Pages project name** (as shown under Workers & Pages).

**Stop automatic production deploys** so that only an approved release reaches production: Pages project → Settings → Builds & deployments → **Configure Production deployments** → untick **Enable automatic production branch deployments** → Save. The website page shows **Auto-deploy off** once SiteSync has read the setting; until then it shows a warning.

## Netlify and Vercel

Same steps, with these differences:
- **Netlify:** use a personal access token and the site ID (Site configuration → Site details). To stop auto-publishing, use **Lock to stop auto publishing** on the published deploy.
- **Vercel:** use an access token and the project ID or name. Put the team ID in the integration's account field for team projects. To stop auto-publishing, turn off **Auto-assign Custom Production Domains** (Settings → Environments → Production).

## No connection yet?

**Link a host** with **None: a manual record**. It records where the site is hosted and clears readiness's "no production host" blocker. But SiteSync can't see deploys or confirm Live for it, so projects on that website stop at Ready to Deploy, or can skip past Live with a reason (decision 0004).

## What SiteSync shows

- **Website page:**
  - each host, with its auto-publish state, "Live now" and sync health;
  - the deploy history (state, commit, branch, URL, when last confirmed).
- **Project → Deployments:** the same history; deploys attributed to the project are labelled.
- **Project overview:**
  - live vs latest preview;
  - at Ready to Deploy, if the host published a production deploy by itself, **Mark Live with this deploy** (spec OQ-2).
- **Dashboard:** failed or in-progress production deploys, and integrations with sync errors.

## Releasing

At Ready to Deploy, the project overview's **Release** section offers what the host supports (decision 0011):
- **Cloudflare Pages:** release the production branch. SiteSync asks Cloudflare to build the branch, after checking on GitHub that its latest commit is the one you approved. The website needs a linked GitHub repository.
- **Netlify and Vercel:** promote a built production deploy that auto-publishing (locked) didn't publish yet.
- **All:** roll back to an earlier production deploy.

Each goes through the same steps:
1. **Preflight:** live vs proposed, GitHub checks, open pull requests and readiness. **Approve** stays disabled while anything blocks, or while the data is more than 5 minutes old (**Refresh from provider** fixes that).
2. **Approve** with a reason. The approval lasts 30 minutes.
3. **Confirm** with your password. SiteSync re-checks the host, the commit and readiness, then sends the release once.
4. **Confirmation:** SiteSync watches the host for up to 20 minutes. When the host reports the approved commit live, the project moves to Live. If it fails or times out, the project stays at Ready to Deploy, and the overview offers **Re-check now**, a new approval, or a rollback.

The endpoints, states and settings were checked against each provider's documentation on 2026-11-03 (decisions 0010 and 0011). They haven't been tried against a live account yet.
