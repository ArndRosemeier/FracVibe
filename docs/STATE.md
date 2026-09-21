# FracVibe — STATE OF RECORD (the board)

> One screen, overwritten in place. Records are `field=value` so a query is a
> `grep`. **This board is checked, never believed** — every record names something
> checkable (sha, branch, worktree, session id, path). Read this first, then
> `MODERNIZATION.md` (plan of record) and `docs/DECISIONS.md` (why).

reconciled: origin/main=dea8a55 · local main=c6c87e2 (0 behind, 4 ahead) · 2026-09-21T08:27Z · by=session-f6d26a74-68de-4926-b4d3-16efb7ff2421 · host=load 0.34, MemAvailable 18.2GB, no orphan suite processes, :3000 free · registry=2 sessions under ~/.dsh/sessions/--home-administrator-projects-FracVibe--

## OWNER
OWNER | 2026-09-21 | decision=**push approved** — owner chose "Push all 5 commits to origin/main" | effect=Phase 0 + machinery land on `origin/main`; the deployed blank-canvas site is fixed
OWNER | 2026-09-21 | verbatim: *"I want this to be resilient and correct, you can take your time to achieve that state. You be the judge how to achieve this best."* | effect=standing mandate; the METHOD is the dispatcher's judgement and is written down in `docs/PLAN.md` | ledger row 6

## ⚠ BLOCKED — the owner-approved push cannot be performed from this host
BLOCKER | push-to-origin | the tip is gated and the owner approved it, but `git push origin main` → `fatal: could not read Username for 'https://github.com': No such device or address` (exit 128). Nothing is wrong with the repo. This host has **no** way to authenticate: no credential helper (local/global/system), no `GITHUB_TOKEN`/`GH_TOKEN` in the environment, no `~/.git-credentials`, no `~/.netrc`, `gh` is not installed, `~/.ssh` holds only `authorized_keys` (inbound) and no private key, and `ssh-add -l` reports "The agent has no identities" while `ssh -T git@github.com` → `Permission denied (publickey)`. **I did not look inside `~/.openclaw` for credentials** — it belongs to another platform and the standing rule is to stop and ask. Resolution needs the owner: credentials, a deploy key, or a push the owner performs. Until then `origin/main` stays at `dea8a55` and the deployed site stays broken.
DECISION | the campaign does NOT wait on the push. Writers base on **LOCAL `main`** — the true tip, which already carries the machinery — not on the stale `origin/main`. Recorded because the base sha in every brief will look wrong to a successor who only reads `origin/main`.
NEXT | when the push does become possible, push `main` (it is ahead of `origin/main` by a fast-forward) and re-verify with `git ls-remote origin refs/heads/main`.

## SESSION
SESSION | id=session-f6d26a74-68de-4926-b4d3-16efb7ff2421 | role=chief of staff (owner-designated) | state=active · idled after the first reconcile pass · goal frozen and paused by design
SESSION | id=session-d1525624-6f23-4803-837e-34a1adc80fea | role=predecessor: audit + Phase 0 | state=ended 2026-09-21T10:14Z · left no worktree, no branch, no lock behind (verified)

## IN-FLIGHT
IN-FLIGHT | row=S1 | writer=5e91b6a0-4e3a-4f91-926a-1f8ab91c5dfd | worktree=/home/administrator/projects/FracVibe/worktrees/s1-canvas | branch=feat/s1-canvas | base=c27e18c (LOCAL main — `origin/main` is stale, see BLOCKER) | state=dispatched 2026-09-21T08:32Z, no commit yet | scope=canvas + view truth (B4 resize/DPR + B9 WebGL-failure fallback and honest teardown + the single clamp path + a global error net) | files=public/{app.js,webglFractal.js,fractalViewer.js,fractal3d.js,index.html,styles.css}, tests/ | dispatched_by=session-f6d26a74 | verify=NOT YET — the dispatcher re-runs the gate at the writer's own sha and re-runs its injection before landing, then retires worktree+branch+session
PROBE | id=dc6f39f3-2a45-4f41-9234-9ce42b13394c | state=**CONSUMED** 2026-09-21 · report kept at `docs/PROBE-2026-09-21-seams.md` (validated at 9e8661e; code unchanged since c6c87e2) · agent deleted | findings=six defects the audit did not contain (⚠ in the report): `progress` frames are never applied, there is no `worker.onerror`, a bad `done` payload throws uncaught, 3D init failure leaves a black screen with both canvases hidden, there is no global error handler, and four state variables are dead | action=all six folded into the `docs/PLAN.md` slice table
NOTE | only ONE writer is in flight, and that is the campaign's serialization rule working: every slice touches `public/app.js` (docs/PLAN.md §2), so slices run one at a time unless a probe has PROVEN two footprints disjoint.

