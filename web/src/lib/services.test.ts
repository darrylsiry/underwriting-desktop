import assert from "node:assert/strict";
import { test } from "node:test";
import { actingUserHeaders } from "./services.ts";

test("any \"Working as\" name can travel in the header to the rating service (CR-072)", () => {
  assert.throws(() => new Headers({ "x-uw-user": "\u0141ukasz" }), "a raw name outside Latin-1 is what fetch refuses");
  const headers = new Headers(actingUserHeaders("\u0141ukasz K"));
  assert.equal(headers.get("x-uw-user"), "%C5%81ukasz%20K");
  assert.equal(decodeURIComponent(headers.get("x-uw-user")!), "\u0141ukasz K");
  assert.equal(actingUserHeaders("underwriter1")["x-uw-user"], "underwriter1", "an ordinary login is unchanged");
});
