import path from "node:path";
import { test, expect, saveState, need, fillMissingRequired, expectMessage, idFrom, expectPdf } from "./fixtures";

const SAMPLES = path.resolve(__dirname, "../../../samples/submissions");

test.describe.serial("intake", () => {
  test("pick up a broker submission from the inbox: the extraction console runs and opens intake review", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto("/submissions");
    await expect(page.getByRole("heading", { name: "Submissions", level: 1 })).toBeVisible();
    await expect(page.getByText(/^Inbox · \d+ new/)).toBeVisible();
    // The fillable ACORD from Lone Star Electric when it is still waiting (fast, deterministic), else the first one.
    const preferred = page.locator("li, tr, div").filter({ hasText: "01-lone-star-electric" }).filter({ has: page.getByRole("button", { name: "Extract →" }) }).last();
    const button = (await preferred.count()) ? preferred.getByRole("button", { name: "Extract →" }) : page.getByRole("button", { name: "Extract →" }).first();
    await button.click();
    const dialog = page.getByRole("dialog", { name: /^Ingesting / });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("from the broker drop folder");
    await page.waitForURL(/\/submissions\/[0-9a-f-]{36}$/, { timeout: 200_000 });
    const sub = idFrom(page.url(), "submissions");
    saveState({ inboxSub: sub });
    await expect(page.locator("h1")).not.toHaveText("");
    await expect(page.getByText(/SUB-\d{4}/).first()).toBeVisible();
  });

  test("the picked-up submission is on the Received list, not in the inbox", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto("/submissions");
    await expect(page.locator(`a[href="/submissions/${sub}"]`).first()).toBeVisible();
  });

  test("correct a field, save, then accept intake", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}`);
    await fillMissingRequired(page);
    await page.locator('[id="producer.phone"]').fill("(512) 555-0199");
    await page.getByRole("button", { name: "Save corrections" }).click();
    await expectMessage(page, /Saved \d+ corrections?/);
    await page.getByRole("button", { name: "Save & accept intake" }).click();
    await expectMessage(page, "Intake accepted. The submission is ready for underwriting.");
    await expect(page.getByRole("link", { name: "Open underwriting workbench →" })).toBeVisible();
    await expect(page.getByRole("link", { name: "customer record" })).toBeVisible();
  });

  test("source documents open as files", async ({ page }) => {
    const sub = need("inboxSub");
    await page.goto(`/submissions/${sub}`);
    const docs = await page.$$eval(`a[href*="/submissions/${sub}/documents/"]`, (as) => as.map((a) => a.getAttribute("href")!));
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) if (/\.pdf/i.test(d) || true) {
      const res = await page.request.get(d);
      expect(res.status(), d).toBe(200);
      expect((await res.body()).length, d).toBeGreaterThan(100);
    }
  });

  test("upload documents yourself: two files become one submission", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto("/submissions");
    await page.getByText("Or upload documents yourself").click();
    await page.locator('input[name="files"]').setInputFiles([
      path.join(SAMPLES, "06-empire-builders-gc/empire-builders-gc-acord-application.pdf"),
      path.join(SAMPLES, "06-empire-builders-gc/empire-builders-gc-supplemental-questionnaire.pdf"),
    ]);
    await page.getByRole("button", { name: "Upload & extract" }).click();
    await page.waitForURL(/\/submissions\/[0-9a-f-]{36}$/, { timeout: 200_000 });
    saveState({ uploadSub: idFrom(page.url(), "submissions") });
    await expect(page.locator('a[href*="/documents/"]')).toHaveCount(2);
  });

  test("accepting without a named insured is refused, and the typed values stay", async ({ page }) => {
    const sub = need("uploadSub");
    await page.goto(`/submissions/${sub}`);
    await fillMissingRequired(page);
    await page.locator('[id="applicant.name"]').fill("");
    await page.locator('[id="applicant.city"]').fill("UAT City");
    await page.locator('[id="applicant.name"]').evaluate((el) => el.removeAttribute("required"));
    await page.getByRole("button", { name: "Save & accept intake" }).click();
    await expect(page.getByRole("alert").first()).toContainText(/named insured|Fill in/);
    await expect(page.locator('[id="applicant.city"]')).toHaveValue("UAT City");
    // Put it right and accept, so later flows have a second accepted file.
    await page.locator('[id="applicant.name"]').fill("Empire Builders GC (UAT)");
    await page.getByRole("button", { name: "Save & accept intake" }).click();
    await expectMessage(page, /Intake accepted/);
  });

  test("an empty upload is refused", async ({ page }) => {
    await page.goto("/submissions");
    await page.getByText("Or upload documents yourself").click();
    await page.locator('input[name="files"]').evaluate((el) => el.removeAttribute("required"));
    await page.getByRole("button", { name: "Upload & extract" }).click();
    await expect(page.getByText("Choose at least one document")).toBeVisible();
  });

  test("stage filters on the Received list", async ({ page }) => {
    for (const stage of ["review", "unrated", "referred", "ready", "quoted", "bound"]) {
      await page.goto(`/submissions?stage=${stage}`);
      await expect(page.getByRole("heading", { name: "Submissions", level: 1 })).toBeVisible();
    }
    void expectPdf;
  });
});
