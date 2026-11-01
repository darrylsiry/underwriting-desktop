import { test, expect, expectMessage } from "./fixtures";

// Last on purpose: activating a version changes the rates every later rating uses.
test.describe.serial("rate tables", () => {
  const label = `uat.${Date.now().toString(36)}`;

  test("versions list shows the active version", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Rate versions" })).toBeVisible();
    await expect(page.getByText(/is active: every new rating uses it/)).toBeVisible();
  });

  test("create a draft copied from the active version", async ({ page }) => {
    await page.goto("/admin");
    await page.getByLabel("New label").fill(label);
    await page.getByLabel("Purpose").fill("UAT: exercise the rate admin");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expectMessage(page, "Draft created. Edit any variable, then activate.");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(label);
  });

  test("a duplicate label is refused", async ({ page }) => {
    await page.goto("/admin");
    await page.getByLabel("New label").fill(label);
    await page.getByLabel("Purpose").fill("UAT duplicate");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expectMessage(page, `A version labelled ${label} already exists`);
  });

  test("every rating-variable section opens", async ({ page }) => {
    await page.goto("/admin");
    await page.getByRole("link", { name: label, exact: true }).first().click();
    for (const s of ["classes", "territory", "ilf", "deductible", "residential_pct", "subcontracted_pct", "no_sub_coi", "height_ft", "parameters", "sl_tax"]) {
      const res = await page.goto(page.url().split("?")[0] + `?section=${s}`);
      expect(res!.status(), s).toBe(200);
      await expect(page.locator("form input.num").first()).toBeVisible();
    }
  });

  test("edit a class rate with a reason; a zero is refused and the typed values stay", async ({ page }) => {
    await page.goto("/admin");
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await page.goto(page.url().split("?")[0] + "?section=classes");
    const cell = page.locator("form input.num").first();
    await cell.evaluate((el) => el.removeAttribute("min"));
    await cell.fill("0");
    await page.getByLabel("Reason for change (goes in the audit trail)").fill("UAT: check validation");
    await page.getByRole("button", { name: "Save class base rates" }).click();
    await expect(page.getByText(/values must be greater than zero/)).toBeVisible();
    await expect(page.getByLabel("Reason for change (goes in the audit trail)")).toHaveValue("UAT: check validation");
    const old = Number(await page.locator("form input.num").first().getAttribute("value") ?? "1");
    await page.locator("form input.num").first().fill(String(Math.round((old || 20) * 1.05 * 100) / 100));
    await page.getByRole("button", { name: "Save class base rates" }).click();
    await expectMessage(page, /Saved 1 change/);
    await expect(page.getByText(/1 changed/).first()).toBeVisible();
  });

  test("activate the draft: the confirmation lists the difference", async ({ page }) => {
    await page.goto("/admin");
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await expect(page.getByText(new RegExp(`Activate ${label.replace(".", "\\.")} · 1 value differs`))).toBeVisible();
    await page.getByLabel("Reason", { exact: true }).fill("UAT: activation check");
    let asked = "";
    page.once("dialog", (d) => { asked = d.message(); d.accept(); });
    await page.locator("#activate-button").click();
    await expectMessage(page, "Activated. New ratings now use this version.");
    expect(asked).toContain("New ratings will use it immediately");
    await page.goto("/admin");
    await expect(page.getByText(new RegExp(`${label.replace(".", "\\.")} is active`))).toBeVisible();
  });
});
