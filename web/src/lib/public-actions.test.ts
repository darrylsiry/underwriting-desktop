import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Next registers every action a "use server" module exports on every page that imports it,
// directly or through other modules, layouts included, and /signin and /request-access sit outside
// the sign-in gate. So the server actions those pages can reach must be ones a stranger may call
// (step 27: uploadSubmission and reviewAction were reachable there through the layout's import of
// submissions/actions.ts).
const ALLOWED: Record<string, string[]> = {
  "src/app/layout.tsx": ["setUserAction"],
  "src/app/signin/page.tsx": ["signInAction"],
  "src/app/request-access/page.tsx": ["requestAccessAction"],
  "src/app/not-found.tsx": [],
  "src/app/error.tsx": [],
};

const isFile = (f: string) => existsSync(f) && statSync(f).isFile();

/** The module an import names, as a path from web/, or null for a package. */
function resolve(spec: string, from: string): string | null {
  const local = spec.startsWith("@/") ? `src/${spec.slice(2)}` : spec.startsWith(".") ? path.join(path.dirname(from), spec) : null;
  if (!local) return null;
  return [local, `${local}.ts`, `${local}.tsx`, `${local}/index.ts`, `${local}/index.tsx`].find(isFile) ?? null;
}

const importsOf = (src: string) => [...src.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);

/** Every module reachable from `root`, following imports through components and libraries. */
function reachable(root: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [root];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const src = readFileSync(file, "utf8");
    seen.set(file, src);
    for (const spec of importsOf(src)) {
      const next = resolve(spec, file);
      if (next && /\.tsx?$/.test(next)) queue.push(next);
    }
  }
  return seen;
}

const serverActionsOf = (src: string) => (/^\s*["']use server["']/.test(src)
  ? [...src.matchAll(/^export (?:async function|const) (\w+)/gm)].map((m) => m[1]).sort() : null);

test("pages outside the sign-in gate can reach only their own server actions, through any chain of imports (CR-099)", () => {
  for (const [root, allowed] of Object.entries(ALLOWED)) {
    for (const [file, src] of reachable(root)) {
      const actions = serverActionsOf(src);
      if (actions) assert.deepEqual(actions.filter((a) => !allowed.includes(a)), [], `${root} reaches ${file}, which exposes ${actions.join(", ")}`);
    }
  }
});

test("the transitive walk really follows imports", () => {
  assert.ok(reachable("src/app/layout.tsx").has("src/app/working-as-action.ts"));
  assert.ok(reachable("src/app/request-access/page.tsx").has("src/app/request-access/actions.ts"), "page → form → actions");
  assert.ok(reachable("src/app/signin/page.tsx").has("src/lib/basic-auth.ts"));
});
