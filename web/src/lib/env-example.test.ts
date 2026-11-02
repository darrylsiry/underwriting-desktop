import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
const names = (text: string) => [...text.matchAll(/^# ([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);

test(".env.example says truthfully which settings reach the stack (CR-021)", () => {
  const example = read(".env.example");
  const compose = read("docker-compose.yml");
  const [passed, notPassed] = example.split(/^# Not passed through by docker-compose\.yml/m);
  assert.ok(notPassed, "the file still has its two sections");
  for (const name of names(passed)) assert.ok(compose.includes(`\${${name}`), `${name} is listed as passed through, but compose doesn't read it from .env`);
  for (const name of names(notPassed)) assert.ok(!compose.includes(`\${${name}`), `${name} is listed as not passed through, but compose reads it from .env`);
});
