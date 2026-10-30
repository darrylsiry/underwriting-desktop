import assert from "node:assert/strict";
import { test } from "node:test";
import { inlineText, parseInline, parseMarkdown } from "./markdown.ts";

test("inline links, bold, italics and code", () => {
  const nodes = parseInline("Policy [GL-26-00020](/policies/abc) was bound for **$21,994** by _underwriter8_ (`JE-000020`).");
  assert.deepEqual(nodes.map((n) => n.type), ["text", "link", "text", "strong", "text", "em", "text", "code", "text"]);
  const link = nodes[1] as { href: string };
  assert.equal(link.href, "/policies/abc");
  assert.equal(inlineText(nodes), "Policy GL-26-00020 was bound for $21,994 by underwriter8 (JE-000020).");
});

test("blocks: heading, paragraph, lists, table, code, quote, rule", () => {
  const blocks = parseMarkdown(`## Renewals due
Two policies expire soon:

| Policy | Insured | Expires |
|---|---|---|
| [GL-25-70001](/policies/book/1) | Hill Country Roofing | 2026-11-15 |
| [GL-26-00004](/policies/2) | Copper Canyon Coatings | 2027-01-01 |

- first point
- second point
  that wraps
1. one
2. two

> a note

---
\`\`\`
raw
\`\`\`
Done.`);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "table", "list", "list", "quote", "rule", "code", "paragraph"]);
  const table = blocks[2] as { header: unknown[]; rows: unknown[][] };
  assert.equal(table.header.length, 3);
  assert.equal(table.rows.length, 2);
  assert.equal(inlineText((table.rows[0] as never[])[0]), "GL-25-70001");
  const bullets = blocks[3] as unknown as { ordered: boolean; items: never[][] };
  assert.equal(bullets.ordered, false);
  assert.equal(inlineText(bullets.items[1]), "second point that wraps");
  assert.equal((blocks[4] as unknown as { ordered: boolean }).ordered, true);
  assert.equal((blocks[7] as unknown as { text: string }).text, "raw");
});
