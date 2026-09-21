# RENDERER CONTRACT — what a backend must satisfy for the capability ladder

**Status:** groundwork. This document is the interface a later wiring slice dispatches
against. It is derived from what the EXISTING code already requires, with `file:line`
anchors, and it marks which parts each backend already satisfies. **Nothing here is
wired into the live dispatch by this slice** — `public/capabilities.js` and
`public/webgpuProbe.js` are new, unwired files, and `public/app.js` is untouched.

**Why now.** `docs/STATE.md` NORTH-STAR (owner, 2026-09-21) makes the renderer a
capability ladder — WebGPU (compute) > WebGL + `OES_texture_float` (the perturbation
lane) > WebGL without float textures (plain, shallow) > CPU with WASM SIMD — where
each machine renders on the best tier it actually HAS, and the owner's
`FORK-RESOLVED` invariant forbids any timing-based or depth-based crossover. A ladder
needs a single interface to dispatch through. Today there is none: the live choice is
a checkbox plus a failure flag (`public/app.js:1398-1409`, `app.js:1415-1428`), and
"the renderer" is really TWO shapes — a synchronous GPU draw and an asynchronous
CPU worker pipeline — that happen to share `viewer.view`.

---

## 1 · The contract, in one table

| # | Element | Contract | Anchor |
|---|---------|----------|--------|
| C1 | **Construction** | A backend is constructed with a `<canvas>` that is **already attached to the DOM**. A canvas that is null, unattached, or cannot produce its device must throw and clean up after itself (no half-live backend). | `webglFractal.js:34-105` (throws at `:86-91`, `destroy()` in the catch at `:102`); CPU viewer `fractalViewer.js:10-56`, canvas wired at `app.js:20,32` |
| C2 | **Capabilities** | A backend must be able to say what it needs and what it got, without a caller guessing: float-orbit transport, the iteration cap it can honour, and the depth lane it will use. | WebGL reports `hasFloatTexture`, `maxOrbitWidth`, `shaderMaxIter` (`webglFractal.js:115-116,446-451`); the ladder-wide detector is `public/capabilities.js` |
| C3 | **draw(view, maxIter, fractalType, juliaParams)** | One call draws one whole frame. `view = {centerX, centerY, scale}`, optionally `{centerXExact, centerYExact}` as decimal strings for an arbitrary-precision centre. `maxIter` is the **effective budget** (already clamped by `FractalKernel.clampMaxIter`). `fractalType` is the **kernel table index** (`FractalKernel.indexForType`), never a literal. `juliaParams` is `{c:[cx,cy]}` and is only passed for Julia. A draw after `destroy()` is a no-op, never a throw. | GPU: `webglFractal.js:742-744` → `draw(...)` `:789-881`; app call site `app.js:1372-1381`; exact-centre handling `webglFractal.js:822-836`; no-op guard `:792` |
| C4 | **Canvas / backing-store sizing** | The backing store is `CSS size × devicePixelRatio`, in DEVICE pixels; CSS size is the canvas box (`100vw × 100vh`). The app owns the ONE resize path and calls the backend's `resize`; a `display:none` canvas has a zero-sized box, so the size is read from the window, not the element. | `app.js:1105-1126` (`resizeRenderers`), `:1123-1124`; `webglFractal.js:558-573`; `fractalViewer.js:60-80`; the `display:none` reason is written at `fractalViewer.js:71-74` |
| C5 | **A progressive frame** | The CPU backend does not produce "a frame"; it produces a **sequence** of frames for one job: one full-size buffer of `Float32Array` **smooth escape values**, one frame per grid step `8 → 4 → 2 → 1`, with **`NaN` marking not-yet-calculated cells**. Every intermediate frame is a COPY; only the final frame transfers its buffer. Frames carry the job's `calcToken` and grid step, and a stale frame (wrong token, retired worker generation) is DROPPED, never painted. | `fractalWorker.js:31-72` (levels `:39`, NaN buffer `:43-48`, per-level post `:60-70`, transfer `:69`); application `app.js:861-903` (token/generation guard `:866-867`, `NaN`/length validation `:874-881`, **the JOB's own cap** `:887`) |
| C6 | **Orbit supply and keying** | An orbit is supplied per VIEW, computed once, cached on an identity key, and shared back to the CPU reference path. The transport is backend-specific. WebGL float64 orbit: key `(centerX, centerY, maxIter)`, one RGBA float **texel per iteration**, width `min(MAX_TEXTURE_SIZE, MAX_ITER)` — a hard texture cap. The arbitrary-precision orbit: key `(centerXExact, centerYExact, maxIter, bits)` in `BigOrbit.orbitKey`, computed in ONE long-lived classic Worker, and while a request is in flight the draw MUST fall back to the float64 lane so the canvas is never blank. | WebGL `webglFractal.js:587-621` (key `:590`, width `:594`, `MAX_TEXTURE_SIZE` cap `:116`), observation `:625-633`; BigInt `webglFractal.js:645-725` (key `:650`), `bigOrbit.js` `orbitKey`, `orbitWorker.js:1-9`; fallback `webglFractal.js:824-836`; ready re-render `app.js:1283-1285`; P2's contracts: `docs/DECISIONS.md` rows 38–41 |
| C7 | **Error / context-loss signalling** | A backend must have ONE failure exit that (a) reports the reason through the page's non-modal `#appMessage` surface, and (b) leaves the app on a REAL CPU render rather than a blank canvas. A lost device/canvas must be distinguishable from a normal teardown, must NOT re-fire for a canvas already replaced, and a replaced canvas must be swapped in so a later re-entry can obtain a fresh device. | `app.js:1320-1336` (`handleWebGLFailure`), `:1340-1351` (`handleWebGLLoss`), the listener `:1433-1445` (`preventDefault` + "only the ACTIVE canvas" guard `:1441`), element swap `:1087-1099`; render-throw catch `:1382-1384`; worker failure + bounded retry `app.js:781-797`, ready handshake `fractalWorker.js:74-80` |
| C8 | **destroy()** | Idempotent. Releases EVERY resource the backend allocated (programs, shaders, buffers, textures, worker) and releases the device/context itself, so a toggle cannot leak a context. A teardown the app initiated must not be reported as a context loss. | `webglFractal.js:883-932` (idempotence `:886`, resource release `:892-909`, `WEBGL_lose_context` `:906-909`, orbit Worker `:914-917`); caller `app.js:1298-1306` |
| C9 | **Accounting (observability)** | A backend contributes to the app's observation surface so "it was destroyed" / "it drew" is COUNTED rather than inferred from pixels: live-instance count, lane/orbit-source, and any counters a pin asserts. This is not optional in this project — every slice's pins read it. | `window.__fvLiveWebglRenderers` (`webglFractal.js:16-20`, read at `app.js:1474`); `webglFractal.js` observables `usePerturbation`/`orbitSource` (`:820-836`), `orbitComputations` (`:620`), `getOrbit` (`:625`), `getBigOrbitInfo` (`:730`), shader introspection (`:446-459`); the suite surface `window.__fv` `app.js:1455+` |

