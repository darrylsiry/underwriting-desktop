import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPORT_FORMATS, GL_API_VERSION, PERIOD_PRESETS, TRANSACTION_LABEL } from "./gl-journal.ts";
import { glOpenApi } from "./gl-openapi.ts";

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
