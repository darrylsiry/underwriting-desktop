// Turning what the underwriter typed into safe SQL search terms. Pure module for node:test.

export type Query = {
  text: string;            // trimmed input
  like: string;            // ILIKE pattern with %, _ and \ escaped: "%term%"
  reference: "submission" | "quote" | "policy" | "binder" | "fein" | "class" | null;
};

const REFERENCES: [Query["reference"], RegExp][] = [
  ["submission", /^SUB-\d+$/i],
  ["quote", /^Q-\d{4}-\d+( v\d+)?$/i],
  ["policy", /^GL-\d{2}-\d+$/i],
  ["binder", /^BND-\d{2}-\d+$/i],
  ["fein", /^\d{2}-\d{7}$/],
  ["class", /^\d{5}$/],
];

export function parseQuery(input: string): Query | null {
  const text = input.trim().slice(0, 100);
  if (text.length < 2) return null;
  const escaped = text.replace(/[\\%_]/g, (c) => `\\${c}`);
  const reference = REFERENCES.find(([, re]) => re.test(text))?.[0] ?? null;
  return { text, like: `%${escaped}%`, reference };
}
