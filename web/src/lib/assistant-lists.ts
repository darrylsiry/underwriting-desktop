// How the assistant's list tools say how much they left out. Pure module for node:test.

/**
 * `count` is the rows returned and `total_matching` every row that matched, as audit_search reports
 * them, so a cut list can't pass for the whole answer (CR-149). Compute money totals over every match.
 */
export function listMeta(shown: number, totalMatching: number, noun: string) {
  const truncated = totalMatching > shown;
  return {
    count: shown,
    total_matching: totalMatching,
    ...(truncated && {
      truncated: true,
      note: `Showing the newest ${shown} of ${totalMatching} ${noun}. Raise limit (max 200) for more rows, or use book_summary for the whole book. Any money total here covers all ${totalMatching}.`,
    }),
  };
}
