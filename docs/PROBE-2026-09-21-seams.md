# PROBE — render / state / duplication map (read-only evidence)

- **Probe:** subagent `dc6f39f3-2a45-4f41-9234-9ce42b13394c`, read-only (no writes, no suite run)
- **Validated against:** HEAD `9e8661e`, working tree clean. Code is unchanged since `c6c87e2`, so these line numbers hold for every sha from `c6c87e2` onward.
- **Why kept:** this is the seam map every campaign brief draws its anchors from (`docs/PLAN.md`). It is evidence, so it lives on disk rather than in a session thread.
- **Corrections found beyond `MODERNIZATION.md`** are marked ⚠.

## Flows

| flow | function(s) | file:line range | duplicated / patched / global-state notes |
|---|---|---|---|
| 1 View state (scale/center) | `FractalViewer.view` init; direct writes; `panView`/`zoomView` | `fractalViewer.js:11,63-71`; `app.js:213,448,653`; reads `app.js:36-38,314` | Single `viewer.view` object is the only state; `app.js` mutates `.scale` directly (213 init 300, 448 anim, 653 render-clamp) and other modules cannot reach it. |
| 1a Clamp: setView patch #1 | anonymous `viewer.setView =` wrapper | `app.js:221-241` (cap 216-217) | Monkey-patch of `FractalViewer.prototype.setView` (`fractalViewer.js:36-39`); **overwritten at 437→601**, so dead after startup. |
| 1b Clamp: setView patch #2 | re-assigned inside `updateWebGLState` | `app.js:601-623` | Third copy of the same logic, in a different form (`1/view.scale > maxZoom` vs `view.scale < WEBGL_MIN_SCALE`); re-installed on every GPU entry; calls the patched `this.render()`. |
| 1c Clamp: render-time | `renderWebGL` | `app.js:651-665` | Mutates `viewer.view.scale` in place (not a copy); the info display is not refreshed. |
| 1d Clamp: dead wheel guard | `FractalViewer.prototype.onWheel` | `fractalViewer.js:116-121` | Can never fire — `WEBGL_MIN_SCALE`/`webglCheckbox` are module-locals of `app.js`, so the `typeof` guard is always `undefined`. |
| 1e Clamp: 3D camera | `Fractal3DViewer.onWheel` | `fractal3d.js:238-243` | Separate orbit-radius clamp (`minRadius`/`maxRadius`, 43-44); unrelated to 2D scale. |
| 1f Clamp: startup anim | `animateZoom` IIFE | `app.js:440-463` (clamp 448) | Bypasses `onViewChange`; calls `viewer.setView` + `updateInfo` per frame. |
| 2 Render trigger CPU | `render`, `setData`, `setColorScheme`, `setColorOffset`; `triggerFractalRender`; `onViewChangeHandler` | `fractalViewer.js:41-55,127-159`; `app.js:401-409,422-432,485,489,564` | `viewer.render` itself monkey-patched at `app.js:697-707` to divert to WebGL. Trigger sites at `app.js:182,188,327,430,459,489,564,692`. |
| 2 Render trigger WebGL | `renderWebGL` | `app.js:648-680` | Called from 11 sites (178,186,404,510,530,548,629,690,701,712); no menu/dispatch — every caller checks `webglCheckbox.checked` itself. |
| 2 Render trigger 3D | `enter3DMode` → `Fractal3DViewer.init`/`regenerateMesh`/`animate` | `app.js:291-311,492-501`; `fractal3d.js:66-102,114-174,275-303` | Own rAF loop, own resize/orbit/key listeners; `init()` is async and never awaited (`app.js:295`); reads state via the `getFractalParams` closure (`app.js:281-289`). |
| 3 Worker dispatch | `startFractalCalculationWithTiming` → `startFractalCalculation` → `sendProgressiveJob` | `app.js:276-279,330-360` | `worker` created at 245; the job object is copied per refine; 9 dispatch entry points (327,428,459,485,489,564,182/188,692). |
| 3 Progressive refinement | worker chunk loop; `app.js` gridStep halving | `fractalWorker.js:11-38,42-100`; `app.js:369-379` | ⚠ The worker emits `progress` (`fractalWorker.js:26-28,33`) but `worker.onmessage` handles only `'done'` (`app.js:365`) → **partial frames are never applied**; only the gridStep=1 result lands. Kernel duplicated 4×: `fractalEngine.js:13-72` (dead — overridden by `fractalWorker.js:42`), `fractalWorker.js:42-100`, `fractalEngineMain.js:4-63`, GLSL `webglFractal.js:44-93`. |
| 3 Abort/cancel | `worker.postMessage({type:'abort'})`; `abortFlag` | `app.js:424`; `fractalWorker.js:6-9,25,29,35` | No-op per B6 (a synchronous loop cannot receive a message); invalidation really happens via `calcToken` (`app.js:248,336,359,364,426`). No `worker.terminate()`/respawn anywhere. |
| 3 Apply results | `worker.onmessage` → `viewer.setData` | `app.js:362-383`; `fractalViewer.js:41-45` | ⚠ No try/catch around `new Int32Array(e.data.result)` (367); ⚠ no `onerror` at all; ⚠ `currentResult`/`aborting`/`debounceTimer`/`lastJobParams` (246-250) are declared and never read. |
| 4 Saved save/load/export/import | `getCurrentLocationState`, save handler, `renderSavedLocations`, export/import handlers | `app.js:32-44,46-65,79-126,128-209` | List rendering, load-apply, delete and sort all live inside `renderSavedLocations` (128-209); the load handler calls `setView` 3× and re-renders 2-3× (172-189). |
| 4 Saved list render | `renderSavedLocations` | `app.js:128-209` (`innerHTML` 151) | `innerHTML` interpolates imported `loc.name` (B7); ⚠ no schema validation on import; `memoryRepo` is a module singleton (`app.js:21`, `memoryRepository.js:2-35`), session-only. |
| 5 WebGL init | `updateWebGLState` setTimeout → `new WebGLFractalRenderer` | `app.js:580-646` (init 624-638); `webglFractal.js:3-20,22-206` | Canvas sized in CSS px at 599-600 *before* context creation; `_debugObserver` MutationObserver left installed (586-595). |
| 5 WebGL teardown | `webglRenderer.destroy`; CPU branch | `webglFractal.js:237-240`; `app.js:643` | `destroy()` only nulls `gl`; program/buffer/context leaked on every GPU↔CPU toggle; no `WEBGL_lose_context`; `renderWebGL` never guards a destroyed renderer. |
| 5 Resize | `app.js` resize listener; `FractalViewer.resize`; `Fractal3DViewer.onResize` | `app.js:487-490`; `fractalViewer.js:21,24-28`; `fractal3d.js:85,268-273` | `canvasWebGL` is **never resized** (B4) — only sized at `app.js:599-600`; resizing also re-dispatches a full worker job (489); two independent 2D resize listeners (`app.js:487`, `fractalViewer.js:21`). |
| 5 devicePixelRatio | — | no occurrence in `public/*.js` | Buffers = `innerWidth`/`innerHeight` CSS px in all three renderers (`fractalViewer.js:9-10,25-26`; `app.js:599-600`; `fractal3d.js:83,272`); no `setPixelRatio`, so HiDPI is blurry. |
| 6 Module-level mutable `app.js` state | top-level `const`/`let` singletons | `app.js:8-30,216-219,245-275,568` | `viewer` 19, `memoryRepo` 21, `worker` 245, `progressiveState` 262, `webglRenderer` 264, `fractal3D` 253 / `in3DMode` 254, color-cycle 256-259, timing 271-275, zoom-cap flags 218-219, DOM refs 8-17/22-30. Closures (`getFractalParams`, `onViewChangeHandler`, `colorCycleLoop`, the monkey-patch wrappers) capture all of them — this is the actual extraction boundary. |

