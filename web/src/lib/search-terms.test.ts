import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuery } from "./search-terms.ts";

test("references are recognized", () => {
  assert.equal(parseQuery("SUB-0003")?.reference, "submission");
  assert.equal(parseQuery("q-2026-0001 v2")?.reference, "quote");
  assert.equal(parseQuery("GL-26-00001")?.reference, "policy");
  assert.equal(parseQuery("BND-26-00001")?.reference, "binder");
  assert.equal(parseQuery("86-4410273")?.reference, "fein");
  assert.equal(parseQuery("98677")?.reference, "class");
  assert.equal(parseQuery("roofing")?.reference, null);
});

test("LIKE wildcards in input are escaped", () => {
  assert.equal(parseQuery("50%_off\\")?.like, "%50\\%\\_off\\\\%");
});

test("too-short input is ignored", () => {
  assert.equal(parseQuery(" a "), null);
});
