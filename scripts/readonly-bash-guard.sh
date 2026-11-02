#!/usr/bin/env bash
# PreToolUse hook for the read-only reviewer agents (SEC-019): refuse Bash commands that would change
# the repository or the machine. The agents' instructions already say "read only"; this makes the
# harness enforce it. Reads the hook's JSON on stdin and exits 2 (block, with the reason on stderr)
# for anything that writes, installs, commits, deletes or reaches out; exits 0 to allow.
#
# A deny-list, not an allow-list: a reviewer runs many harmless one-off commands (grep, git log, wc,
# npm audit, python -c on stdin) and a surprise block would silently degrade the scheduled reviews.
set -euo pipefail
input="$(cat)"
cmd="$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except ValueError:
    print(""); sys.exit(0)
print(d.get("tool_input", {}).get("command", "") if d.get("tool_name", "Bash") == "Bash" else "")')"
[ -n "$cmd" ] || exit 0

deny() { printf 'Blocked by scripts/readonly-bash-guard.sh (the reviewer is read-only): %s\n' "$1" >&2; exit 2; }

# CR-096: two things don't count. Output thrown away writes nothing, and the checks the reviewers are
# told to run are allowed, as whole commands only. Both come out of `scan`, which every rule below
# reads, so the rest of a compound command is still checked: "npm test; rm x" trips on the rm, and
# "npx eslint . --fix" or "npm test > out" aren't these commands at all.
scan="$(printf '%s' "$cmd" | python3 -c 'import re,sys
CHECKS = {"npx tsc --noEmit", "npx eslint .", "npm run lint", "npm test", "uv run --frozen pytest", "uv run --frozen pytest -q"}
text = re.sub(r"(?:[0-9]|&)?>>?[ \t]*/dev/null(?=$|[\s;&|)])", "", sys.stdin.read())
parts = re.split(r"(&&|\|\||;|\||\n)", text)
print("".join("true" if re.sub(r"\s+2>&1$", "", p.strip()) in CHECKS else p for p in parts))')" || deny "could not read the command: $cmd"

# Redirections that write (a heredoc "<<" and "2>&1" are fine), tee, and in-place sed.
printf '%s' "$scan" | grep -Eq '(^|[^<>])>{1,2}[^&]|>&[^12]|\btee\b|\bsed\b[^|;&]*\s-[a-zA-Z]*i' && deny "writes to a file: $cmd"
# File-changing and system-changing commands.
printf '%s' "$scan" | grep -Eq '(^|[;&|]\s*|\bsudo\s+|\bxargs\s+(-[^ ]+\s+)*)(rm|rmdir|mv|cp|ln|mkdir|touch|truncate|chmod|chown|chgrp|install|dd|mkfs|kill|killall|pkill|shutdown|reboot|launchctl|crontab|open)\b' && deny "changes files or the system: $cmd"
# Version control and package managers that change state.
printf '%s' "$scan" | grep -Eq '\bgit\s+(-[^ ]+\s+)*(add|commit|push|pull|fetch|merge|rebase|reset|checkout|switch|restore|stash(\s*$|\s+(push|pop|apply|drop|clear|save|branch|create|store|-))|cherry-pick|revert|clean|rm|mv|tag|branch\s+(-d|-D|-m|-M|[^- ])|remote\s+(add|rm|remove|set-url)|config\s+(--global|--system|[^-]|--add|--unset)|filter-branch|gc|prune|worktree\s+(add|remove|prune)|submodule\s+(add|update)|am|apply|init|clone)\b' && deny "git command that changes state: $cmd"
printf '%s' "$scan" | grep -Eq '\b(npm|pnpm|yarn|bun)\s+(-[^ ]+\s+)*(install|i|ci|add|remove|rm|uninstall|update|up|upgrade|link|publish|run|exec|x|start|dev|build|test|rebuild|dedupe|prune|cache\s+clean|config\s+set|set|init|create)\b|\bnpx\s|\bpip3?\s+(install|uninstall|download)|\buv\s+(pip\s+install|add|remove|sync|lock|run|tool\s+install)|\bpoetry\s+(add|install|remove|update)|\bbrew\s+(install|uninstall|upgrade|tap)|\bdocker(\s+compose)?\s+(run|up|down|build|exec|rm|rmi|pull|push|stop|start|restart|kill|system\s+prune|volume\s+rm)|\bfly\s+(deploy|secrets\s+(set|import|unset)|apps\s+(create|destroy)|scale|machine|ssh|mpg|tokens)|\bgh\s+(pr\s+(create|merge|close|edit|comment|review)|issue\s+(create|close|edit|comment)|repo\s+(create|delete|edit)|release|secret|workflow\s+run|api\s+(-X|--method)\s*(POST|PUT|PATCH|DELETE))' && deny "package manager, container, deploy or GitHub write: $cmd"
# Network writes and remote execution.
printf '%s' "$scan" | grep -Eq '\bcurl\b[^|;&]*\s(-X\s*(POST|PUT|PATCH|DELETE)|--request\s*(POST|PUT|PATCH|DELETE)|-d\s|--data|-F\s|--form|-T\s|--upload-file|-o\s|--output|-O\b)|\bwget\b|\bssh\b|\bscp\b|\brsync\b|\bnc\b|\bncat\b|\btelnet\b' && deny "network write or remote execution: $cmd"
# Interpreters given a program that writes (a quick read-only one-liner is fine). The mode is the
# second argument of open(), or mode=; a file simply named "w" read with open("w") passes.
printf '%s' "$scan" | grep -Eq '\b(python3?|node|ruby|perl|php)\b' && printf '%s' "$scan" | grep -Eq 'open\([^()]*(,|mode=)[[:space:]]*\\?["'"'"'](w|a|x|r\+)[bt+]*\\?["'"'"']|write_text|writeFile|writeFileSync|unlink|rename\(|rmSync|rmdir|os\.remove|shutil\.(rmtree|move|copy)|subprocess' && deny "a script that writes files: $cmd"
exit 0