## LANDED
LANDED | row=machinery | sha=c6c87e2 | branch=main | verify=MY OWN at this sha: `bash scripts/gate.sh` exit 0 GREEN, 4 passed / 0 failed / 6.4s, MemAvailable 18616MB, raw log /tmp/fracvibe-gate/gate-full-c6c87e2-20260921T082802Z.log · plus the lock/tier/per-tree controls in GUARD below | scope=scripts/gate.sh (one gate command, atomic mkdir lock in the git COMMON dir shared across worktrees, two tiers), AGENTS.md, docs/BRIEF.md, docs/DECISIONS.md, .gitignore worktrees/, and playwright.config.js `reuseExistingServer: true → false` | retired=nothing (no writer was dispatched) | docs=this file, docs/DECISIONS.md rows 4–5
LANDED | row=Phase0 | sha=001cec9 | branch=main | commits=b83ecca,f9a016e,001cec9 | verify=MY OWN: `bash scripts/gate.sh` exit 0 GREEN, 4 passed / 0 failed / 6.2s, MemAvailable 18661MB, raw log /tmp/fracvibe-gate/gate-full-001cec9-20260921T082600Z.log (independently repeated, 6.4s, …082622Z.log) | scope=B1 dead element IDs that aborted module evaluation, B2 the off-screen 3D canvas, B3 the CPU render desync, plus the Playwright smoke suite | caveat=**LOCAL ONLY — not on origin/main** | docs=MODERNIZATION.md §2
NOTE | the predecessor's own evidence survives as /tmp/fv-a.log and /tmp/fv-b.log (both "4 passed", 2026-09-21T10:14Z). Corroborating, not durable, and superseded by the logs above.

## QUEUE
QUEUE | row=* | The sequenced campaign is `docs/PLAN.md` (slices S1–S6, with footprints, pins, order and the serialization rule). The rows below are the raw defect inventory it draws from — do not dispatch a row directly; dispatch its slice.
QUEUE | row=1 | push Phase 0 + machinery to origin/main | status=OWNER-APPROVED 2026-09-21, **BLOCKED on credentials** (see BLOCKER above) — not on the repo, and not on any missing work
QUEUE | row=B4 | WebGL canvas is never resized; both canvases size their buffer from CSS px, so everything is blurry on HiDPI | src=MODERNIZATION.md §2 B4
QUEUE | row=B5 | iteration cap mismatch: slider allows 2000, the fragment shader loops to 1024 → silently mis-coloured pixels above 1024 | src=MODERNIZATION.md §2 B5
QUEUE | row=B6 | worker abort is a no-op (the flag can only be set between jobs) | src=MODERNIZATION.md §2 B6
QUEUE | row=B7 | HTML injection via imported location names (`innerHTML`) | src=MODERNIZATION.md §2 B7
QUEUE | row=B8 | 3D colour cycling rebuilds the whole heightmap per frame | src=MODERNIZATION.md §2 B8
QUEUE | row=B9 | WebGL-init failure leaves a blank canvas; `WebGLFractalRenderer.destroy()` leaks programs/buffers/context | src=MODERNIZATION.md §2 fold-in
QUEUE | row=P1 | one fractal kernel in four copies (`fractalEngine.js` is dead, overridden by the worker) + duplicated type/palette maps | src=MODERNIZATION.md §3
QUEUE | row=P2 | Vite, `three` from npm, Node 24, lint/format/CI, ESM dev server | src=MODERNIZATION.md §4
QUEUE | row=P3 | `<dialog>` + a11y, pointer/touch input, persisted locations | src=MODERNIZATION.md §5

