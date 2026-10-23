---
description: Run the read-only code auditor over the whole repo and refresh docs/CODE_REVIEW.md
allowed-tools: Agent, Read, Write, Bash(git rev-parse:*), Bash(git log:*), Bash(date:*)
---

Run an independent, read-only audit of this repository and refresh the review
report. You are the orchestrator only; the review itself happens in a fresh
subagent so it shares no context with this or any other session.

Rules for you, the orchestrator:
- The **only** file you may write is `docs/CODE_REVIEW.md`. Do not touch any
  other file. Do not edit code. Do not commit. Do not update `docs/BUILD_LOG.md`
  or `docs/DEMO_PLAYBOOK.md` (this is not a build step). Do not read or write
  anything under `~/.claude/` (memory).
- Do not add your own findings or opinions to the report; the auditor's
  report is written to the file as-is.

Steps:
1. Spawn the `code-auditor` subagent (the Agent tool with
   `subagent_type: "code-auditor"`) with this prompt:
   "Audit the repository at $PWD now. Follow your instructions in full: read
   every in-scope source file, re-verify every finding in the existing
   docs/CODE_REVIEW.md if present, and return the complete report in the
   required Markdown format as your final message."
   If that agent type is not available in this session, spawn a
   `general-purpose` agent instead and paste the full contents of
   `.claude/agents/code-auditor.md` (everything below the frontmatter) as its
   prompt, followed by the sentence above. Set its tools to read-only use by
   stating the hard rules again.
2. Take the subagent's final message. If it is not a report starting with
   `# Code review: Underwriting Desktop`, do not write anything; tell the user
   what came back instead and stop.
3. Write the report verbatim to `docs/CODE_REVIEW.md` (overwrite).
4. In chat, print: the Summary table, then every Critical and High finding
   in full, then one line per Medium/Low/Suggestion item (ID and title), then
   the Resolved list, then the Coverage notes. End with the path
   `docs/CODE_REVIEW.md` so the user can hand it to a coding agent.
