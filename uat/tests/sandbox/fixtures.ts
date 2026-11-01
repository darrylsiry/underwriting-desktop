import { test as base, expect, type Page } from "@playwright/test";
import fs from "node:fs";

// The sandbox (writing) suite. Runs only against the local uwdesk-uat stack; playwright.config.ts
// refuses anything else. Specs share state through .work/sandbox-state.json because the flows
// build on each other (the submission picked up in 10 is quoted in 30 and bound in 40).

export const USER = process.env.UAT_USER ?? "uat";
export const PASS = process.env.UAT_PASS ?? "uat-sandbox-pass";
const STATE = ".work/sandbox-state.json";
const AUTH_STATE = ".work/sandbox-auth.json";

export function readState(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; }
}
export function saveState(patch: Record<string, string>) {
  fs.mkdirSync(".work", { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch }, null, 2));
}
export function need(key: string): string {
  const v = readState()[key];
  if (!v) base.skip(true, `needs ${key} from an earlier flow, which did not complete`);
  return v!;
}

export async function signIn(page: Page, user = USER, pass = PASS) {
  await page.goto("/signin");
  await page.getByLabel("User ID").fill(user);
  await page.getByLabel("Password").fill(pass);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as`)).toBeVisible();
}

/** Signed in through the real form once, then every test reuses the session cookie. */
export const test = base.extend<{ problems: string[] }>({
  storageState: async ({ browser, baseURL }, use) => {
    if (!fs.existsSync(AUTH_STATE)) {
      const ctx = await browser.newContext({ baseURL });
      const page = await ctx.newPage();
      await signIn(page);
      await ctx.storageState({ path: AUTH_STATE });
      await ctx.close();
    }
    await use(AUTH_STATE);
  },
  // Any page error or 5xx during a flow fails it, like a user seeing a broken page would.
  problems: [async ({ page }, use) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    page.on("response", (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
    await use(problems);
    expect(problems, "page errors or server errors during the flow").toEqual([]);
  }, { auto: true }],
});

export { expect };

/** Defaults for the fields intake needs before it can be accepted, used only where extraction left them blank. */
export const REQUIRED_DEFAULTS: Record<string, string> = {
  "applicant.name": "UAT Test Contracting LLC",
  "applicant.state": "TX",
  "operations.class_code": "92215",
  "operations.gross_receipts": "1500000",
  "operations.states": "TX",
  "policy.occurrence_limit": "1000000",
  "policy.aggregate_limit": "2000000",
};

export async function fillMissingRequired(page: Page): Promise<string[]> {
  const filled: string[] = [];
  for (const [path, value] of Object.entries(REQUIRED_DEFAULTS)) {
    const input = page.locator(`[id="${path}"]`);
    if (!(await input.count())) continue;
    if (!(await input.inputValue()).trim()) { await input.fill(value); filled.push(path); }
  }
  return filled;
}

/** The banner a server action leaves after it redirects (?msg=) or the alert it returns. */
export async function expectMessage(page: Page, text: string | RegExp) {
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 60_000 });
}

/** Clear every open referral on the workbench with a written reason. Returns how many. */
export async function clearReferrals(page: Page): Promise<number> {
  let n = 0;
  for (let i = 0; i < 15; i++) {
    const clear = page.getByRole("button", { name: "Clear", exact: true });
    if (!(await clear.count())) break;
    const note = page.getByLabel(/^Why ".*" is acceptable$/).first();
    if (!(await note.isVisible())) break;
    await note.fill("UAT: acceptable within delegated authority, mitigation on file");
    await page.getByRole("button", { name: "Clear", exact: true }).first().click();
    await expectMessage(page, "Referral cleared");
    n++;
  }
  return n;
}

/** The id in a URL like /submissions/<id>/... or /quotes/<id>. */
export function idFrom(url: string, after: string): string {
  const m = new URL(url, "http://x").pathname.match(new RegExp(`/${after}/([^/?#]+)`));
  if (!m) throw new Error(`no ${after} id in ${url}`);
  return m[1];
}

/** GET a file the way the browser would and check it is a real one. */
export async function expectPdf(page: Page, href: string) {
  const res = await page.request.get(href);
  expect(res.status(), href).toBe(200);
  expect(res.headers()["content-type"], href).toContain("pdf");
  expect((await res.body()).subarray(0, 4).toString(), href).toBe("%PDF");
}
