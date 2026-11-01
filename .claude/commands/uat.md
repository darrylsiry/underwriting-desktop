---
description: Run the user-acceptance tester over every function of the app (sandbox flows with writes, canary, read-only pass on the live site) and refresh docs/UAT_REPORT.md
allowed-tools: Agent, Read, Write, Bash(git rev-parse:*), Bash(git log:*), Bash(date:*)
---

Run a user-acceptance test of the whole application and refresh the UAT report. You are the
orchestrator only; the testing happens in a fresh `uat-tester` subagent.

Rules for you, the orchestrator:
- The **only** file you may write is `docs/UAT_REPORT.md`. Do not edit code or tests. Do not
  commit, push or deploy. Do not read `.env` or `.fly-credentials`.
- Do not add your own findings to the report; write the tester's report as-is.

Steps:
1. Spawn the `uat-tester` subagent (Agent tool, `subagent_type: "uat-tester"`) with this prompt:
   "Run the user-acceptance test of the application in the repository at $PWD now. Pass to run:
   `<argument, or all>`. Follow your instructions in full: run scripts/uat.sh, investigate every
   failure, check the production-safety evidence, and return the complete report in the required
   Markdown format as your final message."
   If that agent type is not available, spawn a `general-purpose` agent with the full contents of
   `.claude/agents/uat-tester.md` (everything below the frontmatter) followed by that sentence, and
   restate the hard rules so it never writes to production.
2. If the final message does not start with `# UAT report: Underwriting Desktop`, write nothing;
   tell the user what came back and stop.
3. Write it to `docs/UAT_REPORT.md` (overwrite).
4. In chat, print the Verdict, the Summary table, Production safety, and each failure's title and
   classification, then the path `docs/UAT_REPORT.md`.

Argument (all | sandbox | canary | prod): $ARGUMENTS
