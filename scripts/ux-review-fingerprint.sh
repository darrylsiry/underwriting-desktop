#!/usr/bin/env bash
# Fingerprint of the user-facing UI, used by /ux-audit to skip a run when no
# screen, template, document builder or UI-facing rule changed since the last
# UX review.
#
#   scripts/ux-review-fingerprint.sh current   print the fingerprint
#   scripts/ux-review-fingerprint.sh check     print CHANGED or UNCHANGED
#   scripts/ux-review-fingerprint.sh record    store the fingerprint of the
#                                              state that was just reviewed
#
# The fingerprint covers the committed and uncommitted contents of the UI
# paths below (not the whole repo, so a backend-only change does not trigger a
# review). Exit code is always 0; read the first word of the output.
set -euo pipefail

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo"
state=".claude/ux-review/last-run"
paths=(
  web/src/app
  web/src/components
  web/src/lib/referrals.ts
  web/src/lib/bind-rules.ts
  web/src/lib/quote-terms.ts
  web/src/lib/worksheet.ts
  web/src/lib/pdf-writer.ts
  web/src/lib/quote-pdf.ts
  web/src/lib/policy-pdf.ts
  services/rating/app/templates
  services/rating/app/admin.py
)
exclude=(':(exclude,glob)**/.DS_Store')

current() {
  {
    # tracked content at HEAD for the UI paths, plus working-tree edits and
    # untracked files under them
    git ls-tree -r HEAD -- "${paths[@]}" 2>/dev/null
    git diff HEAD -- "${paths[@]}" "${exclude[@]}"
    git ls-files -o --exclude-standard -z -- "${paths[@]}" "${exclude[@]}" \
      | sort -z | xargs -0 shasum -a 256 2>/dev/null
  } | shasum -a 256 | cut -d' ' -f1
}

case "${1:-current}" in
  current)
    current
    ;;
  check)
    now="$(current)"
    if [ -f "$state" ] && [ "$(sed -n 1p "$state")" = "$now" ]; then
      echo "UNCHANGED fingerprint=$now last_reviewed=$(sed -n 2p "$state") commit=$(sed -n 3p "$state")"
    elif [ -f "$state" ]; then
      echo "CHANGED fingerprint=$now last_reviewed=$(sed -n 2p "$state") commit=$(sed -n 3p "$state")"
    else
      echo "CHANGED fingerprint=$now last_reviewed=never"
    fi
    ;;
  record)
    mkdir -p "$(dirname "$state")"
    { current; date '+%Y-%m-%d %H:%M'; git rev-parse --short HEAD; } > "$state"
    echo "RECORDED fingerprint=$(sed -n 1p "$state") at=$(sed -n 2p "$state") commit=$(sed -n 3p "$state")"
    ;;
  *)
    echo "usage: $0 current|check|record" >&2
    exit 2
    ;;
esac
