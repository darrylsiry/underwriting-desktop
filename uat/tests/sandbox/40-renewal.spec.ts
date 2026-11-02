import { test, expect, need, saveState, expectMessage, clearReferrals, expectPdf, idFrom, signIn } from "./fixtures";

test.describe.serial("renewal", () => {
  test("cancelling Start renewal does nothing", async ({ page }) => {
    await page.goto(`/policies/${need("policy")}`);
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: "Start renewal" }).click();
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(new RegExp(`/policies/${need("policy")}$`));
  });

  test("start the renewal of the policy just bound: a renewal workbench from the expiring terms", async ({ page }) => {
    await page.goto(`/policies/${need("policy")}`);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Start renewal" }).click();
    await expectMessage(page, /Renewal started from the expiring policy's terms/);
    saveState({ renewalSub: idFrom(page.url(), "submissions") });
    await expect(page.getByText(/^Renewal of /).first()).toBeVisible();
    await expect(page.getByText(/^expiring: /).first()).toBeVisible();
  });

  test("re-rate the renewal and open Expiring vs renewing", async ({ page }) => {
    const sub = need("renewalSub");
    await page.goto(`/submissions/${sub}/workbench`);
    await page.getByRole("button", { name: "Save & rate" }).click();
    await expectMessage(page, /Rated:/);
    await clearReferrals(page);
    await page.getByRole("link", { name: "Expiring vs renewing →" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/submissions/${sub}/renewal`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Renewal ·");
    for (const s of [/^Rate comparison/, /^Terms · expiring vs renewing/, /^Rating factors · /]) await expect(page.getByText(s).first()).toBeVisible();
  });

  test("Re-rate on the comparison page", async ({ page }) => {
    await page.goto(`/submissions/${need("renewalSub")}/renewal`);
    await page.getByRole("button", { name: "Re-rate" }).click();
    await expectMessage(page, /Re-rated on rates [\w.]+: \$[\d,.]+ total/);
  });

  test("issue the renewal quote with its memo to the customer", async ({ page }) => {
    await page.goto(`/submissions/${need("renewalSub")}/renewal`);
    await page.getByRole("button", { name: /^Issue renewal quote · \$/ }).click();
    await expectMessage(page, /Renewal quote Q-\d{4}-\d{4} v1 issued with its memo/);
    const q = page.getByRole("link", { name: /^Q-\d{4}-\d{4} v1$/ }).first();
    const qid = idFrom((await q.getAttribute("href"))!, "quotes");
    saveState({ renewalQuote: qid });
    await expectPdf(page, `/quotes/${qid}/pdf`);
    await expectPdf(page, `/quotes/${qid}/memo`);
  });

  test("bind the renewal from the comparison page's link; the expiring policy shows renewed", async ({ page }) => {
    await page.goto(`/submissions/${need("renewalSub")}/renewal`);
    await page.getByRole("link", { name: /^Bind Q-\d{4}-\d{4} v1 on the workbench →/ }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /^Bind · \$/ }).click();
    await expectMessage(page, /Bound: policy GL-\d{2}-\d{5}/);
    await page.goto(`/policies/${need("policy")}`);
    await expect(page.getByText(/^Renewal · renewed/)).toBeVisible();
    await expect(page.getByText(/Renewed as GL-/).first()).toBeVisible();
  });

  test("a prior-system policy renews too, from its underwriter's book", async ({ browser, baseURL }) => {
    // The book is per underwriter: sign in as one who owns prior-system policies (a sandbox-only login).
    // Signed out first: a signed-in visitor to /signin goes straight on to the desk (CR-099).
    const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await signIn(page, "underwriter2", "uat-sandbox-pass-uw2");
    await page.goto("/book?due=120");
    const link = page.locator('a[href^="/policies/book/"]').first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByText("prior system").first()).toBeVisible();
    await expect(page.getByText(/Loss history · 5 years/)).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Start renewal" }).click();
    await expectMessage(page, /Renewal started from the expiring policy's terms/);
    await expect(page.getByText(/^expiring: /).first()).toBeVisible();
    await ctx.close();
  });
});
