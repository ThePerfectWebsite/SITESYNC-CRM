import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

// The release gate (Phase 4), with no real provider. Nothing here reaches a
// host: a manual host can't be released, and the confirmation screen is tested
// with a wrong password and a revoke, neither of which calls a provider.
test.describe.configure({ mode: "serial" });

const ADMIN = {
  name: "E2E Operator",
  email: "e2e-operator@example.test",
  password: "an end-to-end test passphrase",
};

async function signIn(page: Page) {
  await page.goto("/");
  if (page.url().endsWith("/setup")) {
    await page.getByLabel("Your name", { exact: true }).fill(ADMIN.name);
    await page.getByLabel("Email", { exact: true }).fill(ADMIN.email);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByLabel("Confirm password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Create admin account" }).click();
    await expect(page).toHaveURL(/\/login/);
  }
  if (/\/login/.test(page.url())) {
    await page.getByLabel("Email", { exact: true }).fill(ADMIN.email);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page).toHaveURL(/\/$/);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/** A client, website and project; returns the project's id. */
async function makeProject(page: Page, name: string) {
  await page.goto("/clients/new");
  await page.getByLabel("Name", { exact: true }).fill(`${name} Client`);
  await page.getByRole("button", { name: "Create client" }).click();
  await page.getByRole("link", { name: "Add website" }).click();
  await page.getByLabel("Name", { exact: true }).fill(`${name} site`);
  await page.getByRole("button", { name: "Create website" }).click();
  await expect(page).toHaveURL(/\/websites\/[0-9a-f-]{36}$/);
  const websiteUrl = page.url();
  await page.getByRole("link", { name: "New project" }).click();
  await page.getByLabel("Website", { exact: true }).selectOption({ label: `${name} site` });
  await page.getByLabel("Name", { exact: true }).fill(`${name} project`);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  return { projectId: page.url().split("/").pop()!, websiteUrl };
}

test("a manual host can't be released through SiteSync", async ({ page }) => {
  const { projectId, websiteUrl } = await makeProject(page, "Manual Release");
  await page.goto(websiteUrl);
  await page.getByText("Link a host").click();
  await page.getByLabel("Connection", { exact: true }).selectOption({ label: "None: a manual record (no sync)" });
  await page.getByRole("button", { name: "Link host" }).click();

  await page.goto(`/projects/${projectId}`);
  const release = page.locator("section").filter({ has: page.getByRole("heading", { name: "Release", exact: true }) });
  await expect(release.getByText(/SiteSync releases through a connected host/)).toBeVisible();

  await page.goto(`/projects/${projectId}/deploy/preflight?action=build_from_ref`);
  await expect(page.getByRole("heading", { name: "Build and release the production branch" })).toBeVisible();
  await expect(page.getByText(/The production host is a manual record/)).toBeVisible();
  await expect(page.getByText(/Move it to Ready to Deploy first/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve release" })).toHaveCount(0);
  await expect(page.getByText("Approve is unavailable until everything above is resolved.")).toBeVisible();
});

test("final confirmation: a wrong password leaves the approval waiting; revoking ends it", async ({ page }) => {
  const { projectId } = await makeProject(page, "Confirm Screen");
  const owner = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL_TEST });
  await owner.connect();
  let approvalId: string;
  try {
    // Seed a Cloudflare host and an approval directly: reaching one through the UI
    // needs a live provider sync, which E2E never does.
    const { rows: project } = await owner.query("SELECT website_id FROM projects WHERE id = $1", [projectId]);
    const { rows: user } = await owner.query("SELECT id FROM users WHERE email = $1", [ADMIN.email]);
    const { rows: integration } = await owner.query(
      `INSERT INTO integrations (provider, name, token_env_var, account_ref) VALUES ('cloudflare', 'E2E Confirm CF', 'E2E_CONFIRM_TOKEN', '0123456789abcdef0123456789abcdef') RETURNING id`,
    );
    const { rows: link } = await owner.query(
      `INSERT INTO hosting_links (website_id, integration_id, provider, provider_project_id, environment) VALUES ($1, $2, 'cloudflare', 'confirm-site', 'production') RETURNING id`,
      [project[0].website_id, integration[0].id],
    );
    const { rows: approval } = await owner.query(
      `INSERT INTO production_approvals (project_id, website_id, hosting_link_id, provider, provider_project_id, environment, action,
         target_commit_sha, production_branch, preflight_snapshot, preflight_hash, reason, approved_by, approved_at, expires_at)
       VALUES ($1, $2, $3, 'cloudflare', 'confirm-site', 'production', 'build_from_ref', repeat('a', 40), 'main',
         '{"website":{"name":"Confirm Screen site"}}', sha256('e2e'), 'E2E release', $4, now(), now() + interval '30 minutes')
       RETURNING id`,
      [projectId, project[0].website_id, link[0].id, user[0].id],
    );
    approvalId = approval[0].id;
  } finally {
    await owner.end();
  }

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("link", { name: "Confirm or revoke it" }).click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${approvalId}/confirm$`));
  await expect(page.getByRole("heading", { level: 1, name: "Confirm release" })).toBeVisible();
  await expect(page.getByText("main at aaaaaaa")).toBeVisible();
  await expect(page.getByText(/left/).first()).toBeVisible();

  await page.getByLabel("Your password").fill("not the password");
  await page.getByRole("button", { name: "Confirm and release" }).click();
  await expect(page.getByText("That password isn't right. The approval is unchanged.")).toBeVisible();

  await page.getByRole("button", { name: "Revoke approval" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
  await page.goto(`/approvals/${approvalId}/confirm`);
  await expect(page.getByText("This approval was revoked.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm and release" })).toHaveCount(0);
});