## TRAP
TRAP | `dist/` at the repo root is a byte-identical, UNTRACKED copy of `public/` (`diff -rq public dist` → no differences). Netlify publishes `public/`, so editing `dist/` changes nothing and looks like a no-op edit. Never edit it.
TRAP | `MODERNIZATION.md` §2 says the fixes live "in this working tree", but they are committed (`f9a016e`, `001cec9`); §1 is explicitly the PRE-fix revision. Read the sha, not the prose.
TRAP | `webServer.reuseExistingServer` was `true`: a server left behind by a dev session or another worktree gets reused, so a "green" suite can report on files the run never loaded. Now `false`, and the gate refuses on a busy `:3000` (exit 9). Do not "helpfully" restore reuse.
TRAP | A `git worktree add` checks out the COMMITTED tree. A control run from a fresh worktree against an uncommitted script silently tested nothing (rc=127) and still printed a reassuring line. Commit before you probe, and check the probe's own exit code.
TRAP | PARITY: the tier must come from what CHANGED, not from what is uncommitted. A diff against `origin/main` is EMPTY once everything is pushed, so "docs-only, skip the suite" can silently become a full run — or an unverified push.
TRAP | `netlify.toml` pins `NODE_VERSION = "18"` (EOL 2025-04-30). `command = ""` means nothing builds today, so it is latent, not live — it bites the moment a build step is added.
TRAP | Git history carries `node_modules` across ~14 commits (~1.2MB `.git`). Purging needs `git filter-repo` **and a force-push**; it is not needed for correctness. Never do it as a side effect of another landing.
TRAP | Every commit is authored by the placeholder `User <user@example.com>`; no `user.name`/`user.email` is set in this repo.

## GUARD
GUARD | one-gate | `bash scripts/gate.sh` is the only gate. The full tier takes an atomic `mkdir` lock at `$GIT_COMMON/fracvibe-gate.lock`, shared by every worktree; the compile tier reads nothing shared, so it takes no lock and runs alongside a peer's suite. Exit codes in-file and in AGENTS.md: 0 green · 1 red · 2 compile-only (suite did not run) · 9 refused (VOID) · 10 killed (VOID) · 64 usage.
GUARD | gate-controls | exercised 2026-09-21 at c6c87e2 — full green exit 0 · compile exit 2 (16 files parsed) · BUSY exit 9 with the winner's lock left INTACT · dead-owner stale lock reaped, then green · from a probe worktree: full exit 9 refused on the shared lock, compile exit 2 while that lock was held. Raw logs /tmp/fracvibe-gate/.
GUARD | per-tree | a syntax error injected into a probe worktree's `public/app.js` turned THAT worktree's compile gate RED while the main tree stayed green — so the gate gates the tree it lives in, and a worktree run cannot silently validate the main tree. (Control log /tmp/fracvibe-gate/gate-compile-c6c87e2-20260921T082745Z.log.)
GUARD | host-floor | the full tier refuses to start below 500MB `MemAvailable` (exit 10, VOID). Override with `GATE_MIN_AVAIL_MB`.
GUARD | wrong-tree | the gate refuses when `:3000` is already served (exit 9) rather than verifying another tree's files; `reuseExistingServer: false` is the second line of the same defence.

## RECOVERY
RECOVERY | a successor starts here, then runs: `git fetch && git rev-list --left-right --count origin/main...main`, `git worktree list`, `git branch -a`, and reads `MODERNIZATION.md`. Raw gate logs: /tmp/fracvibe-gate/.
RECOVERY | machinery that must exist before any dispatch is on disk as of c6c87e2: this board, `docs/DECISIONS.md`, `docs/BRIEF.md`, `scripts/gate.sh`, `AGENTS.md`. Established 2026-09-21 by session-f6d26a74.
RECOVERY | dispatcher errors made while establishing it, recorded rather than quietly corrected: (a) the full suite was run in the FOREGROUND of the operator's session once, having forgotten `GATE_TIER=compile` — 6.2s, harmless here, still a rule breach; (b) the first draft of `gate.sh` released the lock from an EXIT trap without checking ownership, so a REFUSED run would have deleted the winner's lock — fixed before use and covered by the BUSY control; (c) the first cross-worktree lock probe was VOID (see TRAP on `git worktree add`) and its "lock INTACT" line proved nothing, which was reported before the error was noticed.
