import { request, type APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures";

// App Tests stays current without a deploy (step 30). The token is set in uat/docker-compose.uat.yml.
const TOKEN = "uat-publish-token-not-for-production";
const WRITTEN = "2099-01-02T08:04:00.000Z";
const ledger = (updatedAt: string) => JSON.stringify({ version: 1, updatedAt, runs: [], items: {} });
const CODE_REPORT = "# Code review: UAT\n\n- **Run:** 2099-01-02 03:04\n- **Commit reviewed:** `abcdef1`\n\n## Medium\n\n### CR-999 — Published from the review machine\n- **Status:** Open (first seen 2099-01-02)\n";
const file = (name: string, text: string) => ({ name, text, written_at: WRITTEN });

test.describe("App Tests publishing", () => {
  let api: APIRequestContext;
  const post = (data: unknown, token = TOKEN) => api.post("/api/reports/publish", { data, headers: { Authorization: `Bearer ${token}` } });

  test.beforeAll(async ({ baseURL }) => { api = await request.newContext({ baseURL }); });
  test.afterAll(async () => { await api.dispose(); });

  test("only the token can publish, and a login can't", async () => {
    expect((await api.post("/api/reports/publish", { data: {} })).status()).toBe(401);
    expect((await post({}, "not-the-token")).status()).toBe(401);
    const login = await api.post("/api/reports/publish", { data: {}, headers: { Authorization: `Basic ${Buffer.from("uat:uat-sandbox-pass").toString("base64")}` } });
    expect(login.status()).toBe(401);
    expect((await api.get("/api/reports/publish")).status()).toBe(405);
  });

  test("the security report and bad files are refused, whole", async () => {
    const good = file("AGENT_LEDGER.json", ledger("2099-01-02T08:05:00.000Z"));
    for (const bad of [file("SECURITY_REVIEW.md", "# Security review: UAT\n"), file("CODE_REVIEW.md", "not a report"), file("../secrets.md", "x")]) {
      const res = await post({ files: [good, bad] });
      expect(res.status(), bad.name).toBe(400);
      expect((await res.json()).error.message).toContain("Nothing was published");
    }
    expect((await post({ files: [file("CODE_REVIEW.md", CODE_REPORT)] })).status(), "a set needs its ledger").toBe(400);
  });

  test("a published set reaches the page with no deploy, and an older one can't replace it", async ({ page }) => {
    const set = { files: [file("AGENT_LEDGER.json", ledger("2099-01-02T08:05:00.000Z")), file("CODE_REVIEW.md", CODE_REPORT), file("ux-mockups/UX-999.html", "<p>after</p>")] };
    const first = await post(set);
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ outcome: "stored", files: 3 });
    expect((await (await post(set)).json()).outcome).toBe("unchanged");

    await page.goto("/app-tests");
    await expect(page.getByText("reports the agents last published")).toBeVisible();
    await page.goto("/app-tests/code");
    await expect(page.getByText(/CR-999/)).toBeVisible();
    expect((await page.goto("/app-tests/security"))!.status()).toBe(404);
    const mockup = await page.goto("/app-tests/mockups/UX-999");
    expect(mockup!.status()).toBe(200);
    expect(mockup!.headers()["content-security-policy"]).toContain("sandbox");

    const older = await post({ files: [file("AGENT_LEDGER.json", ledger("2099-01-01T00:00:00.000Z")), file("CODE_REVIEW.md", CODE_REPORT.replace("CR-999", "CR-998"))] });
    expect(older.status()).toBe(409);
    await page.goto("/app-tests/code");
    await expect(page.getByText(/CR-999/)).toBeVisible();
  });
});
