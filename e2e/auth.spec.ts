import { expect, test } from "@playwright/test";

// One ordered journey: the app starts with no users (global setup resets the DB).
test.describe.configure({ mode: "serial" });

const ADMIN = {
  name: "E2E Operator",
  email: "e2e-operator@example.test",
  password: "an end-to-end test passphrase",
};

test("health reports the database and migrations without auth", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ status: "ok", database: { reachable: true }, migrations: { pending: [] } });
  expect(JSON.stringify(body)).not.toMatch(/postgres:\/\//);
});

test("before setup, every page redirects to /setup", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.goto("/login");
  await expect(page).toHaveURL(/\/setup$/);
});

test("setup validates input, then creates the admin", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Create the admin account" })).toBeVisible();

  await page.getByLabel("Your name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill("too short");
  await page.getByLabel("Confirm password").fill("too short");
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByLabel("Confirm password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();

  await expect(page).toHaveURL(/\/login\?setup=done$/);
  await expect(page.getByText("Admin account created. Sign in to continue.")).toBeVisible();
});

test("setup is a 404 once an admin exists", async ({ page }) => {
  const response = await page.goto("/setup");
  expect(response?.status()).toBe(404);
});

test("unauthenticated visitors are redirected to /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("wrong password shows a generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill("not the right passphrase");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("login → shell renders → logout", async ({ page, context }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: `Welcome, ${ADMIN.name}` })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Dashboard");

  const cookie = (await context.cookies()).find((c) => c.name === "ss_session");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: true, path: "/" });

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("logout refuses cross-origin POSTs", async ({ request }) => {
  const response = await request.post("/logout", {
    headers: { origin: "http://evil.test" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});

test("security headers are present", async ({ request }) => {
  const response = await request.get("/login", { maxRedirects: 0 });
  const headers = response.headers();
  expect(headers["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(headers["content-security-policy"]).not.toContain("unsafe-eval");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("same-origin");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("pages hydrate with no CSP violations or console errors", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto("/login");
  // Next.js hydrated: client-side navigation state is present on window.
  await expect.poll(() => page.evaluate(() => "next" in window)).toBe(true);
  expect(problems).toEqual([]);
});

test("keyboard: skip link reaches main content", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
});
