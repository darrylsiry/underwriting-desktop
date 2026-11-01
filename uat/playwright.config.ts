import { defineConfig } from "@playwright/test";

// Driven by scripts/uat.sh, which sets these. Never point UAT_MODE=sandbox at production:
// the sandbox suite writes (uploads, quotes, binds, GL pushes, rate edits).
//   UAT_MODE      sandbox | readonly
//   UAT_BASE_URL  e.g. http://127.0.0.1:3900 or https://uwdesk-web.fly.dev
//   UAT_USER / UAT_PASS   the login the run signs in with
//   UAT_PASS_NAME a label for the result files (sandbox, canary, prod)
const mode = process.env.UAT_MODE ?? "readonly";
const baseURL = process.env.UAT_BASE_URL ?? "http://127.0.0.1:3900";
const name = process.env.UAT_PASS_NAME ?? mode;
const isProd = !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseURL);

if (mode === "sandbox" && isProd) {
  throw new Error(`Refusing to run the sandbox (writing) suite against ${baseURL}: it only runs against a local sandbox.`);
}

export default defineConfig({
  testDir: mode === "sandbox" ? "tests/sandbox" : "tests/readonly",
  outputDir: `.work/artifacts-${name}`,
  fullyParallel: false,
  workers: 1,                       // one user, one session: flows depend on each other's order
  retries: isProd ? 1 : 0,          // the live site may be waking a stopped Fly machine
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: `.work/results-${name}.json` }],
  ],
  use: {
    baseURL,
    headless: true,
    serviceWorkers: "block",        // nothing may bypass the write guard's network interception
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    acceptDownloads: true,
    timezoneId: "America/New_York",
  },
});