**Deliberately NOT part of the contract:** which engine is chosen (that is the ladder's
job, `public/capabilities.js` + a later dispatch slice), how the frame is coloured
internally, and whether a backend is synchronous. C3's signature is what a GPU backend
satisfies **synchronously**; a CPU backend satisfies the same *intent* asynchronously
via C5 + `viewer.setData`. A dispatch layer must therefore model "request a frame",
not "call draw and get pixels".

**The precondition on adding a third backend** (`docs/DECISIONS.md` row 52): the
expensive math — the reference orbit (`public/bigOrbit.js`), the budget rule
(`fractalKernel.js`), rebasing/glitch rules, the colour mapping — must stay in
ENGINE-NEUTRAL modules that every backend consumes, so a WebGPU backend is a new
*scheduler* over shared math and not a second implementation of it. The two new files
in this slice follow that pattern deliberately: `public/capabilities.js` and
`public/webgpuProbe.js` both have no `import`/`export`, publish one frozen global, and
are loadable as a classic script AND as an ES module (row 14). Adding a WebGPU backend
does NOT retire the WebGL one — WebGL is the tier that covers the machines WebGPU
cannot reach (row 51; this host is one of them by default).

---

## 2 · Satisfaction matrix

| Contract | CPU (`FractalViewer` + `fractalWorker`) | WebGL (`WebGLFractalRenderer`) | WebGPU (probe — NOT a backend) |
|---|---|---|---|
| C1 construction | ✅ `fractalViewer.js:10-56` | ✅ `webglFractal.js:34-105` | ⚠️ probe creates a device, no canvas-bound object |
| C2 capabilities | ⚠️ implicit (kernel cap, one worker) | ✅ `:115-116,446-451` | ✅ device limits reported (`webgpuProbe.js` `runProbe`) |
| C3 draw | ❌ async: `setView`/`setData` (`fractalViewer.js:104-120`), not a draw call | ✅ `:742-744` | ⚠️ `runProbe` computes a frame, but has no `view`/type/Julia surface and no colour-scheme selection matching the app's |
| C4 sizing | ✅ `fractalViewer.js:60-80` | ✅ `:558-573` | ❌ probe uses explicit width/height options |
| C5 progressive frames | ✅ `fractalWorker.js:31-72` + `app.js:861-903` | ❌ ONE synchronous full-resolution pass (`app.js:1353-1390`) — the owner's `FORK-RESOLVED` row requires coarse-to-fine on the GPU path and it is **still to build** | ❌ none |
| C6 orbit keying | ✅ consumes the same `view`; no orbit of its own | ✅ float64 + BigInt keys (`:587-725`) | ⚠️ builds its own float64 orbit; no shared cache, no Worker, no exact-centre path |
| C7 error/loss | ✅ worker `onerror` + bounded self-heal (`app.js:781-797`) | ✅ `app.js:1320-1351,1433-1445` | ❌ no `device.lost` / `uncapturederror` integration (the probe listens to `uncapturederror` only for its own diagnostics) |
| C8 destroy | ⚠️ no explicit `destroy()`; worker terminated by the app | ✅ `:883-932` | ❌ device destroyed at the end of one probe call |
| C9 accounting | ✅ `appliedFramesByJob`, `colorTableBuilds`, … (`app.js:1455+`) | ✅ `:16-20` + lane observables | ⚠️ returns a report object; contributes nothing to `window.__fv` |

