#!/bin/sh
# PostToolUse hook (.claude/settings.json, every tool): when a review agent's report is newer than
# docs/AGENT_LEDGER.json, fold it into the ledger, so App Tests keeps the history even though each
# run overwrites its report (step 26). It compares file times instead of asking which tool ran or
# what it wrote, because the scheduled reviews copy their report into place with a shell command.
# Costs a few file tests when nothing changed. Never blocks the session: a failed rebuild warns
# once, and the next change to a report tries again.
cat > /dev/null   # the hook's input isn't needed; read it so the sender never hits a closed pipe
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ledger="$root/docs/AGENT_LEDGER.json"
stale=
[ -e "$ledger" ] || stale=1
for report in CODE_REVIEW SECURITY_REVIEW UX_REVIEW UAT_REPORT; do
  if [ "$root/docs/$report.md" -nt "$ledger" ]; then stale=1; fi
done
[ -n "$stale" ] || exit 0

# Dated from before the rebuild, so a report written while it runs still counts as newer next time.
stamp=$(mktemp)
out=$(cd "$root" && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON web/scripts/agent-ledger.ts 2>&1)
status=$?
touch -r "$stamp" "$ledger"
rm -f "$stamp"
if [ "$status" -ne 0 ]; then
  msg=$(printf '%s' "$out" | tail -n 1 | tr -d '"\\' | cut -c1-200)
  printf '{"systemMessage":"App Tests ledger not updated: %s"}\n' "$msg"
fi
exit 0