## User-facing failure paths

| failure path | file:line | current behaviour |
|---|---|---|
| Malformed imported JSON | `app.js:104-119` | `try/catch` → `alert('Error importing locations: ' + err.message)`; non-array → `alert('Invalid file format.')`. ⚠ No per-record validation, so bad `scale`/`id` are accepted. |
| Imported `loc.name` HTML injection | `app.js:151` | `innerHTML` with an unescaped name (B7) → arbitrary markup/script injection from a file. |
| WebGL context / shader creation failure | `app.js:627-637`; `webglFractal.js:7,11,17,168,174,182` | `alert('WebGL is not supported…')`, unchecks the box, hides the WebGL canvas, calls `viewer.render()` but ⚠ **never starts a CPU calc** → blank `#222` canvas (`fractalViewer.js:128-131`). |
| WebGL error after init | `app.js:648-680` | No try/catch in `renderWebGL`; GL errors / a null renderer throw uncaught (only 650 early-returns). |
| Worker script load / runtime error | `app.js:362-383` | ⚠ No `worker.onerror` at all → silent; a worker failure is invisible and the canvas keeps its last frame. |
| Worker `done` with a bad payload | `app.js:367` | ⚠ `new Int32Array(undefined)` throws inside the event handler, uncaught → render frozen, no message. |
| Worker abort | `app.js:424`; `fractalWorker.js:29-38` | Cancel silently ignored (B6); the stale job runs to completion and its result is dropped by `calcToken`. |
| Zoom-cap decision | `app.js:230,611,657` | Triplicated `window.confirm`; a denial sets `deniedCpuSwitchAtZoomCap` and zoom clamps silently; no UI feedback. |
| 3D init failure | `app.js:295`; `fractal3d.js:81` | ⚠ `fractal3D.init()` promise unhandled; `new THREE.WebGLRenderer` unguarded; both canvases are already hidden (`app.js:298-299`) → black screen, no message. |
| 3D mesh regeneration | `fractal3d.js:114-174` | No error handling; synchronous `calculateHeightmap` (`fractalEngineMain.js:4-63`) blocks the main thread at up to 4096²; the progress bar can stick if it throws. |
| Save-location name prompt | `app.js:49` | `window.prompt`; cancel (`null`) returns cleanly (50); no other failure handling. |
| Export locations | `app.js:79-92` | No try/catch (Blob/URL creation); failures throw uncaught. |
| `renderSavedLocations` | `app.js:128-209` | No try/catch; the empty list is handled (132-137); imported records with missing fields show `NaN`/`undefined` instead of an error. |
| Global diagnostics | `app.js`; `webglFractal.js:6,10,16,233` | ⚠ No `window.onerror` / `unhandledrejection`; failures only reach `console`/`alert`; ~15 debug `console.log`s remain on hot paths. |

