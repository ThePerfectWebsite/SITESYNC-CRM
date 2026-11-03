import { expect, test, type Page } from "@playwright/test";

// Work tracking journey (Phase 2): task + checklist → readiness clears.
// Runs after records.spec.ts (one worker, alphabetical) but sets up its own project.
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

const tabs = (page: Page) => page.getByRole("navigation", { name: "Project sections" });
const readinessStatus = (page: Page) => page.getByRole("status").filter({ hasText: /ready/i });

let projectUrl = "";

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("set up a project for work tracking", async ({ page }) => {
  await page.goto("/clients/new");
  await page.getByLabel("Name", { exact: true }).fill("Lighthouse Gallery");
  await page.getByRole("button", { name: "Create client" }).click();
  await page.getByRole("link", { name: "Add website" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Gallery site");
  await page.getByRole("button", { name: "Create website" }).click();
  // A production host (here a manual record) clears readiness's "no production host" blocker.
  await page.getByText("Link a host").click();
  await page.getByLabel("Connection", { exact: true }).selectOption({ label: "None: a manual record (no sync)" });
  await page.getByLabel("Host", { exact: true }).selectOption("cloudflare");
  await page.getByRole("button", { name: "Link host" }).click();
  await expect(page.getByText("Manual record (not synced)")).toBeVisible();
  await page.getByRole("link", { name: "New project" }).click();
  await page.getByLabel("Website", { exact: true }).selectOption({ label: "Gallery site" });
  await page.getByLabel("Name", { exact: true }).fill("Autumn exhibition");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Autumn exhibition" })).toBeVisible();
  projectUrl = new URL(page.url()).pathname;

  // A new project starts with the default checklist, so it isn't ready.
  await expect(readinessStatus(page)).toContainText("Not ready: 10 blockers");
});

test("a critical task blocks readiness until it's done", async ({ page }) => {
  await page.goto(`${projectUrl}/tasks`);
  await page.getByLabel("Title", { exact: true }).fill("Fix broken ticket link");
  await page.getByLabel("Priority", { exact: true }).selectOption("critical");
  await page.getByLabel("Due date", { exact: true }).fill("2020-01-01");
  await page.getByLabel("Reference link", { exact: true }).fill("not a url");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByText(/Enter a full link starting with https/)).toBeVisible();
  // The priority choice survives the validation error.
  await expect(page.getByLabel("Priority", { exact: true })).toHaveValue("critical");
  await page.getByLabel("Reference link", { exact: true }).fill("https://tickets.example/42");
  await page.getByRole("button", { name: "Add task" }).click();

  const row = page.getByRole("row", { name: /Fix broken ticket link/ });
  await expect(row).toContainText("Critical");
  await expect(row).toContainText("Overdue");

  await tabs(page).getByRole("link", { name: "Overview" }).click();
  await expect(readinessStatus(page)).toContainText("Not ready: 11 blockers");
  await expect(page.getByRole("link", { name: "Critical task open: Fix broken ticket link" })).toBeVisible();

  await page.goto(`${projectUrl}/tasks`);
  await page.getByRole("button", { name: "Complete “Fix broken ticket link”" }).click();
  await expect(page.getByText("No open tasks")).toBeVisible();
  await page.getByRole("link", { name: "All", exact: true }).click();
  await expect(page.getByRole("row", { name: /Fix broken ticket link/ })).toContainText("Done");

  await tabs(page).getByRole("link", { name: "Overview" }).click();
  await expect(readinessStatus(page)).toContainText("Not ready: 10 blockers");
});

test("checking the checklist and waiving one item makes the project ready", async ({ page }) => {
  await page.goto(`${projectUrl}/settings`);
  const items = page.locator("#checklist li").filter({ has: page.getByRole("checkbox") });
  const count = await items.count();
  expect(count).toBe(10);
  // Check all but the last item (client sign-off).
  for (let i = 0; i < count - 1; i++) {
    const item = items.nth(i);
    await item.getByRole("checkbox").check();
    await item.getByRole("button", { name: /^Save/ }).click();
    await expect(page.locator("#checklist li").nth(i).getByText(/Checked by E2E Operator/)).toBeVisible();
  }

  await tabs(page).getByRole("link", { name: "Overview" }).click();
  await expect(readinessStatus(page)).toContainText("Not ready: 1 blocker");

  // Waive the last one: a reason is required.
  await page.getByText("Waive this blocker").click();
  await page.getByRole("button", { name: "Waive blocker" }).click();
  await expect(page.getByText("Give a reason (at least 3 characters).")).toBeVisible();
  await page.getByLabel("Why is it OK to release without this?").fill("Client approved by phone; written sign-off to follow");
  await page.getByRole("button", { name: "Waive blocker" }).click();
  await expect(readinessStatus(page)).toContainText("Ready to release, with 1 waived blocker");
  await expect(page.getByText("Reason: Client approved by phone; written sign-off to follow")).toBeVisible();

  // Revoking brings the blocker back; checking the item clears it for good.
  await page.getByRole("button", { name: /Revoke waiver/ }).click();
  await expect(readinessStatus(page)).toContainText("Not ready: 1 blocker");
  await page.goto(`${projectUrl}/settings`);
  const last = page.locator("#checklist li").filter({ hasText: "Client sign-off received" });
  await last.getByRole("checkbox").check();
  await last.getByRole("button", { name: /^Save/ }).click();
  await expect(page.locator("#checklist li").filter({ hasText: "Client sign-off received" }).getByText(/Checked by/)).toBeVisible();
  await tabs(page).getByRole("link", { name: "Overview" }).click();
  await expect(readinessStatus(page)).toContainText("Ready to release.");

  // Activity records the waive and the revoke.
  await tabs(page).getByRole("link", { name: "Activity" }).click();
  await expect(page.getByText(/Readiness blocker waived on Autumn exhibition/)).toBeVisible();
  await expect(page.getByText(/Readiness waiver revoked on Autumn exhibition/)).toBeVisible();
});

test("changes can be logged, and need a category", async ({ page }) => {
  await page.goto(`${projectUrl}/changes`);
  await page.getByLabel("Title", { exact: true }).fill("Add audio guide page");
  await page.getByRole("button", { name: "Log change" }).click();
  await expect(page.getByText("Choose a category.")).toBeVisible();
  await page.getByLabel("Category", { exact: true }).selectOption("feature");
  await page.getByRole("button", { name: "Log change" }).click();
  const row = page.getByRole("row", { name: /Add audio guide page/ });
  await expect(row).toContainText("Feature");
  await expect(row).toContainText("Proposed");
});

test("dashboard lists overdue and upcoming work; quick-create adds a task", async ({ page }) => {
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "Task" }).click();
  await page.getByLabel("Project", { exact: true }).selectOption({ label: "Autumn exhibition (Lighthouse Gallery)" });
  await page.getByLabel("Title", { exact: true }).fill("Send press release");
  await page.getByLabel("Due date", { exact: true }).fill("2020-02-02");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("row", { name: /Send press release/ })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("list", { name: "Overdue work" })).toContainText("Send press release");

  await page.keyboard.press("Control+k");
  await page.keyboard.type("press release");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "Send press release" })).toBeVisible();
});

test("settings: the checklist template can gain an item, and the time zone is validated", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("New item 1", { exact: true }).fill("Cookie banner reviewed");
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText("Release checklist template saved.")).toBeVisible();
  await expect(page.locator('input[name="label"]').nth(10)).toHaveValue("Cookie banner reviewed");

  await page.getByRole("textbox", { name: "Time zone" }).fill("Mars/Olympus");
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByText(/Enter an IANA time zone/)).toBeVisible();
  await page.getByRole("textbox", { name: "Time zone" }).fill("europe/london");
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByText("Time zone saved.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Time zone" })).toHaveValue("Europe/London");

  // Older projects can pick up new template items.
  await page.goto(`${projectUrl}/settings`);
  await page.getByRole("button", { name: "Add checklist from template" }).click();
  await expect(page.locator("#checklist li").filter({ hasText: "Cookie banner reviewed" })).toBeVisible();
});
