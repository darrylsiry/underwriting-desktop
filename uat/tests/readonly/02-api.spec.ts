import { test, expect, USER } from "../guard";

// The GL REST API, the sign-in report API and the MCP server, as another system would call them.
test.describe("GL API", () => {
  test("front door names the caller and lists every endpoint", async ({ api }) => {
    const res = await api.get("/api/gl");
    expect(res.status()).toBe(200);
    const j = await res.json();
    expect(j.authenticated_as).toBe(USER);
    for (const k of ["postings", "summary", "journal", "periods", "batches", "accounts", "exports"]) expect(j.endpoints[k]).toBeTruthy();
  });

  test("OpenAPI document is valid 3.1 with paths", async ({ api }) => {
    const j = await (await api.get("/api/gl/openapi.json")).json();
    expect(j.openapi).toMatch(/^3\.1/);
    expect(Object.keys(j.paths).length).toBeGreaterThan(4);
  });

  for (const period of ["this_month", "last_month", "this_quarter", "last_quarter", "ytd", "last_12", "all"]) {
    test(`summary for ${period}`, async ({ api }) => {
      const res = await api.get(`/api/gl/summary?period=${period}`);
      expect(res.status(), await res.text()).toBe(200);
      expect(typeof (await res.json())).toBe("object");
    });
  }

  test("custom date range, and a bad period is a 400 that says what is allowed", async ({ api }) => {
    expect((await api.get("/api/gl/summary?period=custom&from=2026-01-01&to=2026-03-31")).status()).toBe(200);
    const bad = await api.get("/api/gl/summary?period=sometime");
    expect(bad.status()).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain("period must be one of");
  });

  test("postings as JSON, CSV and Excel; one journal explained; balanced debits and credits", async ({ api }) => {
    const res = await api.get("/api/gl/postings?period=all");
    expect(res.status()).toBe(200);
    const j = await res.json();
    const journals = j.journals ?? j.data ?? [];
    expect(Array.isArray(journals)).toBe(true);
    if (journals.length) {
      const no = journals[0].journal_no;
      const one = await api.get(`/api/gl/journals/${encodeURIComponent(no)}`);
      expect(one.status()).toBe(200);
      const lines = (await one.json()).journal?.lines ?? (await one.json()).lines ?? [];
      if (lines.length) {
        const sum = (k: string) => lines.reduce((a: number, l: Record<string, number>) => a + Number(l[k] ?? 0), 0);
        expect(Math.abs(sum("debit") - sum("credit"))).toBeLessThan(0.005);
      }
    }
    const csv = await api.get("/api/gl/postings?period=all&format=csv");
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toMatch(/csv/);
    const xlsx = await api.get("/api/gl/postings?period=all&format=xlsx");
    expect(xlsx.status()).toBe(200);
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK");   // a zip container
  });

  test("periods, batches and chart of accounts", async ({ api }) => {
    for (const p of ["/api/gl/periods", "/api/gl/batches", "/api/gl/accounts"]) {
      const res = await api.get(p);
      expect(res.status(), p).toBe(200);
      expect(res.headers()["content-type"], p).toMatch(/json/);
    }
  });

  test("a malformed journal number is a 400 and an unknown one a 404", async ({ api }) => {
    const bad = await api.get("/api/gl/journals/NO-SUCH-JOURNAL");
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.message).toContain("JE-000001");
    expect((await api.get("/api/gl/journals/JE-999999")).status()).toBe(404);
  });
});

test.describe("system and reports", () => {
  test("health reports every component up", async ({ api }) => {
    const res = await api.get("/api/health");
    const j = await res.json();
    const down = j.components.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string; detail: string }) => `${c.name}: ${c.detail}`);
    expect(down, "components down").toEqual([]);
    expect(res.status()).toBe(200);
  });

  test("sign-in report as JSON, CSV and Markdown", async ({ api }) => {
    expect((await api.get("/api/reports/logins?format=json")).headers()["content-type"]).toMatch(/json/);
    expect((await api.get("/api/reports/logins?format=csv")).headers()["content-type"]).toMatch(/csv/);
    expect(await (await api.get("/api/reports/logins?format=md")).text()).toMatch(/#/);
  });
});

test.describe("MCP server", () => {
  test("handshake, tool list, resources, and every read-only tool", async ({ api }) => {
    const init = await api.mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "uwdesk-uat", version: "1" } });
    expect(init.status).toBe(200);
    expect(JSON.stringify(init.body)).toContain("uwdesk-gl");
    const tools = await api.mcp("tools/list", {}, 2);
    const names = ((tools.body as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name);
    for (const t of ["gl_summary", "gl_journals", "gl_journal", "gl_periods", "gl_batches", "gl_accounts", "gl_push"]) expect(names).toContain(t);
    const res = await api.mcp("resources/list", {}, 3);
    expect(JSON.stringify(res.body)).toContain("uwdesk://gl/accounts");
    let id = 10;
    for (const [name, args] of [["gl_summary", { period: "ytd" }], ["gl_journals", { period: "ytd" }], ["gl_periods", {}], ["gl_batches", {}], ["gl_accounts", {}]] as const) {
      const r = await api.mcp("tools/call", { name, arguments: args }, id++);
      const body = r.body as { result?: { isError?: boolean }; error?: unknown };
      expect(body.error, `${name} error`).toBeFalsy();
      expect(body.result?.isError, `${name} isError`).toBeFalsy();
    }
  });

  test("the guard refuses gl_push before anything is sent", async ({ api }) => {
    await expect(api.mcp("tools/call", { name: "gl_push", arguments: { period: "ytd" } })).rejects.toThrow(/read-only/);
  });
});
