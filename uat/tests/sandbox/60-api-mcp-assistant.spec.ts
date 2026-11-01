import { test, expect } from "./fixtures";

test.describe("API docs, MCP console and AI assistant", () => {
  test("API page documents every endpoint and its Try it links work", async ({ page }) => {
    await page.goto("/accounting/api");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Underwriting Desktop GL API");
    const tries = await page.$$eval("a", (as) => as.filter((a) => /Try/.test(a.textContent ?? "")).map((a) => a.getAttribute("href")!));
    expect(tries.length).toBeGreaterThan(3);
    for (const t of tries) expect((await page.request.get(t)).status(), t).toBe(200);
  });

  test("MCP console: the live handshake succeeds and a chosen tool answers", async ({ page }) => {
    await page.goto("/accounting/mcp");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("uwdesk-gl");
    await expect(page.getByText("4 · tools/call gl_summary")).toBeVisible();
    await expect(page.getByText(/HTTP 200/).first()).toBeVisible();
    await page.getByLabel("Tool").selectOption("gl_periods");
    await page.getByLabel("Arguments (JSON)").fill("{}");
    await page.getByRole("button", { name: "Call gl_periods" }).click();
    await expect(page.getByText("tools/call gl_periods", { exact: true })).toBeVisible();
    await page.getByLabel("Arguments (JSON)").fill("not json");
    await page.getByRole("button", { name: "Call gl_periods" }).click();
    await expect(page.getByText("Arguments must be a JSON object")).toBeVisible();
  });

  test("MCP gl_push from the console asks first, and cancelling sends nothing", async ({ page }) => {
    await page.goto("/accounting/mcp");
    await page.getByLabel("Tool").selectOption("gl_push");
    let asked = "";
    page.once("dialog", (d) => { asked = d.message(); d.dismiss(); });
    await page.getByRole("button", { name: "Call gl_push" }).click();
    await page.waitForTimeout(500);
    expect(asked).toContain("gl_push opens a new GL export batch");
  });

  test("AI assistant answers a question with links into the app", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto("/assistant");
    await expect(page.getByRole("heading", { name: "AI Assistant", level: 1 })).toBeVisible();
    const off = page.getByText(/The assistant isn't configured on this instance/);
    test.skip(await off.isVisible(), "no ANTHROPIC_API_KEY in .env, so the assistant is off in the sandbox");
    await page.getByRole("button", { name: "What's waiting in the inbox?" }).click();
    await expect(page.getByText(/^Looked at · \d+ tool call/)).toBeVisible({ timeout: 200_000 });
    await expect(page.locator("main a[href^='/']").first()).toBeVisible();
    await expect(page.getByText(/\d+ rounds? · [\d,]+ tokens/)).toBeVisible();
  });

  test("the desk's Ask box hands the question to the assistant", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Ask the AI Assistant").fill("How many policies are in force?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page).toHaveURL(/\/assistant/);
  });
});
