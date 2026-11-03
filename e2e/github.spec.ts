import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// GitHub integration (Phase 3a), with no real GitHub: the server has a webhook
// secret but no token, so syncs report "not configured" and nothing leaves the machine.
test.describe.configure({ mode: "serial" });

const ADMIN = {
  name: "E2E Operator",
  email: "e2e-operator@example.test",
  password: "an end-to-end test passphrase",
};
const WEBHOOK_SECRET = "e2e-webhook-secret";

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

let integrationId = "";

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("add a GitHub integration: env var names only, reserved names refused", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.getByRole("link", { name: "Integrations" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
  await expect(page.getByText(/can.t stop a hosting provider from auto-deploying/)).toBeVisible();

  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add integration" }) });
  await form.getByLabel("Name", { exact: true }).fill("Studio GitHub");
  await form.getByLabel("Token env var name").fill("DATABASE_OWNER_URL");
  await form.getByRole("button", { name: "Add integration" }).click();
  await expect(page.getByText(/reserved for SiteSync.s own settings/)).toBeVisible();
  await form.getByLabel("Token env var name").fill("E2E_GITHUB_TOKEN");
  await form.getByRole("button", { name: "Add integration" }).click();
  await expect(page.getByText("Integration added. Test the connection next.")).toBeVisible();

  const card = page.locator("li[id^='integration-']").filter({ hasText: "Studio GitHub" });
  integrationId = (await card.getAttribute("id"))!.replace("integration-", "");
  await expect(card.getByText("not set")).toBeVisible();

  // Testing without the env var set: unconfigured, and no request goes out.
  await card.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Connection test failed.")).toBeVisible();
  const tested = page.locator(`#integration-${integrationId}`);
  await expect(tested.getByText("Not configured")).toBeVisible();
  await expect(tested.getByText(/E2E_GITHUB_TOKEN isn.t set on the server/).first()).toBeVisible();
  expect(problems).toEqual([]);
});

test("link a repository; checks are reported as unavailable, never as blockers", async ({ page }) => {
  await page.goto("/clients/new");
  await page.getByLabel("Name", { exact: true }).fill("Repo Client");
  await page.getByRole("button", { name: "Create client" }).click();
  await page.getByRole("link", { name: "Add website" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Repo site");
  await page.getByRole("button", { name: "Create website" }).click();

  await page.getByText("Link a GitHub repository").click();
  await page.getByLabel("Owner", { exact: true }).fill("acme-studio");
  await page.getByLabel("Repository", { exact: true }).fill("bad/name");
  await page.getByRole("button", { name: "Link repository" }).click();
  await expect(page.getByText(/Enter the repository name/)).toBeVisible();
  await page.getByLabel("Repository", { exact: true }).fill("repo-site.git");
  await page.getByRole("button", { name: "Link repository" }).click();

  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Repositories" }) });
  await expect(panel.getByRole("link", { name: /acme-studio\/repo-site/ })).toBeVisible();
  await expect(panel.getByText("Not configured")).toBeVisible();
  await expect(panel.getByText("Last synced never.")).toBeVisible();

  // A project on this website: readiness notes the missing checks but isn't blocked by them.
  await page.getByRole("link", { name: "New project" }).click();
  await page.getByLabel("Website", { exact: true }).selectOption({ label: "Repo site" });
  await page.getByLabel("Name", { exact: true }).fill("Repo project");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("list", { name: "Readiness notes" })).toContainText(
    "GitHub checks unavailable for acme-studio/repo-site",
  );
  await expect(page.getByRole("list", { name: "Readiness blockers" })).not.toContainText(/Check (failing|still running)/);
});

test("webhook endpoint: 404 while disabled; with webhooks on, only signed deliveries are accepted", async ({ page, request }) => {
  const body = JSON.stringify({ zen: "Design for failure.", hook_id: 1 });
  const sign = (secret: string, payload: string) => `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const post = (headers: Record<string, string>, payload = body) =>
    request.post(`/api/webhooks/github/${integrationId}`, {
      data: payload,
      headers: { "content-type": "application/json", "x-github-event": "ping", ...headers },
      maxRedirects: 0,
    });

  expect((await post({ "x-github-delivery": randomUUID(), "x-hub-signature-256": sign(WEBHOOK_SECRET, body) })).status()).toBe(404);

  // Turn webhooks on.
  await page.goto("/integrations");
  const card = page.locator(`#integration-${integrationId}`);
  await card.getByText("Edit settings").click();
  await card.getByLabel("Accept GitHub webhooks").check();
  await card.getByLabel("Webhook secret env var name").fill("E2E_GITHUB_WEBHOOK_SECRET");
  await card.getByRole("button", { name: "Save integration" }).click();
  await expect(page.getByText("Integration saved.")).toBeVisible();
  await expect(page.locator(`#integration-${integrationId}`).getByText(`/api/webhooks/github/${integrationId}`)).toBeVisible();

  const delivery = randomUUID();
  expect((await post({ "x-github-delivery": delivery, "x-hub-signature-256": sign("wrong-secret", body) })).status()).toBe(401);
  expect((await post({ "x-github-delivery": delivery })).status()).toBe(401);
  expect((await post({ "x-github-delivery": delivery, "x-hub-signature-256": sign(WEBHOOK_SECRET, body) })).status()).toBe(202);
  expect((await post({ "x-github-delivery": delivery, "x-hub-signature-256": sign(WEBHOOK_SECRET, body) })).status()).toBe(200);
  const big = JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) });
  expect((await post({ "x-github-delivery": randomUUID(), "x-hub-signature-256": sign(WEBHOOK_SECRET, big) }, big)).status()).toBe(413);

  // The ping is in the inbox and gets processed (by the job runner).
  await expect
    .poll(async () => {
      await page.goto("/integrations");
      return page.locator("section").filter({ has: page.getByRole("heading", { name: "Webhook deliveries" }) }).innerText();
    }, { timeout: 15_000 })
    .toMatch(/ping[\s\S]*processed/);
});

test("the webhook route isn't affected by sessions or the Origin check, and other routes still are", async ({ request }) => {
  const response = await request.post("/logout", { headers: { origin: "http://evil.test" }, maxRedirects: 0 });
  expect(response.status()).toBe(403);
  const unknown = await request.post("/api/webhooks/github/not-a-uuid", { data: "{}" });
  expect(unknown.status()).toBe(404);
});