## Highest-value seams (what a resilience refactor must change)
- `viewer.setView` + `viewer.render` monkey-patches and their re-installation in `updateWebGLState` (`app.js:221-241`, `601-623`, `697-707`); fold clamping into `FractalViewer.setView`/`onWheel` (`fractalViewer.js:36-39`, `112-125`) and delete the dead guard at `117-121`.
- `renderWebGL` (`app.js:648-680`) + `updateWebGLState` (`app.js:580-646`) + `WebGLFractalRenderer.destroy` (`webglFractal.js:237-240`): resize, `devicePixelRatio` and real teardown all land here.
- `startFractalCalculation` / `sendProgressiveJob` / `worker.onmessage` (`app.js:330-383`) + `fractalWorker.js:5-39`: abort, token matching, dropped `progress` frames, the missing `onerror`.
- `renderSavedLocations` (`app.js:128-209`) + import (`94-126`): duplicate render/apply calls, the `innerHTML` sink, absent schema validation.
- `colorCycleLoop` (`app.js:517-533`) → `Fractal3DViewer.setColorOffset`/`regenerateMesh` (`fractal3d.js:183-186`, `114-174`): a full heightmap rebuild per animation frame (B8).
- The module-level singleton block `app.js:8-30,216-219,245-275`: the real `app.js` extraction boundary.
