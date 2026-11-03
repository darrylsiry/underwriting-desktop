---
description: Run the read-only UX/design reviewer over every user-facing surface (only if the UI changed) and refresh docs/UX_REVIEW.md plus the before/after mockups in docs/ux-mockups/
allowed-tools: Agent, Read, Write, Bash(scripts/ux-review-fingerprint.sh:*), Bash(ls docs/ux-mockups:*), Bash(rm docs/ux-mockups/UX-*.html), Bash(git rev-parse:*), Bash(git log:*), Bash(date:*)
---

Run an independent, read-only usability review of this application and
refresh the UX report. You are the orchestrator only; the review itself
happens in a fresh subagent so it shares no context with this or any other
session.

Rules for you, the orchestrator:
- The **only** files you may write are `docs/UX_REVIEW.md` and
  `docs/ux-mockups/UX-NNN.html`. Do not touch any other file. Do not edit
  code. Do not commit. Do not update `docs/BUILD_LOG.md` or
  `docs/DEMO_PLAYBOOK.md` (this is not a build step). Do not read or write
  anything under `~/.claude/` (memory). Do not read `.env`.
- Do not add your own findings or opinions to the report; the reviewer's
  report is written to the file as-is (minus the mockup appendix, which
  becomes files).
- Do not start the app. The reviewer looks at it only if it is already
  running.

Steps:
1. Run `scripts/ux-review-fingerprint.sh check`. If the first word of the
   output is `UNCHANGED` and the argument to this command is not `force`,
   print one line: "No UI changes since the last UX review (<last_reviewed>,
   commit <commit>). Skipping. Run `/ux-audit force` to review anyway." Then
   stop. Otherwise continue.
2. Spawn the `ux-reviewer` subagent (the Agent tool with
   `subagent_type: "ux-reviewer"`) with this prompt:
   "Review the usability of the application in the repository at $PWD now.
   Follow your instructions in full: read every in-scope UI file, look at the
   running app if it is up, re-verify every finding in the existing
   docs/UX_REVIEW.md if present, note what changed since the previous run,
   and return the complete report in the required Markdown format as your
   final message, with the mockup files in the appendix."
   If that agent type is not available in this session, spawn a
   `general-purpose` agent instead and paste the full contents of
   `.claude/agents/ux-reviewer.md` (everything below the frontmatter) as its
   prompt, followed by the sentence above. State the hard rules again so it
   stays read-only.
3. Take the subagent's final message. If it is not a report starting with
   `# UX review: Underwriting Desktop`, do not write anything; tell the user
   what came back instead and stop.
4. Split out the mockups: every fenced block in the `## Mockup files` section
   whose info string is `html file=docs/ux-mockups/UX-NNN.html` is written
   verbatim (block contents only) to that path. Accept only paths of exactly
   that shape; ignore anything else. Then replace the block in the report
   with one line `- docs/ux-mockups/UX-NNN.html` so the report stays
   readable.
5. Write the report to `docs/UX_REVIEW.md` (overwrite).
6. Leave every mockup in place, including those of resolved findings: App
   Tests shows them beside the fix, which is the point of that page (UX-063).
7. Run `scripts/ux-review-fingerprint.sh record` so the next run can tell
   whether the UI changed.
8. In chat, print: the Summary table, the Outstanding items table, every P1
   and P2 finding in full (including its before/after block), one line per
   P3/P4 item (ID and title), the "What changed since last run" and Resolved
   sections, and the Coverage notes. End with the paths `docs/UX_REVIEW.md`
   and `docs/ux-mockups/` so the user can open the mockups in a browser and
   hand chosen items to a coding agent.

Argument: $ARGUMENTS
