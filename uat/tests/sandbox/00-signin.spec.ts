import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { USER, PASS, signIn } from "./fixtures";

// Signing in and out through the real pages (fresh browser, no saved session).
test.beforeAll(() => { fs.rmSync(".work/sandbox-auth.json", { force: true }); fs.rmSync(".work/sandbox-state.json", { force: true }); });

test("a wrong password is refused with a message and keeps the user ID", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("User ID").fill(USER);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That user ID or password isn't right.")).toBeVisible();
  await expect(page.getByLabel("User ID")).toHaveValue(USER);
});

test("signing in returns the user to the page they asked for", async ({ page }) => {
  await page.goto("/quotes");
  await expect(page).toHaveURL(/\/signin\?next=%2Fquotes/);
  await page.getByLabel("User ID").fill(USER);
  await page.getByLabel("Password").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/quotes$/);
  await expect(page.getByText(`Signed in as`)).toContainText(USER);
});

test("sign out from the header ends the session; GET /signout only asks", async ({ page }) => {
  await signIn(page);
  await page.goto("/signout");
  await expect(page.getByRole("heading", { name: "Sign out of Underwriting Desktop?" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("Signed in as")).toBeVisible();   // the GET changed nothing
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin/);
  await page.goto("/policies");
  await expect(page).toHaveURL(/\/signin/);
});

test("the sign-in shows up in Admin → Sign-ins, failures included", async ({ page }) => {
  await signIn(page);
  await page.goto("/audit/logins");
  await expect(page.locator("body")).toContainText(USER);
  await expect(page.locator("body")).toContainText(/fail/i);
});
