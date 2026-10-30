// HTTP helpers. Pure module so node:test can load it.

/**
 * Content-Disposition safe for any filename. Header values must be Latin-1, so send an
 * ASCII fallback plus the real name RFC 5987-encoded (browsers prefer filename*).
 */
export function contentDisposition(filename: string, disposition: "inline" | "attachment"): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "download";
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Where to send the user back to after a header form post: the Referer's path, but only
 * when the Referer is a well-formed URL on this host and the path is local ("/x", not "//x").
 */
export function safeReturnPath(referer: string | null, host: string | null, fallback = "/submissions"): string {
  if (!referer) return fallback;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return fallback;
  }
  if (host && url.host !== host) return fallback;
  const path = url.pathname;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return fallback;
  // Keep the page's own query (a case view, a search, a period) but not a flash message it already showed.
  const query = new URLSearchParams(url.search);
  query.delete("msg");
  query.delete("error");
  const q = query.toString();
  return q ? `${path}?${q}` : path;
}

/**
 * Whether a state-changing request came from this site, for route handlers that take browser
 * form posts (Server Actions get this check from Next itself). Browsers send Sec-Fetch-Site on
 * every request and Origin on every POST, so a form a hostile page auto-submits is refused even
 * though the browser attached the session cookie or cached Basic credentials. A request with
 * neither header (curl, another system) passes: it carries no ambient browser credentials.
 */
export function sameOrigin(h: { get(name: string): string | null }): boolean {
  const site = h.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = h.get("origin") ?? h.get("referer");
  if (!origin) return true;
  if (origin === "null") return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const expected = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  return host === expected;
}

export const CROSS_SITE_REFUSED = "Cross-site request refused";

/**
 * The public origin of this request ("https://uwdesk-web.fly.dev"), for absolute links in files
 * and API documents: the proxy's forwarded host and scheme when present, else the Host header.
 */
export function requestOrigin(h: { get(name: string): string | null }): string {
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0].trim();
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}
