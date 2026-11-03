import { test, expect, need, expectMessage } from "./fixtures";

test.describe.serial("accounting", () => {
  test("the bind booked a balanced new-business journal, not yet pushed", async ({ page }) => {
    const gl = need("policyNumber");
    await page.goto("/accounting?period=all");
    await expect(page.getByRole("heading", { name: "Accounting", level: 1 })).toBeVisible();
    const row = page.locator("tr, li, div").filter({ has: page.getByRole("link", { name: gl }) }).last();
    await expect(row).toContainText(/JE-\d{6}/);
    await expect(row).toContainText("not yet pushed");
    await expect(row.getByRole("link", { name: "UW action →" })).toBeVisible();
  });

  test("UW action → lands on the bind's audit events", async ({ page }) => {
    const gl = need("policyNumber");
    await page.goto("/accounting?period=all");
    const row = page.locator("tr, li, div").filter({ has: page.getByRole("link", { name: gl }) }).last();
    await row.getByRole("link", { name: "UW action →" }).click();
    await expect(page).toHaveURL(/\/audit\?.*correlation=/);
    await expect(page.getByText(/Showing the events of one action/)).toBeVisible();
  });

  test("every period and type filter renders", async ({ page }) => {
    for (const period of ["this_month", "last_month", "this_quarter", "last_quarter", "ytd", "last_12", "all"]) {
      await page.goto(`/accounting?period=${period}`);
      await expect(page.getByRole("heading", { name: "Accounting", level: 1 })).toBeVisible();
    }
    await page.goto("/accounting?period=custom&from=2026-01-01&to=2026-06-30&type=new_business");
    await expect(page.getByRole("heading", { name: "Accounting", level: 1 })).toBeVisible();
  });

  test("download without pushing leaves the lines unpushed (UX-061)", async ({ page }) => {
    await page.goto("/accounting?period=all");
    const before = await page.locator("body").innerText();
    const response = await page.request.get((await page.getByRole("link", { name: "CSV", exact: true }).getAttribute("href"))!);
    expect(response.status()).toBe(200);
    await page.reload();
    expect((await page.locator("body").innerText()).match(/not yet pushed/g)?.length).toBe(before.match(/not yet pushed/g)?.length);
  });

  test("push to the GL as CSV: it asks first, stamps the lines with a batch, and the file downloads", async ({ page }) => {
    await page.goto("/accounting?period=all");
    let asked = "";
    page.once("dialog", (d) => { asked = d.message(); void d.accept(); });
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "Push & download CSV" }).click();
    await expectMessage(page, /Pushed batch GLX-\d{8}-\d{3}/);
    expect(asked).toMatch(/^Push \d+ lines? as a new GL batch\? They will be marked pushed\.$/);
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    await page.goto("/accounting?period=all");
    const gl = need("policyNumber");
    await expect(page.locator("tr, li, div").filter({ has: page.getByRole("link", { name: gl }) }).last()).toContainText(/pushed · GLX-/);
  });
});

// Independent of each other: one failing must not hide the others.
test.describe("accounting exports", () => {
  test.beforeEach(({ page }) => { page.on("dialog", (d) => d.accept()); });   // a push that would stamp lines asks first (UX-061)
  test("pushing again says nothing new and downloads the same selection the page shows", async ({ page }) => {
    await page.goto("/accounting?period=all");
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "Push & download CSV" }).click();
    await expectMessage(page, /Nothing new to push/);
    const file = await download;
    // The page shows All periods; the file must be All periods too, not this month's lines.
    expect(file.url(), "download link for an All periods push").toMatch(/period=all|gl-subledger-all/);
    expect(file.suggestedFilename()).toMatch(/^gl-subledger-all/);
  });

  test("Export Excel downloads a workbook", async ({ page }) => {
    await page.goto("/accounting?period=all");
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "Push & download Excel" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test("Export JSON downloads a file and the user stays on Accounting", async ({ page }) => {
    await page.goto("/accounting?period=all");
    const download = page.waitForEvent("download", { timeout: 20_000 }).catch(() => null);
    await page.getByRole("button", { name: "Push & download JSON" }).click();
    const file = await download;
    expect(page.url(), "the browser left the app for the raw JSON").toContain("/accounting");
    expect(file, "no file was downloaded").not.toBeNull();
  });
});
