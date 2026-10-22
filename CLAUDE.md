# Underwriting Desktop — reference build

This is the **reference implementation**, built ahead of a live demo. A second
repo, `darrylsiry/underwriting-desktop-live`, starts nearly empty and gets
rebuilt live in front of an audience. Claude sessions in that repo read
this one to reuse what we built here instead of designing from scratch.

## Goal

An underwriter's workstation: submission intake, risk data enrichment, a
rating/pricing view, referral rules, and a decision/notes trail. (Details to
be filled in as the build progresses.)

## Rules for every session in this repo

1. Build in **small, demo-sized steps**: each one a feature you could show
   in 3–5 minutes with a single prompt.
2. After each step is working, **append an entry to `docs/BUILD_LOG.md`**
   using the template in that file: the prompt that kicked it off, what got
   built, the files touched, decisions made, and dead ends to skip.
3. Keep `docs/DEMO_PLAYBOOK.md` in sync: one line per step with the exact
   prompt the presenter should type tomorrow.
4. Commit after each step with a message prefixed `step-NN:` so the live
   repo can map a step to a commit (`git log --grep step-03`).
5. Prefer a stack that runs with a single command and needs no external
   accounts or secrets, because the demo can't stall on setup.
