import { test, expect, need, saveState, expectMessage, clearReferrals, expectPdf, idFrom } from "./fixtures";

test.describe.serial("workbench, quote and bind", () => {
  test("open the workbench: not rated until Save & rate", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}/workbench`);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save & rate" })).toBeVisible();
  });

  test("a bad input comes back with the error under the field and the other edits kept", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}/workbench`);
    const res = page.locator('input[name="residential_pct"]');
    await res.evaluate((el) => { el.removeAttribute("max"); el.removeAttribute("pattern"); el.setAttribute("type", "text"); });
    await res.fill("150");
    await page.locator('input[name="schedule.management.pct"]').fill("-5");
    await page.locator('input[name="schedule.management.rationale"]').fill("Owner has 20 years in the trade (UAT)");
    await page.getByRole("button", { name: "Save & rate" }).click();
    await expect(page.getByText(/must be 0–100/).first()).toBeVisible();
    await expect(page.locator('input[name="schedule.management.rationale"]')).toHaveValue("Owner has 20 years in the trade (UAT)");
  });

  test("Save & rate prices the file, with a schedule credit", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}/workbench`);
    await page.locator('input[name="schedule.management.pct"]').fill("-5");
    await page.locator('input[name="schedule.management.rationale"]').fill("Owner has 20 years in the trade (UAT)");
    await page.getByRole("button", { name: "Save & rate" }).click();
    await expectMessage(page, /Rated: \$[\d,]+ premium, \$[\d,.]+ total/);
    await expect(page.getByText(/Schedule rating · total -5%/)).toBeVisible();
  });

  test("a credit with no reason is refused", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}/workbench`);
    await page.locator('input[name="schedule.safety.pct"]').fill("3");
    await page.locator('input[name="schedule.safety.rationale"]').fill("");
    await page.getByRole("button", { name: "Save & rate" }).click();
    await expect(page.getByText(/write a reason for the debit/).first()).toBeVisible();
  });

  test("clear every referral with a note, then the file is ready to quote", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}/workbench`);
    const n = await clearReferrals(page);
    test.info().annotations.push({ type: "referrals cleared", description: String(n) });
    await expect(page.getByRole("button", { name: /^Issue quote · \$/ })).toBeVisible();
  });

  test("issue the quote: a numbered quote with a PDF", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}/workbench`);
    await page.getByRole("button", { name: /^Issue quote · \$/ }).click();
    await expectMessage(page, /Quote Q-\d{4}-\d{4} v1 issued: \$[\d,.]+ total/);
    const link = page.getByRole("link", { name: /^Q-\d{4}-\d{4} v1$/ }).first();
    const qid = idFrom((await link.getAttribute("href"))!, "quotes");
    saveState({ quoteV1: qid });
    await expectPdf(page, `/quotes/${qid}/pdf`);
  });

  test("change the terms: the card names the drift, and a revised v2 supersedes v1", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}/workbench`);
    const ded = page.locator('input[name="deductible"]');
    const current = (await ded.inputValue()).replace(/\D/g, "");
    await ded.fill(current === "10000" ? "5000" : "10000");
    await expect(page.getByText("Save & rate your changes first (or reload the page to discard them).").first()).toBeVisible();
    await page.getByRole("button", { name: "Save & rate" }).click();
    await expectMessage(page, /Rated:/);
    await clearReferrals(page);
    await expect(page.getByText(/Worksheet differs from Q-\d{4}-\d{4} v1/).first()).toBeVisible();
    await page.getByRole("button", { name: /^Issue revised quote \(v2\)/ }).click();
    await expectMessage(page, /Quote Q-\d{4}-\d{4} v2 issued/);
    const v2 = idFrom((await page.getByRole("link", { name: /^Q-\d{4}-\d{4} v2$/ }).first().getAttribute("href"))!, "quotes");
    saveState({ quoteV2: v2 });
    await page.goto(`/quotes/${need("quoteV1")}`);
    await expect(page.getByRole("link", { name: /^Superseded by v2/ })).toBeVisible();
  });

  test("the quote page offers Bind on the workbench", async ({ page }) => {
    await page.goto(`/quotes/${need("quoteV2")}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("v2");
    await expect(page.getByRole("link", { name: "Bind on the workbench →" })).toBeVisible();
    for (const s of ["Terms", "Premium", "Subjectivities"]) await expect(page.getByText(s, { exact: true }).first()).toBeVisible();
  });

  test("cancelling the bind confirmation does nothing", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}/workbench`);
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: /^Bind · \$/ }).click();
    await page.waitForTimeout(1500);
    await expect(page.getByText(/Bound: policy/)).toHaveCount(0);
  });

  test("bind: policy and binder numbers, PDFs, worksheet frozen", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}/workbench`);
    const boxes = page.locator('input[name="received"]');
    if (await boxes.count()) await boxes.first().check();
    let confirmText = "";
    page.once("dialog", (d) => { confirmText = d.message(); d.accept(); });
    await page.getByRole("button", { name: /^Bind · \$/ }).click();
    await expectMessage(page, /Bound: policy GL-\d{2}-\d{5}, binder BND-\d{2}-\d{5}/);
    expect(confirmText).toContain("books the premium to the GL");
    await expect(page.getByText("Worksheet frozen at bind")).toBeVisible();
    const pol = page.getByRole("link", { name: /^GL-\d{2}-\d{5}$/ }).first();
    const pid = idFrom((await pol.getAttribute("href"))!, "policies");
    saveState({ policy: pid, policyNumber: (await pol.textContent())!.trim() });
    await expectPdf(page, `/policies/${pid}/binder`);
    await expectPdf(page, `/policies/${pid}/policy`);
  });

  test("the policy page shows coverage, premium, subjectivities and every document", async ({ page }) => {
    const pid = need("policy");
    await page.goto(`/policies/${pid}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(need("policyNumber"));
    for (const s of ["Coverage", "Premium"]) await expect(page.getByText(s, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/^Subjectivities · /)).toBeVisible();
    const docs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")!).filter((h) => /\/(pdf|memo|binder|policy)$|\/documents\//.test(h)));
    expect(docs.length).toBeGreaterThan(2);
    for (const d of docs) expect((await page.request.get(d)).status(), d).toBe(200);
    await page.goto("/policies");
    await expect(page.getByRole("link", { name: need("policyNumber") })).toBeVisible();
    await page.goto("/quotes");
    await expect(page.locator("body")).toContainText("bound");
  });

  test("the customer record lists the policy, quotes and submission", async ({ page }) => {
    await page.goto(`/submissions/${need("inboxSub")}`);
    await page.getByRole("link", { name: "customer record" }).click();
    await expect(page.getByText("Written premium")).toBeVisible();
    await expect(page.getByRole("link", { name: need("policyNumber") })).toBeVisible();
  });

  test("a second file (the uploaded one) is rated and quoted, and left unbound", async ({ page }) => {
    const sub = need("uploadSub");
    await page.goto(`/submissions/${sub}/workbench`);
    await page.getByRole("button", { name: "Save & rate" }).click();
    await expectMessage(page, /Rated:/);
    await clearReferrals(page);
    await page.getByRole("button", { name: /^Issue quote · \$/ }).click();
    await expectMessage(page, /Quote Q-\d{4}-\d{4} v1 issued/);
    await expect(page.getByRole("button", { name: /^Bind · \$/ })).toBeVisible();
  });
});
