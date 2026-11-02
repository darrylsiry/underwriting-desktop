/** UX-031 / UX-041: `1 referral`, `2 referrals`, never `referral(s)`. */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A real uuid. Anything else in a path segment is a 404, not a Postgres cast error (CR-031). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/**
 * SQL for the next value of a sequence, zero-padded to `width`. `lpad` alone cuts longer text
 * (`lpad('10000', 4, '0')` is `1000`), so past the width the number grows instead (CR-033).
 */
export const paddedSeq = (sequence: string, width: number) =>
  `(SELECT lpad(n::text, GREATEST(${width}, length(n::text)), '0') FROM nextval('${sequence}') AS n)`;
