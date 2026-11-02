import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPORT_FORMATS, GL_API_VERSION, PERIOD_PRESETS, TRANSACTION_LABEL } from "./gl-journal.ts";
import { API_ERROR_CODES, errorStatuses, glOpenApi } from "./gl-openapi.ts";

test("the OpenAPI document names this instance, secures every path with basic auth and enumerates the same values the routes accept", () => {
  const doc = glOpenApi("https://uwdesk-web.fly.dev");
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.version, GL_API_VERSION, "one version, in one place (CR-120)");
  assert.deepEqual(doc.servers.map((s) => s.url), ["https://uwdesk-web.fly.dev"]);
  assert.deepEqual(doc.security, [{ basicAuth: [] }]);
  assert.equal((doc.components.securitySchemes.basicAuth as { scheme: string }).scheme, "basic");

  const postings = doc.paths["/api/gl/postings"].get!;
  const param = (n: string) => postings.parameters!.find((p) => p.name === n)!;
  assert.deepEqual(param("period").schema.enum, PERIOD_PRESETS);
  assert.deepEqual(param("type").schema.enum, Object.keys(TRANSACTION_LABEL));
  assert.deepEqual(param("format").schema.enum, EXPORT_FORMATS);
  assert.ok(postings.responses["200"].content!["text/csv"], "csv is a documented response");

  const ids = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths)) {
    assert.match(path, /^\/api\/gl/);
    for (const op of Object.values(ops)) {
      assert.ok(op!.summary && op!.description && op!.responses["200"] || op!.responses["201"], `${path} documents a success response`);
      assert.ok(!ids.has(op!.operationId), `operationId ${op!.operationId} is unique`);
      ids.add(op!.operationId);
    }
  }
  assert.ok(ids.has("pushToGl") && ids.has("listPostings") && ids.has("getJournal"));
  // every $ref points at a schema that exists
  const refs = JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? [];
  for (const r of refs) assert.ok(r.split("/").pop()! in doc.components.schemas, `${r} resolves`);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(doc)));
});

test("every error code the API can answer with is published, and a push documents its filter (CR-133)", () => {
  const doc = glOpenApi("https://uw.example") as unknown as {
    paths: Record<string, { post?: { responses: Record<string, unknown>; parameters?: { name: string }[] } }>;
    components: { schemas: { Error: { properties: { error: { properties: { code: { enum: readonly string[] } } } } }; ExportRequest: { properties: Record<string, unknown> } } };
  };
  assert.deepEqual([...doc.components.schemas.Error.properties.error.properties.code.enum], [...API_ERROR_CODES]);
  const push = doc.paths["/api/gl/exports"].post;
  assert.ok(push?.responses["403"]);
  assert.ok(doc.components.schemas.ExportRequest.properties.batch);
  assert.deepEqual(push?.parameters?.map((p) => p.name), ["period", "from", "to", "type", "batch", "format"]);
});

test("a push with nothing to send is documented as a 409 (CR-119)", () => {
  const doc = glOpenApi("https://uw.example") as unknown as {
    paths: Record<string, { post?: { responses: Record<string, unknown> } }>;
    components: { schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } } };
  };
  assert.ok(doc.paths["/api/gl/exports"].post?.responses["409"]);
  assert.ok(doc.components.schemas.Error.properties.error.properties.code.enum.includes("nothing_to_push"));
});

test("the docs page's error list holds every status the document declares, each explained (CR-146)", () => {
  const errors = errorStatuses(glOpenApi("https://x.test"));
  assert.deepEqual(errors.map((e) => e.status), ["400", "401", "403", "404", "409"]);
  for (const e of errors) assert.notEqual(e.meaning, "", `status ${e.status} needs a meaning`);
});
