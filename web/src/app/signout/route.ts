import { cookies } from "next/headers";
import { loadUsers } from "@/lib/basic-auth";
import { USER_COOKIE } from "@/lib/user";

export const dynamic = "force-dynamic";

const CHALLENGE = 'Basic realm="Underwriting Desktop", charset="UTF-8"';

/**
 * Sign out. HTTP Basic auth has no server session: the browser re-sends the login with every
 * request until it is told the login no longer works. Answering 401 with the same realm does that:
 * the browser drops the cached credentials and shows its sign-in box, which the user can cancel
 * (this page is what they then see) or fill in as someone else. Without the password gate (local
 * development) there is only the "working as" cookie to clear.
 */
export async function GET(req: Request) {
  if (!loadUsers(process.env).size) {
    const jar = await cookies();
    jar.delete(USER_COOKIE);
    return Response.redirect(new URL("/", req.url), 303);
  }
  const html = `<!doctype html>
<meta charset="utf-8"><title>Signed out · Underwriting Desktop</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#0f172a;line-height:1.5}a{color:#4f46e5}p{color:#475569}</style>
<h1>You're signed out</h1>
<p>Your browser has forgotten the login. If a sign-in box is still showing, cancel it.</p>
<p>To sign in again, or as someone else, <a href="/">open the desk</a> and enter a login.</p>`;
  return new Response(html, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "WWW-Authenticate": CHALLENGE, "Cache-Control": "no-store" },
  });
}