**Read this honestly:** the WebGPU column is a FEASIBILITY EXPERIMENT, not a backend.
It proves the two platform wins and nothing else (see §4). The wiring slice must build
C5, C7, C8 and C9 for WebGPU before it may be dispatched to.

---

## 3 · What the ladder's dispatch needs as INPUT

`public/capabilities.js` answers the machine question and nothing else. Its report is
the only legitimate input to a tier decision:

- `webgpu.status` ∈ `absent` | `api-present-no-adapter` | `adapter-available`, with
  `adapterInfo`, `features` and `limits` when an adapter was actually **granted**.
  **`navigator.gpu !== undefined` is NOT sufficient** — this host is
  `api-present-no-adapter` by default, and a secure context is required
  (`docs/STATE.md` `MEASURED ... WebGPU availability`).
- `webgl2`, `webgl1`, `oesTextureFloat`, `maxTextureSize` — the WebGL rungs, where
  `maxTextureSize` (8192 here) is the orbit cap at `webglFractal.js:116`.
- `hardwareConcurrency`, `wasm`, `wasmSimd` (feature-tested against a real SIMD
  module), `sharedArrayBuffer`, `crossOriginIsolated` — the CPU rung's multipliers.
- `selectTier(report)` returns `webgpu` **only** from the awaited
  `adapter-available`, else the WebGL rung, else `cpu`. It never reads
  `navigator.gpu`.

