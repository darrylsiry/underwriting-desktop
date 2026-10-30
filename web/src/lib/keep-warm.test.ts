import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { DEFAULT_INTERVAL_MS, keepWarmInterval, startKeepWarm } from "./keep-warm.ts";

// Let the awaited ping (and the .then after it) settle between fake-timer ticks.
const settle = () => new Promise((r) => setImmediate(r));

async function tick(ms: number, step = 1000) {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step);
    await settle();
  }
}

test("pings at startup, then on every interval until stopped", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let pings = 0;
  const stop = startKeepWarm(async () => { pings++; return true; }, 60_000);
  await settle();
  assert.equal(pings, 1, "wakes the services the moment the web process starts");
  await tick(60_000 * 3);
  assert.equal(pings, 4);
  stop();
  await tick(60_000 * 3);
  assert.equal(pings, 4);
  mock.timers.reset();
});

test("a failed ping is retried every 10 s until a service answers", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const results = [false, false, true]; // Fly refuses twice, then the machine starts
  let pings = 0;
  const stop = startKeepWarm(async () => results[pings++] ?? true, 60_000, { ms: 10_000, max: 6 });
  await settle();
  await tick(10_000);
  assert.equal(pings, 2, "retried after 10 s, not 60");
  await tick(10_000);
  assert.equal(pings, 3, "retried again, and this one succeeds");
  await tick(30_000);
  assert.equal(pings, 3, "no more retries after a success");
  await tick(30_000);
  assert.equal(pings, 4, "back on the normal one-minute cadence");
  stop();
  mock.timers.reset();
});

test("quick retries stop after the limit and never throw", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let pings = 0;
  const stop = startKeepWarm(async () => { pings++; throw new Error("rating is down"); }, 60_000, { ms: 10_000, max: 3 });
  await settle();
  await tick(30_000);
  assert.equal(pings, 4, "startup ping plus 3 quick retries");
  await tick(29_000);
  assert.equal(pings, 4, "then waits for the next interval");
  await tick(2_000);
  assert.equal(pings, 5);
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
