import { glContext, jsonResponse } from "@/lib/gl-http";
import { indexDocument } from "@/lib/gl-service";

export const dynamic = "force-dynamic";

/** GET /api/gl: the API's front door, with links to every endpoint, the docs, the OpenAPI spec and the MCP server. */
export async function GET(req: Request) {
  return jsonResponse(indexDocument(await glContext(req)));
}
