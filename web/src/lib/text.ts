/** UX-031 / UX-041: `1 referral`, `2 referrals`, never `referral(s)`. */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
