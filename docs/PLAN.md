# FracVibe — campaign plan: "resilient and correct"

Owner's words, 2026-09-21 (verbatim): *"I want this to be resilient and correct,
you can take your time to achieve that state. You be the judge how to achieve this
best."*

This file is the dispatcher's plan for reaching that state. It is written to be
acted on by a successor session: each slice names its intent, its footprint, its
pins, and its status. `docs/STATE.md` is the live board; this is the campaign.

---

## 1 · The bar (what the owner's words mean concretely)

**CORRECT.** For every reachable combination of controls — fractal type, iteration
cap, palette, 2D CPU / WebGL / 3D, any view — the pixels the user sees match one
mathematical definition. No renderer may silently disagree with another (the B5
class), and the UI readout must never diverge from what was actually rendered (the
B1/B3 class).

**RESILIENT.** No single failure leaves a blank canvas, a wedged UI, or an
uncaught exception. The named failure modes are: WebGL context creation failure,
WebGL context loss, worker error, cancelled/aborted work, malformed or hostile
imported JSON, window resize and display-density change, and 3D mode without a
usable GPU. Each must degrade to a *defined* behaviour, and that behaviour must be
the one the UI reports.

**PINNED.** Each behaviour above is pinned by a test in `tests/` that goes RED when
the behaviour breaks. A pin is only accepted with the writer's own control run
showing it red on a deliberately broken build (see `docs/BRIEF.md` §Verification).

**PROCESS.** Every slice lands through `bash scripts/gate.sh` at exit 0, keeps its
raw log, and updates this file's status column, `docs/STATE.md`, and
`docs/DECISIONS.md` in the same landing commit.

---

## 2 · Slices

Footprints are the *expected* touch set. **Sequencing is proven, not predicted**:
before dispatching a second writer, read the first writer's worktree and compare
footprints against reality.

| id | intent | footprint | pins (must go red when broken) | status |
|---|---|---|---|---|
| S1 | **canvas-truth** (B4+B9): the canvas is always the right size and the app never dies silently. Both canvases resize on `resize` and honour `devicePixelRatio`; WebGL context-creation failure falls back to CPU **and says so**; `destroy()` releases programs, buffers and the context; a lost context is recovered or downgraded. | `public/webglFractal.js`, `public/fractalViewer.js`, `public/index.html`, `public/styles.css`, `public/app.js`, `tests/` | a forced WebGL-creation failure still renders via CPU and surfaces a message; canvas backing store tracks `innerWidth * dpr`; toggling GPU↔CPU N times does not grow live GL objects | dispatched |
| S2 | **cancel-truth** (B6): cancellation actually cancels, and no stale result is ever applied. Worker is terminated and respawned (or jobs are sliced and yielded); results carry a generation id and stale ones are dropped. | `public/fractalWorker.js`, `public/app.js`, `tests/` | a cancel issued during a long job leaves no applied result from that job; rapid zooming never applies an out-of-order frame | queued |
| S3 | **kernel-truth** (B5+P1): one source of truth for the fractal. A single parameterised kernel plus one type/palette table, consumed by worker, main-thread and shader; the UI iteration cap and the shader loop bound derive from ONE constant; the dead override in `fractalEngine.js` is deleted. | `public/fractalEngine.js`, `public/fractalWorker.js`, `public/fractalEngineMain.js`, `public/webglFractal.js`, `public/colorSchemes.js`, `public/app.js`, `tests/` | at maxIter = the UI cap, GPU and CPU render the same set (pixel-difference below a stated threshold); raising the slider above 1024 cannot silently mis-colour | queued |
| S4 | **input-truth** (B7): hostile input is data, never markup. Imported locations are rendered with `textContent`/element construction, the imported shape is validated, and sizes are bounded. | `public/app.js`, `public/memoryRepository.js`, `tests/` | a location named `<img src=x onerror=...>` renders as literal text and executes nothing | queued |
| S5 | **cycle-truth** (B8): colour cycling rewrites only the geometry's colour attribute (or a shader uniform), never the mesh. | `public/fractal3d.js`, `public/webglFractal.js`, `public/app.js`, `tests/` | a colour-cycle tick does zero fractal evaluations (counted, not inferred) | queued |
| S6 | **hygiene**: remove the debug instrumentation (~15 `console.log` per interaction, the logging-only `MutationObserver`), replace `alert`/`confirm`/`prompt` with the existing non-modal UI, delete the dead files (`recursiveFractalVibe.js`, `recursiveFractalLetter.js`, `splashMandelbrotCurve.js`, the unlinked `styles/fractSplashFractalText.css`). | `public/app.js`, `public/index.html`, `public/styles/*`, deletions, `tests/` | no `console.log` on startup or interaction; no `alert`/`confirm`/`prompt` in the bundle | queued |

### Ordering rationale
S1 first: the app's core capability currently fails silently, and S1 establishes the
resize/DPR seam that every later slice renders into. S2 second: it is the resilience
of the interaction loop itself. S3 third: it is the structural fix that removes the
B5 class outright and makes later slices cheaper. S4 (security) and S5
(responsiveness) follow; S6 last, because it deletes files S3 and S5 may touch.

### The serialization rule
**Every slice touches `public/app.js`.** So S1–S6 SERIALIZE on that file. Two
writers run concurrently only when the probe has *proven* their footprints disjoint
— otherwise one writer at a time. There is no "probably disjoint".

---

## 3 · Explicitly out of scope for this campaign
WebGPU / `three/webgpu`, WASM/SIMD kernels, OffscreenCanvas, the TypeScript
migration, and the Vite/`three`-from-npm/Node-24 tooling move. They are recorded as
deferred in `docs/DECISIONS.md` rows 2–3 and are not needed to reach the bar. If a
slice proves one of them is *required* to be correct or resilient, that is a fork
for the owner, not a silent inclusion.

---

## 4 · Definition of done
The campaign is done when: every row above reads `landed`; the pins in the last
column all exist and have been shown red against a deliberately broken build; the
suite passes from a clean `origin/main` checkout; and `docs/STATE.md` names the
final verified sha. "It renders on my machine" is not done.
