#!/bin/sh
# PostToolUse hook (.claude/settings.json, Write|Edit): when a review command writes its report,
# fold that run into docs/AGENT_LEDGER.json so App Tests keeps the history even though every
# report overwrites the last (step 26). Any other file: exit at once. Never blocks the session;
# if the rebuild fails it says so in one line and carries on.
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
# The first unescaped "file_path" in the hook input is the tool's own (an escaped one inside
# written content reads \"file_path\" and doesn't match).
file=$(grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*:[[:space:]]*"\(.*\)"$/\1/')
case "$file" in
  "$root"/docs/CODE_REVIEW.md|"$root"/docs/SECURITY_REVIEW.md|"$root"/docs/UX_REVIEW.md|"$root"/docs/UAT_REPORT.md) ;;
  *) exit 0 ;;
esac
if ! out=$(cd "$root" && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON web/scripts/agent-ledger.ts 2>&1); then
  msg=$(printf '%s' "$out" | tail -n 1 | tr -d '"\\' | cut -c1-200)
  printf '{"systemMessage":"App Tests ledger not updated: %s"}\n' "$msg"
fi
exit 0
