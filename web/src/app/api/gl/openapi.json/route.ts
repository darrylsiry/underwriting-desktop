import { jsonResponse } from "@/lib/gl-http";
import { glOpenApi } from "@/lib/gl-openapi";
import { requestOrigin } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/gl/openapi.json: the OpenAPI 3.1 description of this API, with this instance as the server. */
export function GET(req: Request) {
  return jsonResponse(glOpenApi(requestOrigin(req.headers)));
}
