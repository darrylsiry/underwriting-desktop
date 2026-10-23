import assert from "node:assert/strict";
import { test } from "node:test";
import { contentDisposition } from "./http.ts";

test("non-Latin-1 filenames are header-safe (CR-002)", () => {
  const value = contentDisposition('Submission – ACME "final".pdf', "inline");
  assert.equal(value, `inline; filename="Submission _ ACME final.pdf"; filename*=UTF-8''Submission%20%E2%80%93%20ACME%20%22final%22.pdf`);
  assert.doesNotThrow(() => new Response("x", { headers: { "Content-Disposition": value } }));
});
