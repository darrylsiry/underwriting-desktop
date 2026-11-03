// One home for how money reads on screen and on paper (CR-015). Pure, for node:test and client code.

/** Whole dollars: `$1,250,000`, `-$500`. */
export const money = (v: string | number): string => {
  const n = Math.round(Number(v));
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US")}`;
};

/** The amount as stored, cents only when it has them: `$89,725.15`, `$500`. */
export const moneyExact = (v: string | number): string => `$${Number(v).toLocaleString("en-US")}`;

/** Always two decimals, for the ledger: `$1,250.00`. */
export const moneyCents = (v: string | number): string =>
  `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A difference, always with its sign: `+$500`, `-$500`. */
export const moneySigned = (n: number): string => `${n >= 0 ? "+" : "-"}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

/** A rate factor: at least two decimals, and every one the rate table holds (`1.00`, `1.125`) (CR-163). */
export const factorText = (v: string | number): string =>
  Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** Short, for a tile: `$1.28M`, `$243K`, `$9,500`. */
export const moneyShort = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `$${Math.round(n / 1000)}K` : money(n);
