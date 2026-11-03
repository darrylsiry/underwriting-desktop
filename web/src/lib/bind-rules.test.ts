import assert from "node:assert/strict";
import { test } from "node:test";
import { bindBlockers, policyNumbers, subjectivityStatus } from "./bind-rules.ts";

const quote = { status: "issued", valid_until: "2026-11-22", effective_date: "2026-11-01", expiration_date: "2027-11-01" };

test("an issued, unexpired quote can be bound", () => {
  assert.deepEqual(bindBlockers(quote, "2026-10-23"), []);
});

test("superseded, bound and expired quotes can't", () => {
  assert.match(bindBlockers({ ...quote, status: "superseded" }, "2026-10-23")[0], /newer version/);
  assert.match(bindBlockers({ ...quote, status: "bound" }, "2026-10-23")[0], /already bound/);
  assert.match(bindBlockers(quote, "2026-11-23")[0], /expired on Nov 22, 2026/);
});

test("unreceived subjectivities stay open, due in 30 days", () => {
  assert.deepEqual(subjectivityStatus(["Signed app", "Loss runs"], new Set([0]), "2026-10-23"), [
    { text: "Signed app", status: "received", due_date: null },
    { text: "Loss runs", status: "open", due_date: "2026-11-22" },
  ]);
});

test("policy and binder numbers share the sequence", () => {
  assert.deepEqual(policyNumbers(7, 2026), { policy: "GL-26-00007", binder: "BND-26-00007" });
});
