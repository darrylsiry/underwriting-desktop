import { glDate } from "@/lib/gl-journal";
import { glMcpServer } from "@/lib/gl-mcp";
import { requestOrigin } from "@/lib/http";
import { serveMcpHttp } from "@/lib/mcp";
import { currentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

// The MCP endpoint (Streamable HTTP, stateless). Behind the same HTTP Basic gate as the rest of
// the app: a client sends an underwriter login in an Authorization header, and every tool call
// runs as that user.
const server = glMcpServer();

async function serve(req: Request) {
  const origin = requestOrigin(req.headers);
  const ctx = { actor: await currentUser(), origin, today: glDate(new Date()) };
  const body = req.method === "POST" ? await req.text() : null;
  const out = await serveMcpHttp(server, { method: req.method, headers: req.headers, body }, ctx, { origin, path: "/api/mcp" });
  return new Response(out.body, { status: out.status, headers: out.headers });
}

export { serve as GET, serve as POST, serve as DELETE };