## 4 · What the WebGPU probe did and did NOT establish (measured, same commit)

`public/webgpuProbe.js` + `tests/webgpu-feasibility.spec.js`, run under a dedicated
`/tmp` config with `--enable-unsafe-webgpu --enable-features=Vulkan,WebGPU`. On THIS
host the adapter is **`google / swiftshader` — a SOFTWARE adapter** (the same
SwiftShader as the WebGL lane), so every millisecond is a software number and says
nothing about real hardware (`docs/DECISIONS.md` row 47).

- **Storage-buffer orbit past the texture cap — PROVEN.** `maxStorageBufferBindingSize`
  = 134 217 728 B (128 MiB) → 16 777 216 orbit samples, against WebGL's 8192 texels. A
  20 001-entry orbit storage buffer (160 008 B) was read in a compute pass at every
  index up to 20 000 and returned **byte-for-byte** (0 mismatches; index 8192 →
  `[8192, 4096]`, index 20000 → `[20000, 10000]`). A perturbed pass with a
  non-escaping (inside-the-set) reference reads orbit index **20 000**.
- **A real escape-time frame — PROVEN.** 96×96 perturbed frame at scale 1e-12 with the
  shipped recurrence, rebasing and rescaling: 715 distinct escape values, 0/9216
  misclassified against a float64 reference, mean |Δ escape index| 5.89, and **pixels
  read back through `getImageData` after `putImageData`** (121 distinct colours).
- **NOT established:** any performance superiority. On this host's software adapters
  the WebGPU compute pass measured **≈ 188–201 ms/frame vs WebGL ≈ 137–176 ms/frame**
  on the same view (160×120, scale 1e-8, cap 2048) — i.e. WebGPU was **slower** in
  both runs. That is a software-adapter observation, not a verdict on hardware; no
  timing claim is asserted by the spec.

## 5 · Gaps a wiring slice must close (do not pretend they are done)

1. **A dispatch seam.** `renderFractal()` (`app.js:1415-1428`) chooses WebGL-by-checkbox
   vs CPU. The ladder needs one capability-derived default and the no-crossover
   invariant (`docs/STATE.md` `FORK-RESOLVED`), with the manual checkbox retained as
   the owner chose.
2. **A WebGPU backend object** satisfying C1–C9: canvas-bound, `draw(view, maxIter,
   fractalType, juliaParams)`, `resize`, `destroy`, `device.lost` →
   `handleWebGLLoss`-equivalent, and the C9 observables.
3. **The orbit cache shared, not duplicated.** `bigOrbit.js` already computes the
   arbitrary-precision orbit; a WebGPU backend must consume it (C6) rather than
   recompute it, and must fall back to the float64 lane while a request is in flight.
4. **Progressive GPU frames (C5).** The CPU path posts `8→4→2→1`; the GPU path draws
   one pass. The owner's `FORK-RESOLVED` row requires coarse-to-fine on the GPU with
   zoom possible mid-render (a superseded job must stay cheap).
5. **`window.__fv` equivalents** for the new backend, because every pin in this project
   reads a counted observable rather than inferring from pixels (C9).
6. **Math parity across three engines.** `docs/DECISIONS.md` row 49 records that the
   existing CPU/GPU parity pins cover SHALLOW scale only; a third engine does not make
   that gap smaller, and deep cross-engine agreement remains unverified.

## 6 · What this slice deliberately did NOT do

- No change to `public/app.js`, `public/webglFractal.js`, `public/fractalKernel.js`,
  `public/bigOrbit.js` or any existing test — another writer is mid-flight in
  `app.js`/`webglFractal.js`, so this slice is additive and trivially mergeable.
- No WebGPU tier in the live dispatch, no capability-based default, no UI.
- No performance claim, and no crossover (owner invariant).
