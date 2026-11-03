import { test, expect, type Blocked } from "../guard";
import type { Page } from "@playwright/test";

/**
 * Dry runs: click the real write buttons, as a user would, and prove two things: the button is
 * wired to send its request (the guard catches it), and nothing reached the server (the page
 * reads the same after a reload). On production this is how write functions are checked without
 * writing; their full effect is tested in the sandbox suite.
 */
async function caught(blocked: Blocked[], before: number, pattern: RegExp, page: Page) {
  await expect.poll(() => blocked.slice(before).some((b) => pattern.test(b.url)), { timeout: 15_000, message: `a write to ${pattern} was sent and stopped` }).toBe(true);
  void page;
}

/** A submission that already has a rating, so opening its workbench writes nothing (see 03-crawl). */
async function workbenchAt(page: Page, stage: string): Promise<string | null> {
  await page.goto(`/submissions?stage=${stage}`);
  const hrefs = await page.$$eval("a[href^='/submissions/']", (as) => as.map((a) => a.getAttribute("href") ?? ""));
  const id = hrefs.map((h) => h.match(/^\/submissions\/([0-9a-f-]{36})(\/workbench)?$/)?.[1]).find(Boolean);
  return id ? `/submissions/${id}/workbench` : null;
}

test.describe("write buttons are wired, and the guard stops them", () => {
  test("Save & rate on a quoted workbench", async ({ page, blocked }) => {
    const wb = (await workbenchAt(page, "quoted")) ?? (await workbenchAt(page, "ready")) ?? (await workbenchAt(page, "referred"));
    test.skip(!wb, "no rated, unbound submission to try");
    await page.goto(wb!);
    const before = await page.locator("main").innerText();
    const n = blocked.length;
    await page.getByRole("button", { name: "Save & rate" }).click();
    await caught(blocked, n, /\/workbench/, page);
    expect(blocked.at(-1)!.action, "sent as a server action").toBeTruthy();
    await page.reload();
    expect(await page.locator("main").innerText()).toBe(before);
  });

  test("Bind asks for confirmation, then its request is stopped", async ({ page, blocked }) => {
    const wb = await workbenchAt(page, "quoted");
    test.skip(!wb, "no quoted submission to try");
    await page.goto(wb!);
    const bind = page.getByRole("button", { name: /^Bind (v\d+ as issued )?· \$/ });
    test.skip(!(await bind.count()), "this quote has no Bind button (expired, superseded or blocked)");
    let asked = "";
    page.once("dialog", (d) => { asked = d.message(); d.accept(); });
    const n = blocked.length;
    await bind.click();
    expect(asked).toMatch(/books the premium to the GL/);
    await caught(blocked, n, /\/workbench/, page);
    await page.reload();
    await expect(page.getByText("Worksheet frozen at bind")).toHaveCount(0);
  });

  test("Extract from the inbox", async ({ page, blocked }) => {
    await page.goto("/submissions");
    const extract = page.getByRole("button", { name: "Extract →" }).first();
    test.skip(!(await extract.count()), "the inbox is empty");
    const n = blocked.length;
    await extract.click();
    await caught(blocked, n, /\/submissions\/inbox\/.+\/extract$/, page);
    await expect(page.getByRole("dialog", { name: /^Ingesting / })).toBeVisible();
  });

  test("Push to the GL", async ({ page, blocked }) => {
    await page.goto("/accounting?period=all");
    const btn = page.getByRole("button", { name: "Push & download CSV" });
    test.skip(await btn.isDisabled(), "nothing booked to push");
    const n = blocked.length;
    await btn.click();
    await caught(blocked, n, /\/accounting/, page);
    await page.goto("/accounting?period=all");
    await expect(page.getByText(/Pushed batch GLX-/)).toHaveCount(0);
  });

  test("Create a rate-table draft", async ({ page, blocked }) => {
    await page.goto("/admin");
    await page.getByLabel("New label").fill("uat-dry-run");
    await page.getByLabel("Purpose").fill("UAT dry run, must never be created");
    const n = blocked.length;
    await page.getByRole("button", { name: "Create draft" }).click();
    await caught(blocked, n, /\/admin\/versions$/, page);
    await page.waitForLoadState("load").catch(() => {});   // a stopped form post leaves the browser on its error page
    await page.waitForTimeout(500);
    await page.goto("/admin");
    await expect(page.getByRole("link", { name: "uat-dry-run" })).toHaveCount(0);
  });

  test("Sign out (the session is untouched)", async ({ page, blocked }) => {
    await page.goto("/signout");
    const n = blocked.length;
    await page.getByRole("button", { name: "Sign out" }).click();
    await caught(blocked, n, /\/signout$/, page);
    await page.waitForTimeout(500);
  });
});

test.describe("read-only functions that use POST", () => {
  test("MCP console runs its live handshake", async ({ page }) => {
    await page.goto("/accounting/mcp");
    await expect(page.getByText("4 · tools/call gl_summary")).toBeVisible();
    await expect(page.getByText(/HTTP 200/).first()).toBeVisible();
  });

  test("MCP console refuses gl_push before sending (cancelled at the confirmation)", async ({ page, blocked }) => {
    await page.goto("/accounting/mcp");
    await page.getByLabel("Tool").selectOption("gl_push");
    page.once("dialog", (d) => d.dismiss());
    const n = blocked.length;
    await page.getByRole("button", { name: "Call gl_push" }).click();
    await page.waitForTimeout(1000);
    expect(blocked.length).toBe(n);
  });

  test("AI assistant answers a question", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto("/assistant");
    test.skip(await page.getByText(/The assistant isn't configured on this instance/).isVisible(), "assistant not configured on this instance");
    await page.getByRole("button", { name: "Which renewals are due in the next 30 days?" }).click();
    await expect(page.getByText(/^Looked at · \d+ tool call/)).toBeVisible({ timeout: 200_000 });
    await expect(page.getByText(/\d+ rounds? · [\d,]+ tokens/)).toBeVisible();
  });

  test("search", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Search", { exact: true }).fill("roof");
    await page.getByLabel("Search", { exact: true }).press("Enter");
    await expect(page.getByText(/\d+ results? for [“"]roof[”"]|Nothing found/)).toBeVisible();
  });
});
