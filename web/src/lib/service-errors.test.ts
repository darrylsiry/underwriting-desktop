import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceError, describeServiceError, errorDetailOf } from "./service-errors.ts";

// UX-008: the words a user sees when the ingestion or rating service fails.
test("no answer at all reads as 'not responding'", () => {
  assert.equal(describeServiceError(new TypeError("fetch failed")), "The document reader isn't responding. Nothing was saved; try again in a moment.");
  const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  assert.equal(describeServiceError(abort, "rating service"), "The rating service isn't responding. Nothing was saved; try again in a moment.");
});

test("a 5xx names the status and says to retry; a 4xx shows the service's own words", () => {
  assert.equal(describeServiceError(new ServiceError(502)), "The document reader hit a problem (502). Nothing was saved; try again.");
  assert.equal(describeServiceError(new ServiceError(404, "Inbox folder sub-0003 not found")), "Inbox folder sub-0003 not found");
  assert.equal(describeServiceError(new ServiceError(404)), "The document reader refused the request (404). Nothing was saved.");
  assert.equal(describeServiceError({ status: 503 }, "rating service"), "The rating service hit a problem (503). Nothing was saved; try again.");
});

test("the service's detail is read from JSON or a stripped HTML body", () => {
  assert.equal(errorDetailOf('{"detail":"No documents in folder"}'), "No documents in folder");
  assert.equal(errorDetailOf('{"error":{"code":"unauthorized","message":"Your sign-in has ended."}}'), "Your sign-in has ended.");
  assert.equal(errorDetailOf("<html><body><h1>502 Bad Gateway</h1></body></html>"), "502 Bad Gateway");
  assert.equal(errorDetailOf(""), null);
});
