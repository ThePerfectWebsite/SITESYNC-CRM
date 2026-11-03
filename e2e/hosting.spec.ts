import { expect, test, type Page } from "@playwright/test";

// Hosting (Phase 3b), with no real provider: the server has no Cloudflare token,
// so syncs report "not configured" and nothing leaves the machine.
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

test("add a Cloudflare Pages integration: the account ID is required", async ({ page }) => {
  await page.goto("/integrations");
  // Open the add form (it starts open only when there are no integrations yet).
  await page.locator("details").filter({ hasText: "Add an integration" }).evaluate((d) => ((d as HTMLDetailsElement).open = true));
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add integration" }) });
  await form.getByLabel("Provider", { exact: true }).selectOption("cloudflare");
  await expect(form.getByText("Accept GitHub webhooks")).toHaveCount(0);
  await form.getByLabel("Name", { exact: true }).fill("Studio Cloudflare");
  await form.getByLabel("Token env var name").fill("E2E_CLOUDFLARE_TOKEN");
  await form.getByLabel("Cloudflare account ID").fill("not-an-id");
  await form.getByRole("button", { name: "Add integration" }).click();
  await expect(page.getByText(/Enter your Cloudflare account ID/)).toBeVisible();
  await form.getByLabel("Cloudflare account ID").fill("0123456789abcdef0123456789abcdef");
  await form.getByRole("button", { name: "Add integration" }).click();
  await expect(page.getByText("Integration added. Test the connection next.")).toBeVisible();
  const card = page.locator("li[id^='integration-']").filter({ hasText: "Studio Cloudflare" });
  await expect(card.getByText("Cloudflare", { exact: true })).toBeVisible();
  await expect(card.getByText("Not used (polling only)")).toBeVisible();
});

test("link a Cloudflare host: the auto-deploy caveat shows until the setting is known", async ({ page }) => {
  await page.goto("/clients/new");
  await page.getByLabel("Name", { exact: true }).fill("Pages Client");
  await page.getByRole("button", { name: "Create client" }).click();
  await page.getByRole("link", { name: "Add website" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Pages site");
  await page.getByRole("button", { name: "Create website" }).click();

  await page.getByText("Link a host").click();
  await page.getByLabel("Connection", { exact: true }).selectOption({ label: "Studio Cloudflare (Cloudflare)" });
  await page.getByRole("button", { name: "Link host" }).click();
  await expect(page.getByText(/Enter the project on the provider/)).toBeVisible();
  await page.getByLabel("Pages project name", { exact: true }).fill("pages-site");
  await page.getByRole("button", { name: "Link host" }).click();

  const hosting = page.locator("section").filter({ has: page.getByRole("heading", { name: "Hosting", exact: true }) });
  await expect(hosting.getByText("Cloudflare Pages")).toBeVisible();
  await expect(hosting.getByText("Auto-publish unknown")).toBeVisible();
  await expect(hosting.getByText(/SiteSync can.t stop this host from auto-deploying/)).toBeVisible();
  await expect(hosting.getByText(/untick .Enable automatic production branch deployments./)).toBeVisible();
  await expect(hosting.getByText("Not configured")).toBeVisible();

  // A second production host is refused (one per website).
  await page.getByText("Link a host").click();
  await page.getByLabel("Connection", { exact: true }).selectOption({ label: "None: a manual record (no sync)" });
  await page.getByRole("button", { name: "Link host" }).click();
  await expect(page.getByText(/already has a production host/)).toBeVisible();
});

test("a project without a production host shows the unwaivable hosting blocker", async ({ page }) => {
  await page.goto("/clients/new");
  await page.getByLabel("Name", { exact: true }).fill("No Host Client");
  await page.getByRole("button", { name: "Create client" }).click();
  await page.getByRole("link", { name: "Add website" }).click();
  await page.getByLabel("Name", { exact: true }).fill("No host site");
  await page.getByRole("button", { name: "Create website" }).click();
  await page.getByRole("link", { name: "New project" }).click();
  await page.getByLabel("Website", { exact: true }).selectOption({ label: "No host site" });
  await page.getByLabel("Name", { exact: true }).fill("No host project");
  await page.getByRole("button", { name: "Create project" }).click();

  const blockers = page.getByRole("list", { name: "Readiness blockers" });
  const hostBlocker = blockers.locator("li").filter({ hasText: "No production host" });
  await expect(hostBlocker).toBeVisible();
  await expect(hostBlocker.getByText("Waive this blocker")).toHaveCount(0);
  await hostBlocker.getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "No host site" })).toBeVisible();

  await page.goto("/projects");
  await page.getByRole("link", { name: "No host project" }).click();
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Deployments" }).click();
  await expect(page.getByText("No deployments")).toBeVisible();
});
