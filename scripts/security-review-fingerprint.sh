#!/usr/bin/env bash
# Fingerprint of the reviewable code state, used by /security-audit to skip a
# run when nothing has changed since the last security review.
#
#   scripts/security-review-fingerprint.sh current   print the fingerprint
#   scripts/security-review-fingerprint.sh check     print CHANGED or UNCHANGED
#   scripts/security-review-fingerprint.sh record    store the fingerprint of the
#                                                    state that was just reviewed
#
# The fingerprint covers HEAD, uncommitted changes to tracked files, and the
# contents of untracked files. It ignores docs/ (the report lives there),
# .claude/ and .DS_Store files so writing the report never triggers another
# review. Exit code is always 0; read the first word of the output.
set -euo pipefail

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo"
state=".claude/security-review/last-run"
exclude=(':(exclude)docs' ':(exclude).claude' ':(exclude,glob)**/.DS_Store' ':(exclude).DS_Store')

current() {
  {
    git rev-parse HEAD
    git diff HEAD -- . "${exclude[@]}"
    git ls-files -o --exclude-standard -z -- . "${exclude[@]}" \
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
