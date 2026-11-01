import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Next registers every action a "use server" module exports on every page that imports it,
// layouts included, and /signin and /request-access sit outside the sign-in gate. So the server
// actions those pages can reach must be ones a stranger may call (step 27: uploadSubmission and
// reviewAction were reachable there through the layout's import of submissions/actions.ts).
const ALLOWED: Record<string, string[]> = {
  "src/app/layout.tsx": ["setUserAction"],
  "src/app/signin/page.tsx": ["safeNext", "signInAction"],
  "src/app/request-access/request-form.tsx": ["requestAccessAction"],
};

const serverActionsOf = (file: string) => {
  const src = readFileSync(file, "utf8");
  if (!/^\s*["']use server["']/.test(src)) return null;
  return [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]).sort();
};

test("pages outside the sign-in gate can reach only their own server actions", () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    const imports = [...readFileSync(file, "utf8").matchAll(/from\s+["'](\.{1,2}\/[^"']+|@\/[^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      const base = spec.startsWith("@/") ? `src/${spec.slice(2)}` : new URL(spec, `file:///${file}`).pathname.slice(1);
      for (const candidate of [`${base}.ts`, `${base}.tsx`, base]) {
        let actions: string[] | null;
        try { actions = serverActionsOf(candidate); } catch { continue; }
        if (actions) assert.deepEqual(actions.filter((a) => !allowed.includes(a)), [], `${file} imports ${candidate}, which exposes ${actions.join(", ")}`);
        break;
      }
    }
  }
});
