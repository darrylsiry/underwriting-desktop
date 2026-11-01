import { test, expect, watchPage, IS_PROD } from "../guard";
import fs from "node:fs";

/**
 * Visit every page a user can reach by clicking links, starting from the nav, as a user would.
 * Each distinct page shape (ids collapsed, e.g. /submissions/:id/workbench) is opened up to
 * PER_SHAPE times. A page passes when it answers < 400, renders a heading, shows no error page
 * and logs no page errors or 5xx. Links to files (PDFs, memos, documents, exports) are fetched
 * and checked for the right kind of file. New pages are picked up without changing this test.
 */
const START = ["/", "/insureds", "/submissions", "/quotes", "/policies", "/book", "/search?q=roof", "/assistant",
  "/audit", "/audit/logins", "/accounting", "/accounting/api", "/accounting/mcp", "/admin"];
const PER_SHAPE = Number(process.env.UAT_PER_SHAPE ?? 2);
const MAX_PAGES = Number(process.env.UAT_MAX_PAGES ?? 220);
const FILE = /\/(pdf|memo)$|\/documents\/[^/]+$|\/policies\/[^/]+\/(binder|policy|dec|declarations|memo|[a-z-]+)$|format=(csv|xlsx|md)|\.(pdf|csv|xlsx)$/i;

function shape(path: string): string {
  const u = new URL(path, "http://x");
  const p = u.pathname.split("/").map((s) => (/^\d+$|^[0-9a-f-]{8,}$|^(SUB|Q|GL|POL|BND|BK)-|^\d{8}-/i.test(s) ? ":id" : s)).join("/");
  const keys = [...u.searchParams.keys()].sort().join("&");
  return keys ? `${p}?${keys}` : p;
}

/**
 * Opening the workbench or renewal page of an accepted submission that has never been worked
 * creates its worksheet (a GET that writes). So the crawl opens those pages only for submissions
 * that already have a rating: the ones listed under Referrals open, Ready to quote, Quoted and
 * Bound, plus renewals (which get their worksheet when the renewal starts).
 */
async function worksheetSafeIds(page: import("@playwright/test").Page): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const stage of ["referred", "ready", "quoted", "bound"]) {
    await page.goto(`/submissions?stage=${stage}`);
    const hrefs = await page.$$eval("a[href^='/submissions/']", (as) => as.map((a) => a.getAttribute("href") ?? ""));
    for (const h of hrefs) { const m = h.match(/^\/submissions\/([^/?#]+)/); if (m && m[1] !== "inbox") ids.add(m[1]); }
  }
  await page.goto("/submissions");
  const renewals = await page.$$eval("a[href$='/renewal']", (as) => as.map((a) => a.getAttribute("href") ?? ""));
  for (const h of renewals) { const m = h.match(/^\/submissions\/([^/?#]+)\/renewal/); if (m) ids.add(m[1]); }
  return ids;
}

test("crawl every reachable page", async ({ page, api, baseURL }) => {
  test.setTimeout(30 * 60_000);
  const origin = new URL(baseURL!).origin;
  const safe = await worksheetSafeIds(page);
  const skipped: string[] = [];
  const queue = [...START];
  const seenUrl = new Set<string>();
  const perShape = new Map<string, number>();
  const results: { url: string; shape: string; status: number; ms: number; heading: string; problems: string[] }[] = [];
  const files: { url: string; status: number; type: string; bytes: number; ok: boolean }[] = [];
  const failures: string[] = [];

  while (queue.length && results.length < MAX_PAGES) {
    const path = queue.shift()!;
    if (seenUrl.has(path)) continue;
    seenUrl.add(path);
    const ws = path.match(/^\/submissions\/([^/?#]+)\/(workbench|renewal)/);
    if (ws && !safe.has(ws[1])) { skipped.push(path); continue; }
    const sh = shape(path);
    if ((perShape.get(sh) ?? 0) >= PER_SHAPE) continue;
    perShape.set(sh, (perShape.get(sh) ?? 0) + 1);

    if (FILE.test(path) && !/^\/policies\/[^/]+$/.test(path)) {
      const res = await api.get(path, { maxRedirects: 0 }).catch(() => null);
      if (res && res.status() < 400 && !(res.headers()["content-type"] ?? "").includes("text/html")) {
        const body = await res.body();
        const type = res.headers()["content-type"] ?? "";
        const ok = type.includes("pdf") ? body.subarray(0, 4).toString() === "%PDF" : body.length > 0;
        files.push({ url: path, status: res.status(), type, bytes: body.length, ok });
        if (!ok) failures.push(`file ${path}: ${type}, ${body.length} bytes, not a valid file`);
        continue;
      }
      if (res && res.status() >= 400) { failures.push(`file ${path}: HTTP ${res.status()}`); files.push({ url: path, status: res.status(), type: "", bytes: 0, ok: false }); continue; }
      // An HTML answer: it is a page after all, fall through.
    }

    const problems = await watchPage(page);
    const t0 = Date.now();
    const resp = await page.goto(path, { waitUntil: "domcontentloaded" }).catch((e) => { problems.push(`navigation failed: ${(e as Error).message.split("\n")[0]}`); return null; });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const status = resp?.status() ?? 0;
    const heading = (await page.locator("h1").first().textContent({ timeout: 3_000 }).catch(() => ""))?.trim() ?? "";
    const body = await page.locator("body").innerText().catch(() => "");
    if (status >= 400) problems.push(`HTTP ${status}`);
    if (/Something went wrong|Application error|Internal Server Error|This page could not be found/i.test(body)) problems.push("error page shown");
    if (!heading && !path.startsWith("/admin")) problems.push("no <h1> heading");
    results.push({ url: path, shape: sh, status, ms: Date.now() - t0, heading, problems: [...problems] });
    if (problems.length) failures.push(`${path}: ${problems.join("; ")}`);
    page.removeAllListeners("pageerror"); page.removeAllListeners("console"); page.removeAllListeners("response");

    const links = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href)).catch(() => [] as string[]);
    for (const href of links) {
      let u: URL;
      try { u = new URL(href); } catch { continue; }
      if (u.origin !== origin) continue;
      if (/^\/(signout|_next|api\/)/.test(u.pathname)) continue;   // the API has its own spec
      const next = u.pathname + u.search;
      if (!seenUrl.has(next)) queue.push(next);
    }
  }

  fs.mkdirSync(".work", { recursive: true });
  fs.writeFileSync(`.work/crawl-${process.env.UAT_PASS_NAME ?? "readonly"}.json`, JSON.stringify({ pages: results, files, failures, skipped_unworked_workbenches: skipped }, null, 2));
  test.info().annotations.push({ type: "coverage", description: `${results.length} pages across ${perShape.size} page shapes, ${files.length} files${IS_PROD ? " (production)" : ""}` });
  const slow = results.filter((r) => r.ms > 8_000).map((r) => `${r.url} ${r.ms}ms`);
  if (slow.length) test.info().annotations.push({ type: "slow pages", description: slow.join(", ") });
  expect(results.length, "pages visited").toBeGreaterThan(20);
  expect(failures, "pages or files that failed").toEqual([]);
});
