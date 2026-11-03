import fs from "node:fs";
import path from "node:path";
import { test, expect, idFrom } from "./fixtures";

// The limit an upload is told it has is the one it gets (CR-159). The sample is a fillable application, so it is
// read from its fields with no Claude call. A PDF ignores a comment after its end, which makes the size.
const SAMPLE = path.resolve(__dirname, "../../../samples/submissions/01-lone-star-electric/lone-star-electric-acord-application.pdf");
const paddedTo = (bytes: number) => {
  const pdf = fs.readFileSync(SAMPLE);
  return Buffer.concat([pdf, Buffer.from("\n%"), Buffer.alloc(bytes - pdf.length - 3, 0x20), Buffer.from("\n")]);
};
const MB = 1024 * 1024;

test.describe("upload size", () => {
  test("an upload near the limit reaches intake review whole", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto("/submissions");
    await page.getByText("Or upload documents yourself").click();
    await page.locator('input[name="files"]').setInputFiles({ name: "large-application.pdf", mimeType: "application/pdf", buffer: paddedTo(24 * MB) });
    await page.getByRole("button", { name: "Upload & extract" }).click();
    await page.waitForURL(/\/submissions\/[0-9a-f-]{36}$/, { timeout: 200_000 });
    expect(idFrom(page.url(), "submissions")).toBeTruthy();
    const link = page.locator('a[href*="/documents/"]');
    await expect(link).toHaveCount(1);
    const stored = await page.request.get((await link.getAttribute("href"))!);
    expect((await stored.body()).length).toBe(24 * MB);
  });

  test("a 30 MB upload gets the size message, and nothing is stored", async ({ page }) => {
    await page.goto("/submissions");
    await page.getByText("Or upload documents yourself").click();
    await page.locator('input[name="files"]').setInputFiles({ name: "too-large.pdf", mimeType: "application/pdf", buffer: paddedTo(30 * MB) });
    await page.getByRole("button", { name: "Upload & extract" }).click();
    await expect(page.getByText(/Uploads exceed 25 MB/)).toBeVisible();
    await expect(page).toHaveURL(/\/submissions$/);
  });
});
