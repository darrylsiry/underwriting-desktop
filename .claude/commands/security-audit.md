---
description: Run the read-only security reviewer over the whole repo (only if code changed) and refresh docs/SECURITY_REVIEW.md
allowed-tools: Agent, Read, Write, Bash(scripts/security-review-fingerprint.sh:*), Bash(git rev-parse:*), Bash(git log:*), Bash(date:*)
---

Run an independent, read-only security review of this repository and refresh
the security report. You are the orchestrator only; the review itself happens
in a fresh subagent so it shares no context with this or any other session.

Rules for you, the orchestrator:
- The **only** file you may write is `docs/SECURITY_REVIEW.md`. Do not touch
  any other file. Do not edit code. Do not commit. Do not update
  `docs/BUILD_LOG.md` or `docs/DEMO_PLAYBOOK.md` (this is not a build step).
  Do not read or write anything under `~/.claude/` (memory). Do not read
  `.env`.
- Do not add your own findings or opinions to the report; the reviewer's
  report is written to the file as-is.

Steps:
1. Run `scripts/security-review-fingerprint.sh check`. If the first word of
   the output is `UNCHANGED` and the argument to this command is not `force`,
   print one line: "No code changes since the last security review
   (<last_reviewed>, commit <commit>). Skipping. Run `/security-audit force`
   to review anyway." Then stop. Otherwise continue.
2. Spawn the `security-reviewer` subagent (the Agent tool with
   `subagent_type: "security-reviewer"`) with this prompt:
   "Security-review the repository at $PWD now. Follow your instructions in
   full: read every in-scope source file, re-verify every finding in the
   existing docs/SECURITY_REVIEW.md if present, and return the complete report
   in the required Markdown format as your final message."
   If that agent type is not available in this session, spawn a
   `general-purpose` agent instead and paste the full contents of
   `.claude/agents/security-reviewer.md` (everything below the frontmatter)
   as its prompt, followed by the sentence above. State the hard rules again
   so it stays read-only.
3. Take the subagent's final message. If it is not a report starting with
   `# Security review: Underwriting Desktop`, do not write anything; tell the
   user what came back instead and stop.
4. Write the report verbatim to `docs/SECURITY_REVIEW.md` (overwrite).
5. Run `scripts/security-review-fingerprint.sh record` so the next run can
   tell whether code changed.
6. In chat, print: the Summary table, then every Critical and High finding
   in full, then one line per Medium/Low/Informational item (ID and title),
   then the Resolved list, then the Coverage notes. End with the path
   `docs/SECURITY_REVIEW.md` so the user can hand it to a coding agent.

Argument: $ARGUMENTS
