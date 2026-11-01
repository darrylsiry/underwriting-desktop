import { CROSS_SITE_REFUSED, sameOrigin } from "@/lib/http";
import { RATING_SERVICE_URL, ratingAuthHeaders } from "@/lib/services";
import { currentUser } from "@/lib/user";

// The rating service's rate-table admin UI, served through the web app so it sits behind the
// same password gate and the rating service can stay private (Fly: reachable on .flycast only).
export const dynamic = "force-dynamic";

// No cookies either way (SEC-030): the browser's session cookie is for this app, not the rating
// service, and the service never needs to remember a name when the proxy says who is signed in.
const FORWARD_REQUEST = ["content-type", "accept"];
const FORWARD_RESPONSE = ["content-type", "location"];

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // The admin's forms change rate tables; a form another site auto-submits with this browser's
  // credentials must not reach them (CR-051). The rating service makes the same check itself.
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req.headers)) {
    return new Response(CROSS_SITE_REFUSED, { status: 403, headers: { "Content-Type": "text/plain" } });
  }
  const upstream = await fetch(`${RATING_SERVICE_URL}${url.pathname}${url.search}`, {
    method: req.method,
    headers: {
      ...Object.fromEntries(FORWARD_REQUEST.flatMap((h) => (req.headers.get(h) ? [[h, req.headers.get(h)!]] : []))),
      // Tell the admin it's inside the UW Desktop so it renders the desktop's top nav (display only).
      "x-uw-desktop": "1",
      "x-uw-user": await currentUser(),
      // The service trusts x-uw-user only from a caller holding this shared secret (SEC-002).
      ...ratingAuthHeaders(),
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    redirect: "manual",  // the admin redirects after each POST; let the browser follow it
    signal: AbortSignal.timeout(15_000),
  });
  const headers = new Headers();
  for (const h of FORWARD_RESPONSE) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export { proxy as GET, proxy as POST };
