import { expect, test, type Page } from "@playwright/test";

// Core records journey (Phase 1). Runs after auth.spec.ts (one worker,
// alphabetical), but creates the admin itself if run on its own.
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

test("create client → website → project → advance stage → activity shows it", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));

  // Client, via the quick-create menu.
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "Client" }).click();
  await expect(page).toHaveURL(/\/clients\/new$/);
  await page.getByRole("button", { name: "Create client" }).click();
  await expect(page.getByText("Enter a name.")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Harbourside Bakery");
  await page.getByRole("button", { name: "Create client" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Harbourside Bakery" })).toBeVisible();
  await expect(page.getByText("harbourside-bakery")).toBeVisible();

  // A contact.
  await page.getByText("Add a contact").click();
  await page.locator("#new-contact-name").fill("Pat Baker");
  await page.locator("#new-contact-email").fill("pat@example.test");
  await page.locator("#new-contact-isPrimary").check();
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByText("Pat Baker", { exact: true })).toBeVisible();
  await expect(page.getByText("Primary", { exact: true })).toBeVisible();

  // Website, from the client page.
  await page.getByRole("link", { name: "Add website" }).click();
  await expect(page.getByLabel("Client", { exact: true })).toHaveValue(/.+/);
  await page.getByLabel("Name", { exact: true }).fill("Bakery shop");
  await page.getByLabel("Primary domain", { exact: true }).fill("https://bad.example");
  await page.getByRole("button", { name: "Create website" }).click();
  await expect(page.getByText(/Enter a domain like example.com/)).toBeVisible();
  await page.getByLabel("Primary domain", { exact: true }).fill("Harbourbakes.example");
  await page.getByRole("button", { name: "Create website" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Bakery shop" })).toBeVisible();
  await expect(page.getByText("harbourbakes.example")).toBeVisible();

  // Project, from the website page (client and website preselected).
  await page.getByRole("link", { name: "New project" }).click();
  await page.getByLabel("Website", { exact: true }).selectOption({ label: "Bakery shop (harbourbakes.example)" });
  await page.getByLabel("Name", { exact: true }).fill("Spring relaunch");
  await page.getByLabel("Code", { exact: true }).fill("HB-2026-01");
  await page.getByLabel("Target launch date", { exact: true }).fill("2026-12-01");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Spring relaunch" })).toBeVisible();
  const rail = page.getByRole("list", { name: "Workflow stages" });
  await expect(rail.locator('[aria-current="step"]')).toContainText("Enquiry");

  // Advance one stage.
  await page.getByRole("button", { name: "Advance to Discovery" }).click();
  await expect(rail.locator('[aria-current="step"]')).toContainText("Discovery");

  // Skipping forward needs a reason, and Live is never offered.
  await page.getByText("Move to another stage").click();
  const target = page.getByLabel("Move to", { exact: true });
  await expect(target.locator("option", { hasText: /^Live$/ })).toHaveCount(0);
  await target.selectOption({ label: "Build" });
  await page.getByRole("button", { name: "Move stage" }).click();
  await expect(page.getByText("Give a reason (at least 3 characters).")).toBeVisible();
  await page.getByLabel("Reason", { exact: true }).fill("Design signed off in the kickoff");
  await page.getByRole("button", { name: "Move stage" }).click();
  await expect(rail.locator('[aria-current="step"]')).toContainText("Build");
  await expect(rail.getByText("Skipped")).toHaveCount(1);

  // Activity shows both moves, with the reason.
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByText("Spring relaunch: Enquiry → Discovery")).toBeVisible();
  await expect(page.getByText("Spring relaunch: Discovery → Build")).toBeVisible();
  await expect(page.getByText("Reason: Design signed off in the kickoff")).toBeVisible();
  await expect(page.getByText("Project Spring relaunch created at Enquiry")).toBeVisible();

  expect(problems).toEqual([]);
});

test("Ready to Deploy explains why the project can't reach Live", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("link", { name: "Spring relaunch" }).click();
  await page.getByText("Move to another stage").click();
  await page.getByLabel("Move to", { exact: true }).selectOption({ label: "Ready to Deploy" });
  await page.getByLabel("Reason", { exact: true }).fill("Build finished early");
  await page.getByRole("button", { name: "Move stage" }).click();
  await expect(page.getByText(/no connected hosting provider, so SiteSync can't confirm a deploy/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Advance to Live/ })).toHaveCount(0);
  await expect(page.getByText(/Reached automatically after a confirmed production deploy/)).toBeVisible();
});

test("global search finds the project by code (Ctrl K)", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("searchbox", { name: /Search clients/ })).toBeFocused();
  await page.keyboard.type("HB-2026");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=HB-2026/);
  await expect(page.getByRole("link", { name: "Spring relaunch" })).toBeVisible();
});

test("archive hides the project from the list; restore brings it back", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("link", { name: "Spring relaunch" }).click();
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Archive project" }).click();
  await expect(page.getByText("Give a reason (at least 3 characters).")).toBeVisible();
  await page.getByLabel("Reason", { exact: true }).fill("Client paused the work");
  await page.getByRole("button", { name: "Archive project" }).click();
  await expect(page.getByText(/This project is archived/)).toBeVisible();

  await page.goto("/projects");
  await expect(page.getByRole("link", { name: "Spring relaunch" })).toHaveCount(0);
  await page.getByLabel("Show archived", { exact: true }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link", { name: "Spring relaunch" }).click();

  await page.getByLabel("Reason for restoring", { exact: true }).fill("Client is back");
  await page.getByRole("button", { name: "Restore project" }).click();
  const rail = page.getByRole("list", { name: "Workflow stages" });
  await expect(rail.locator('[aria-current="step"]')).toContainText("Ready to Deploy");
});

test("project list filters by stage and the dashboard counts it", async ({ page }) => {
  await expect(page.getByRole("list", { name: /live projects by current stage/ })).toContainText("Ready to Deploy");
  await page.goto("/projects?stage=enquiry");
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Spring relaunch" })).toHaveCount(0);
  await page.goto("/projects?stage=ready_to_deploy");
  await expect(page.getByRole("link", { name: "Spring relaunch" })).toBeVisible();
});

test("unknown or malformed record ids are 404s", async ({ page }) => {
  for (const path of ["/clients/not-a-uuid", "/projects/00000000-0000-4000-8000-000000000000", "/websites/x/edit"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
  }
});
