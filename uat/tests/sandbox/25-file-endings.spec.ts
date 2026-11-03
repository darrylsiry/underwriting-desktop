import path from "node:path";
import { test, expect, idFrom } from "./fixtures";

// A file can end without a bind, and every step of it is undoable (UX-068, UX-058). Its own submission, so the flows around it don't care.
const APP = path.resolve(__dirname, "../../../samples/submissions/02-gulf-coast-roofing");
const accept = (page: import("@playwright/test").Page) => page.on("dialog", (d) => d.accept());

test.describe.serial("ending a file", () => {
  let id = "";

  test("decline from intake: it reads Declined, says why, and offers Reopen", async ({ page }) => {
    test.setTimeout(240_000);
    accept(page);
    await page.goto("/submissions");
    await page.getByText("Or upload documents yourself").click();
    const fs = await import("node:fs");
    const app = fs.readdirSync(APP).find((f) => f.includes("application"))!;
    await page.locator('input[name="files"]').setInputFiles(path.join(APP, app));
    await page.getByRole("button", { name: "Upload & extract" }).click();
    await page.waitForURL(/\/submissions\/[0-9a-f-]{36}$/, { timeout: 200_000 });
    id = idFrom(page.url(), "submissions");

    await page.getByText("Decline this file…").click();
    await page.getByLabel("Reason").selectOption("Outside appetite");
    await page.getByRole("button", { name: "Decline file" }).click();
    await expect(page.getByText(/Declined by .*: Outside appetite/)).toBeVisible();
    await expect(page.locator("main")).toContainText("Declined");
    await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
  });

  test("a declined file is off the desk, under its pill on Submissions, and its workbench says so", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(`a[href^="/submissions/${id}"]`)).toHaveCount(0);
    await page.goto("/submissions?stage=declined");
    await expect(page.locator(`a[href="/submissions/${id}"]`).first()).toBeVisible();
    await page.goto(`/submissions/${id}/workbench`);
    await expect(page.locator("main")).toContainText("Open its intake page");
  });

  test("reopen brings it back, and the address no longer repeats the message on reload", async ({ page }) => {
    accept(page);
    await page.goto(`/submissions/${id}`);
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(page.getByText(/reopened/).first()).toBeVisible();
    await expect(page.getByText("Decline this file…")).toBeVisible();
    await expect.poll(() => new URL(page.url()).search).toBe("");   // UX-073
  });
});
