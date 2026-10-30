import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { DEFAULT_INTERVAL_MS, keepWarmInterval, startKeepWarm } from "./keep-warm.ts";

test("pings at startup, then on every interval until stopped", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  let pings = 0;
  const stop = startKeepWarm(async () => { pings++; }, 60_000);
  assert.equal(pings, 1, "wakes the services the moment the web process starts");
  mock.timers.tick(60_000 * 3);
  assert.equal(pings, 4);
  stop();
  mock.timers.tick(60_000 * 3);
  assert.equal(pings, 4);
  mock.timers.reset();
});

test("a failing ping never throws", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const stop = startKeepWarm(() => Promise.reject(new Error("rating is down")), 1000);
  mock.timers.tick(3000);
  await new Promise((r) => setImmediate(r));
  stop();
  mock.timers.reset();
});

test("interval comes from KEEP_WARM_INTERVAL_MS; 0 turns it off", () => {
  assert.equal(keepWarmInterval({}), DEFAULT_INTERVAL_MS);
  assert.equal(keepWarmInterval({ KEEP_WARM_INTERVAL_MS: "30000" }), 30_000);
  assert.equal(keepWarmInterval({ KEEP_WARM_INTERVAL_MS: "0" }), 0);
  assert.equal(keepWarmInterval({ KEEP_WARM_INTERVAL_MS: "soon" }), DEFAULT_INTERVAL_MS);
  let pings = 0;
  startKeepWarm(async () => { pings++; }, 0);
  assert.equal(pings, 0);
});
