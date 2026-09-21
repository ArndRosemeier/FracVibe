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
| S1 | **canvas + view truth** (B4+B9): the canvas is always the right size and the app never dies silently. Both canvases resize on `resize` and honour `devicePixelRatio`; WebGL context-creation failure falls back to CPU **and says so**; `destroy()` releases programs, buffers and the context; a lost context is recovered or downgraded; the zoom clamp exists **once** (folded into `FractalViewer.setView`/`onWheel`) and the monkey-patches plus the dead wheel guard are deleted; a global `window.onerror`/`unhandledrejection` net surfaces anything that still escapes. | `public/webglFractal.js`, `public/fractalViewer.js`, `public/index.html`, `public/styles.css`, `public/app.js`, `tests/` | a forced WebGL-creation failure still renders via CPU and surfaces a message (today: blank `#222`); a canvas backing store equals CSS size × `dpr` at `deviceScaleFactor: 2`; GPU↔CPU toggled N times leaves one live context, not N; a zoom past the cap clamps **identically** whether reached by wheel, by the startup animation, or at render time | **landed & verified** at `cea74cb` — dispatcher gate exit 0, 15 passed; pins in `tests/canvas-dpr.spec.js`, `tests/webgl-fallback.spec.js` (incl. the REAL `webglcontextlost` event), `tests/zoom-clamp.spec.js` |
| S2 | **worker truth** (B6 + silent worker failure + wasted refinement): cancellation actually cancels and no stale result is applied; the worker is terminated and respawned (or jobs are sliced and yielded); results carry a generation id; `progress` frames are **applied** (today they are computed and discarded) or the halving is deleted as waste; `worker.onerror` exists and surfaces; a malformed payload cannot throw uncaught. | `public/fractalWorker.js`, `public/app.js`, `tests/` | a cancel during a long job applies no result from that job; a worker that throws produces a visible message, not a frozen canvas; a `done` with a bad or empty payload is rejected with a message and never becomes a frame (**the brief's claim that `new Int32Array(undefined)` throws was FALSE** — it yields an empty array; see the probe report's CORRECTIONS); a slow render shows intermediate frames | **landed & verified** at `63f19c8` — dispatcher gate exit 0, 19 passed, and the dispatcher's probe removed all four stale-frame nets and turned the cancel pin RED, so that pin is not vacuous. Pins in `tests/worker-lifecycle.spec.js`. Judgement calls in `docs/DECISIONS.md` rows 10–13: **terminate-and-respawn** over slicing; progress frames **APPLIED** (halving kept, made real); the net that stops a late frame is the `progressiveState` clear on cancel, with the `calcToken`/generation checks as defence in depth. Also corrected: `terminate()` is **not** a synchronous preemption (measured). |
| S3 | **kernel truth** (B5+P1): one source of truth for the fractal. A single parameterised kernel plus one type/palette table, consumed by worker, main-thread and shader; the UI iteration cap and the shader loop bound derive from ONE constant; the dead copy `fractalEngine.js` and the worker's inline override are deleted. | `public/fractalEngine.js`, `public/fractalWorker.js`, `public/fractalEngineMain.js`, `public/webglFractal.js`, `public/colorSchemes.js`, `public/app.js`, `tests/` | at maxIter = the UI cap, GPU and CPU render the same set (pixel difference below a stated threshold); raising the slider above 1024 cannot silently mis-colour | **landed & verified** at `590945c` — dispatcher gate exit 0, **25 passed / 53.4s**, and the dispatcher's own injection (the `u_maxIter` uniform pinned to 100 while the cap stayed 2000) turned pin 1 RED at mean \|Δ\| 6.53 while pin 2 stayed GREEN. One kernel at `public/fractalKernel.js` (`MAX_ITER = 2000`), no `import`/`export` so the classic worker and the ES-module main thread load the same file; `public/fractalEngine.js` and `public/fractalEngineMain.js` deleted, the worker's inline override deleted, the shader templated with `#define MAX_ITER`/`FT_*`/`CS_*` from the kernel. Writer gate exit 0, **25 passed** (raw log `/tmp/fracvibe-gate/gate-full-cef6bcb-20260921T094303Z.log`). Pins in `tests/kernel-parity.spec.js`: GPU/CPU agreement at the cap (correct mean \|Δ\| 0.911; bound broken to 1024 → 82.56), slider max == cap == the templated `#define MAX_ITER` with all four loop sites bound to it, and type/palette index agreement per type (correct worst inside/outside disagreement 0.011; type-drifted 0.111; palette-drifted \|Δ\| 39.5–97.0). Judgement calls in `docs/DECISIONS.md` rows 14–17 |
| S4 | **input truth** (B7): hostile input is data, never markup. Imported locations are rendered with `textContent`/element construction, the imported **shape is validated per record**, and sizes are bounded; the load path stops calling `setView` three times and re-rendering two to three times. | `public/app.js`, `public/memoryRepository.js`, `tests/` | a location named `<img src=x onerror=…>` renders as literal text and executes nothing; a record with a missing/NaN `scale` or `id` is rejected with a message, not rendered as `NaN` | **landed & verified** at `55eada7` — the branch was already based on `main`, so the gated sha IS the landing sha: dispatcher gate exit 0, **35 passed / 1.5m**, and the dispatcher's own injection (the ONE shared escaping helper flipped back to `innerHTML`) turned all three hostile-render pins RED. One schema in `public/memoryRepository.js` (`LOCATION_LIMITS`, `validateLocation`, `validateRecords`), consumed by the ONE import path `app.js:143` (`importLocationsPayload` → `importLocationsObject`); the `innerHTML` sink that was `app.js:180` is DELETED in favour of five `textContent` writes (`appendLocationInfo` `app.js:275`, `formatLocationTimestamp` `app.js:270`); malformed JSON and every reject go through `#appMessage`, never `alert`; the load path applies once and renders once (`applyLoadedRecord` `app.js:243`), counted by `window.__fv.lastLoad()`; `memoryRepository.getAll()` sorts total and non-throwing. Pins in `tests/import-validation.spec.js` (10 tests). Judgement calls in `docs/DECISIONS.md` rows 18–20 |
| S5 | **3D truth** (B8 + the 3D failure path): colour cycling rewrites only the geometry's colour attribute (or a shader uniform), never the mesh; `Fractal3DViewer.init()` is awaited and a failed or GPU-less init surfaces a message instead of a black screen with both canvases already hidden. | `public/fractal3d.js`, `public/webglFractal.js`, `public/app.js`, `tests/` | a colour-cycle tick performs zero fractal evaluations (counted, not inferred); with WebGL unavailable, entering 3D mode shows a message and restores the 2D canvas, not a black screen | **landed & verified at `3f473c8`** (dispatcher FULL gate exit 0, **39 passed / 1.8m**; the dispatcher's probe turns ONLY the new upload pin RED — 1 failed / 2 passed, so it is isolated), with ONE gap found by the dispatcher's probe and closed forward in the fix-forward commit: deleting `attr.needsUpdate = true;` (`fractal3d.js:168` pre-fix) left the values correct on the CPU array while the GPU mesh froze, and the palette pin still passed. Closed by a third pin — `window.__fv.colorAttributeVersion()` (`app.js:1290`) reads three.js `BufferAttribute.version`, which `needsUpdate = true` increments and `WebGLAttributes.update` re-uploads on (`three.module.js:1817,13525`); the version must advance across both an offset tick and a scheme change. Writer gate exit 0, **39 passed / 1.7m**. The ONE kernel call is `Fractal3DViewer.evaluateHeightmap()` (`fractal3d.js:130`, counted at `:131`, called only from `regenerateMesh` `:192`); the colour-only path is `applyColors()` (`:146`), which `setColorOffset` (`:238`) and `setColorScheme` (`:231`) call instead of rebuilding, from the cached `heightmap`/`heightMin`/`heightMax`. `enter3DMode()` is `async` (`app.js:512`), `await viewer3d.init()` (`:520`), and its catch reports through `#appMessage` (`:525`) after `restore2DFrom3D` (`:504`) puts the 2D canvas and pre-3D UI back; the 2D canvases are hidden only after a successful init. Pins in `tests/3d-truth.spec.js` (3) and `tests/webgl-fallback.spec.js:228`; controls A–D and the dispatcher's upload probe in the landing report. Judgement calls in `docs/DECISIONS.md` rows 21–24 |
| S6 | **hygiene**: remove the debug instrumentation (~15 `console.log` per interaction, the logging-only `MutationObserver`), replace `alert`/`confirm`/`prompt` with the existing non-modal UI, delete the dead state (`currentResult`, `aborting`, `debounceTimer`, `lastJobParams` — all declared, never read), and delete the dead files (`recursiveFractalVibe.js`, `recursiveFractalLetter.js`, `splashMandelbrotCurve.js`, the unlinked `styles/fractSplashFractalText.css`). | `public/app.js`, `public/index.html`, `public/styles/*`, deletions, `tests/` | no `console.log` on startup or interaction; no `alert`/`confirm`/`prompt` in the bundle; the deleted files are imported by nothing | **landed & verified** (base `origin/main` = `5537ca7`) — dispatcher FULL gate exit 0, **43 passed / 1.9m** (39 pre-S6 + 4 new pins). The audit-era anchors no longer described the survivors, so they were re-located rather than assumed: exactly **4** `[FractalMouse]` logs remained (`app.js:764` mousedown, `:768` wheel, `:780`/`:783` render trigger) and the logging-only `MutationObserver` was **already gone** (S1 deleted it — S6 confirms its absence; it was NOT removed here). The modal replacement: `window.prompt` → `#saveLocationPanel` (prefilled default; Save/Enter commits; Cancel/Escape stores nothing) and `window.confirm` → `#zoomCapOffer` (Switch to CPU / Stay on GPU, shown at most once, no `setTimeout` delay). The cap itself is unchanged in `FractalViewer.clampScale()`, so it applies on every path whatever the answer; `fv-zoom-limit`'s `prompted` still means exactly "the user was actually asked", now observable as a DOM fact via `__fv.zoomCapPrompted()`/`zoomCapOffered()`. The four dead state declarations and all four dead files are deleted (`git rm`; `git ls-files --error-unmatch` proves it). Pins in `tests/hygiene.spec.js` (4): zero app-origin console output over the scripted interaction; zero `alert`/`confirm`/`prompt` calls while both flows stay usable; dismissal keeps the cap and never re-asks; the four dead files are absent, untracked and served 404. Judgement calls in `docs/DECISIONS.md` rows 25–26 |

⚠-marked discoveries above come from the read-only probe whose report is kept at
`docs/PROBE-2026-09-21-seams.md` — six defects the audit did not contain, each with
`file:line`: `progress` frames never applied, no `worker.onerror`, an uncaught
`Int32Array` on a bad payload, 3D init failure → black screen, no global error
handler, and dead module state. Every brief draws its anchors from that file.

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
