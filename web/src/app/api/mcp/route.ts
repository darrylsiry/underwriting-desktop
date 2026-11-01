import { glDate } from "@/lib/gl-journal";
import { glMcpServer } from "@/lib/gl-mcp";
import { addressedToUs, requestOrigin } from "@/lib/http";
import { serveMcpHttp } from "@/lib/mcp";
import { noteApiLogin } from "@/lib/login-events";
import { currentUser, signedInUser } from "@/lib/user";

export const dynamic = "force-dynamic";

// The MCP endpoint (Streamable HTTP, stateless). Behind the same HTTP Basic gate as the rest of
// the app: a client sends an underwriter login in an Authorization header, and every tool call
// runs as that user.
const server = glMcpServer();

async function serve(req: Request) {
  // A request that reached us under a name that isn't this deployment's is DNS rebinding (SEC-024):
  // its Origin would match its own Host, so the Origin check alone can't tell.
  if (!addressedToUs(req.headers)) return Response.json({ error: "Forbidden: this request was not addressed to this server" }, { status: 403 });
  const origin = requestOrigin(req.headers);
  noteApiLogin(await signedInUser(), req.headers);   // the sign-in report counts MCP clients' logins too
  const ctx = { actor: await currentUser(), origin, today: glDate(new Date()) };
  const body = req.method === "POST" ? await req.text() : null;
  const out = await serveMcpHttp(server, { method: req.method, headers: req.headers, body }, ctx, { origin, path: "/api/mcp" });
  return new Response(out.body, { status: out.status, headers: out.headers });
}

export { serve as GET, serve as POST, serve as DELETE };
