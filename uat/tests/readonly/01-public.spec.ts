import { test, expect } from "../guard";

// What anyone on the internet sees, with no login. Tagged @public: runs on production even when
// no UAT login is configured.
test.describe("signed out @public", () => {
  test.use({ extraHTTPHeaders: {} });

  test("liveness endpoint answers", async ({ api }) => {
    const res = await api.get("/api/live", { headers: { Authorization: "" } });
    expect(res.status()).toBe(200);
  });

  test("sign-in page shows the form and does not submit it", async ({ page }) => {
    await page.goto("/signin");
    await expect(page.getByLabel("User ID")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("a protected page sends a signed-out visitor to sign in and remembers where they were going", async ({ page }) => {
    await page.goto("/policies");
    await expect(page).toHaveURL(/\/signin\?next=%2Fpolicies/);
  });

  test("the API refuses a caller with no login, with a JSON error and a Basic challenge", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const res = await anon.get("/api/gl");
    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toMatch(/Basic/);
    expect((await res.json()).error.code).toBe("unauthorized");
    await anon.dispose();
  });

  test("a wrong Basic password is refused", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: "Basic " + Buffer.from("uat-nobody:wrong").toString("base64") } });
    expect((await anon.get("/api/gl/accounts")).status()).toBe(401);
    await anon.dispose();
  });
});
