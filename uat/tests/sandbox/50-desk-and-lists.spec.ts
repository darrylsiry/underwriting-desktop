import { test, expect, need, USER } from "./fixtures";

test.describe("desk, lists, search and audit", () => {
  test("the desk: KPI tiles, next-up tasks, renewals, system status", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${USER}'s desk`);
    for (const t of ["In-force premium", "Renewals · 90 days", "Quotes out"]) await expect(page.getByText(t).first()).toBeVisible();
    await expect(page.getByText(/^Next up · \d+/)).toBeVisible();
    await expect(page.getByText("System status").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/\bdown\b/);
  });

  test("every KPI tile opens its list", async ({ page }) => {
    await page.goto("/");
    const tiles = await page.$$eval("a[title^='Open: ']", (as) => as.map((a) => a.getAttribute("href")!));
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    for (const href of tiles) {
      const res = await page.goto(href);
      expect(res!.status(), href).toBeLessThan(400);
      await expect(page.locator("h1")).not.toHaveText("");
    }
  });

  test("the book and its filters", async ({ page }) => {
    for (const [url, h1] of [["/book", "In-force book"], ["/book?due=90", "Renewals due within 90 days"], ["/book?due=120", "Renewals due within 120 days"], ["/book?view=losses", "Book loss ratio (incurred)"]]) {
      await page.goto(url);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1);
    }
  });

  test("header search: an exact policy number goes straight to the policy; a name lists results", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Search", { exact: true }).fill(need("policyNumber"));
    await page.getByLabel("Search", { exact: true }).press("Enter");
    await expect(page).toHaveURL(new RegExp(`/policies/${need("policy")}`));
    await page.goto("/search?q=roof");
    await expect(page.getByText(/\d+ results? for [“"]roof[”"]/)).toBeVisible();
    await page.goto("/search?q=r");
    await expect(page.getByText("Type at least two characters.")).toBeVisible();
    await page.goto("/search?q=zzzz-no-such-thing");
    await expect(page.getByText(/Nothing found/)).toBeVisible();
  });

  test("quotes and policies filters", async ({ page }) => {
    await page.goto(`/quotes?status=issued&live=1&underwriter=${USER}`);
    await expect(page.getByText(/Quotes out: issued, still valid and not yet bound or superseded/)).toBeVisible();
    for (const s of ["superseded", "bound"]) { await page.goto(`/quotes?status=${s}`); await expect(page.getByRole("heading", { name: "Quotes", level: 1 })).toBeVisible(); }
    await page.goto(`/policies?underwriter=${USER}&new_business=1`);
    await expect(page.getByRole("link", { name: need("policyNumber") })).toBeVisible();
  });

  test("customers list opens a customer", async ({ page }) => {
    await page.goto("/insureds");
    await page.locator('a[href^="/insureds/"]').first().click();
    await expect(page.getByText("Written premium")).toBeVisible();
  });

  test("audit trail: filters, date range, case history", async ({ page }) => {
    await page.goto("/audit");
    await expect(page.getByRole("heading", { name: "Audit trail", level: 1 })).toBeVisible();
    await page.getByLabel("Source").selectOption({ label: "UW Desktop" });
    await page.getByLabel("From", { exact: true }).fill("2026-01-01");
    await page.getByLabel("To", { exact: true }).fill("2026-12-31");
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page).toHaveURL(/source=desktop/);
    await expect(page.getByText(/^Showing \d+ of \d+ loaded events/)).toBeVisible();
    await page.goto("/audit?q=bound");
    await expect(page.getByText(/^Showing \d+ of/)).toBeVisible();
    await page.goto(`/audit?submission=${need("inboxSub")}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Case history ·");
    await expect(page.locator("body")).toContainText(/bound|Bound/);
  });

  test("audit paging: Older → and ← Newer when the newest 500 are shown", async ({ page }) => {
    await page.goto("/audit");
    const older = page.getByRole("link", { name: "Older →" });
    test.skip(!(await older.count()), "fewer than 500 desk events in this sandbox, so there is no second page");
    await older.click();
    await expect(page.getByText(/^Older than /)).toBeVisible();
    await page.getByRole("link", { name: "← Newer" }).click();
  });

  test("sign-ins report: windows and downloads", async ({ page }) => {
    await page.goto("/audit/logins");
    await expect(page.getByRole("heading", { name: "Sign-ins", level: 1 })).toBeVisible();
    for (const h of ["48h", "168h", "24h"]) { await page.getByRole("link", { name: h, exact: true }).click(); await expect(page).toHaveURL(new RegExp(`hours=${parseInt(h)}`)); }
    for (const name of ["Markdown", "CSV (every attempt)", "JSON"]) {
      const href = await page.getByRole("link", { name, exact: true }).getAttribute("href");
      expect((await page.request.get(href!)).status(), name).toBe(200);
    }
  });

  test("a junk address shows the styled not-found page", async ({ page }) => {
    await page.goto("/quotes/not-a-real-quote");
    await expect(page.getByRole("heading", { name: "There's nothing at this address" })).toBeVisible();
  });
});
