# FracVibe — binding rules for agents

Interactive 2D / WebGL / 3D fractal explorer. Static ES modules served from
`public/`; Netlify publishes `public/` with **no build step**. `server/server.js`
is a dev convenience (Express, :3000). One Playwright suite: `tests/smoke.spec.js`.

## Read before you act
1. **`docs/STATE.md`** — the board: what is happening now, and the one screen a
   successor acts from.
2. **`MODERNIZATION.md`** — the audited plan of record (findings B1–B8, phases 0–3).
3. **`docs/DECISIONS.md`** — why it is like this. Append-only.

Nothing is dispatched, and no code is changed, before the board has been
reconciled against reality: `origin/main` (never a stale local branch), the live
session registry, and the host.

## The gate — one command, never hand-rolled
```bash
bash scripts/gate.sh                    # FULL: the Playwright suite. This is what VERIFIES.
GATE_TIER=compile bash scripts/gate.sh  # cheap: syntax only, no browser
```
| exit | means |
|---|---|
| 0 | GREEN — the suite **ran** and passed. |
| 1 | RED — the checks **ran** and something failed. |
| 2 | COMPILE-ONLY — the suite did **not** run. Never quote a `2` as "the gate passed". |
| 9 | REFUSED — the lock or `:3000` is held. This run is **VOID**, not a failure. |
| 10 | KILLED — host memory floor. **VOID**; re-run later. |

- The lock lives in the **git common dir**, so it is shared by every worktree: one
  suite host-wide, however many writers are in flight. **A refusal is the lock
  working** — never a failure, never evidence.
- Raw logs are kept under `/tmp/fracvibe-gate/`. **Never pipe a check through
  `tail`/`head`**: it destroys the failing evidence, and a pipeline's exit status is
  the *last* command's, so a red can land as a green.
- "It compiles" is never "it passed."

## Parallel writers
- At most **two** writing agents in flight, each in its **own worktree** under
  `<repo>/worktrees/<slice>`, based on `origin/main` — never on local `main`.
- Every read/edit/write/bash call uses an **ABSOLUTE** path under the writer's
  worktree. A relative path edits the **main** tree.
- A shared file means **SERIALIZE**. Prove disjointness by *reading* the first
  writer's worktree, not by predicting it.
- Commit the coherent partial state; never leave work uncommitted. Report
  **BLOCKED** with evidence rather than drifting.
- Retire a writer's session, worktree **and** branch once its landing is verified.

## Host rules (bind unchanged)
- Never run a long check in the foreground in the session the operator talks to.
- Never poll. The completion notice *is* the wake event.
- A subagent runs its long check **in-turn** — its background jobs die with its turn.
- Never touch `~/.openclaw`.

## This project's traps
See `docs/STATE.md` §TRAP. Live ones: `dist/` is a stale duplicate of `public/`
(never edit it), and `MODERNIZATION.md` §1 describes the *pre-fix* revision.
