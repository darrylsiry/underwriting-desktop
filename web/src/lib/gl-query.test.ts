import assert from "node:assert/strict";
import { test } from "node:test";
import { pushedAccountingPath } from "./gl-query.ts";

// UX-022: after a push the page shows the batch it just made, or the view it came from when nothing was new.
test("a push that stamped lines lands on that batch, keeping the period", () => {
  assert.equal(pushedAccountingPath({ period: "this_month", from: "", to: "", type: "", batch: "" }, "GLX-20261031-001", 12, "xlsx"),
    "/accounting?period=this_month&batch=GLX-20261031-001&pushed=12&format=xlsx");
});

test("a push that stamped nothing keeps the filter it came from", () => {
  assert.equal(pushedAccountingPath({ period: "custom", from: "2026-10-01", to: "2026-10-31", type: "renewal", batch: "GLX-20261030-002" }, "GLX-20261031-003", 0, "csv"),
    "/accounting?period=custom&from=2026-10-01&to=2026-10-31&type=renewal&batch=GLX-20261030-002&pushed=0&format=csv");
});
