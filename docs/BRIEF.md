# FracVibe — the brief template (copy this)

A brief must be **self-contained**: the writer never sees the dispatcher's
conversation, so nothing may be left to "as discussed". Fill every field.

---

You are a **WRITER** on FracVibe (static ES-module fractal explorer; Netlify
publishes `public/`; Playwright smoke suite in `tests/`). Read
`/home/administrator/projects/FracVibe/AGENTS.md` **first** — it is binding — then
`MODERNIZATION.md` and the `docs/STATE.md` rows for your area.

## Where you work (READ THIS TWICE)
Your worktree is `<ABSOLUTE>/worktrees/<slice>` on branch `<branch>`, based on
`origin/main` = `<sha>`, with `node_modules` installed. Every bash call runs in a
fresh shell whose cwd is the MAIN repo, and file tools resolve RELATIVE paths
against it — so **every** read/edit/write/bash call must use an **ABSOLUTE** path
under your worktree (or pass a workdir). **Never touch the main tree.** `<N>`
other writer(s) may be in flight; your files are disjoint.

## Your row: `<row id>`
A `docs/` conflict is a mechanical UNION (renumber only YOUR row). A **non-docs**
conflict: STOP and report.

## The owner's report (verbatim) and the intent
"<paste the owner's words exactly>" — then: the outcome the request reaches for,
and the MEASURED state of the code today (`file:line`).

## What to build
One numbered list. Name the **ONE seam** it extends. State the design decisions the
dispatcher has already made, and that you may prove wrong. Name what is
deliberately OUT of scope, and why.

## Pins
The behaviours that must go RED when broken, each phrased as a statement. Reuse
`tests/smoke.spec.js`; never build a second fixture set.

## Verification (yours)
1. `bash scripts/gate.sh`. Exit 9 = lock busy or `:3000` held → WAIT and retry;
   never reap another actor's processes. Keep the RAW log. You do **not** report
   LANDED on a compile-only (exit 2) result.
2. Your own control that the new test *can* fail: break the thing on purpose, watch
   the named test go RED, restore from HEAD in a `trap`. An arm that cannot go red
   is VOID.
3. Commit style; rebase on `origin/main` before you report.
4. If you cannot finish, **COMMIT** the coherent partial state and report
   **BLOCKED** with the reasoning.

## Docs to amend in the SAME commit
`docs/PLAN.md` (your slice's status) and `docs/DECISIONS.md` (a new row if you
decided something), and any claim in `MODERNIZATION.md` your change makes false.
**`docs/STATE.md` is the DISPATCHER's file — do not edit it.** Report the facts and
the dispatcher records them; one hot board file with one writer avoids a docs
conflict on every landing.

## Your report (short)
**LANDED** or **BLOCKED**, then: sha; gate exit code + counts + the raw log path;
each control with what went red; judgement calls; docs amended; and anything this
brief got wrong. **Report nothing in between — silence until LANDED or BLOCKED.**
If you can PROVE a rule here is wrong (including this brief's own design), report
BLOCKED with the evidence rather than implementing it.
