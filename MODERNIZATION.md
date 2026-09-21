# FracVibe — project audit & modernization plan

- **Audited:** HEAD `dea8a55` (2025-04-16) + local commit `b83ecca` (node_modules untracked)
- **Method:** full source read (22 tracked files, ~2.3k hand-written lines + vendored three.js),
  then live checks: Express dev server smoke test, headless Chrome runs of the real app
  (`--headless=new` + CDP probe: DOM/pixel/console/exception capture), and targeted
  scratch-copy patches to isolate each defect. Every "verified" claim below is reproduced
  by an observed result, not by reading alone.
- **Phase 0 applied in this working tree:** B1–B3 are fixed and guarded by a Playwright
  smoke suite (`tests/smoke.spec.js`, run with `npm test`). §2 records the fixes and the
  control runs that prove the tests are not vacuous.
- Everything in §1 describes the **pre-fix** revision; §2–§4 list what is still open.

---

## 1. Verified state at HEAD (before the Phase 0 fixes)

| # | Check | Result |
|---|-------|--------|
| 1 | App loads at HEAD | **BROKEN.** `Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')` at `public/app.js:181`. Module evaluation aborts there, so nothing after line 181 runs: no worker, no WebGL init, no initial render, no control wiring. Canvas stays blank. |
| 2 | Root cause | `index.html` exposed `#loadLocationModal` / `#closeLoadLocationModal`, but `app.js:24-25` queried `#loadLocationSidebar` / `#closeLoadLocationSidebar`. Both returned `null`. The sidebar→modal refactor in `52eb176`/`e73fd2b` renamed the markup but not the JS. |
| 3 | App with only those 2 IDs renamed (scratch copy) | **Works.** WebGL path renders the Mandelbrot set, no page errors, `Render:` timing populated. |
| 4 | CPU/worker path, same scratch copy | Pipeline works (worker → `Int32Array` → LUT → 2D canvas), **but** the startup zoom animation never triggered a recalculation, so CPU mode showed a stale image computed at `scale≈300` until the user panned/zoomed. Probe: unpatched `Render: 4.7 ms` / 556 994 non-dark px (uniform) vs. patched-with-recalc `Render: 147.5 ms` / 504 806 non-dark px (set visible), both at `Zoom 0.33`. |
| 5 | 3D mode (`Space`) | **Invisible in the default (WebGL) mode.** The three.js canvas landed at rect `y=557` in a `557px`-tall viewport — entirely below the fold. Cause: `#fractalCanvasWebGL` was an in-flow `display:block` element with no CSS rule, and `enter3DMode()` hid only the 2D canvas. In CPU mode the same canvas is `display:none`, so the three.js canvas landed at `y=0` and 3D was visible → 3D mode was broken exactly when GPU rendering (the default) was on. |
| 6 | Express dev server | OK: `/` 200, `/three.module.js` 200 (1 225 243 B, uncompressed), unknown path 404. |
| 7 | Dependencies | `express@5.1.0` (matches `^5.1.0`), `lockfileVersion` 3, 67 packages. `npm audit`: 3 advisories (2 moderate, 1 high) in transitive `body-parser`/`path-to-regexp`/`qs` — all `npm audit fix`-able. |
| 8 | Repo hygiene | 22 tracked files, `.git` 1.2 MB, 17 linear commits, root `ee85768` (2025-04-15) introduced `node_modules` (599 files tracked; peak 621 tracked files). All commits authored by the placeholder `User <user@example.com>`. |

---

## 2. P0 — repairs (B1–B3 done, B4–B8 open)

**Status.** B1, B2 and B3 are fixed in this working tree (`public/app.js`,
`public/index.html`, `public/styles.css`) and covered by `tests/smoke.spec.js`
(`npm test`). Each test was validated against a control build that lacks the fix:

| Build | Tests 1–2 (B1) | Test 3 (B2) | Test 4 (B3) | Suite |
|-------|----------------|-------------|-------------|-------|
| HEAD (no fixes) | fail | fail (at the B1 guard) | fail (at the B1 guard) | 4 failed |
| HEAD + B1 only | pass | **fail: `rect.y = 700`** | **fail: 26 set pixels vs > 20 000** | 2 failed |
| working tree (B1–B3) | pass | pass | pass | 4 passed |

**B1. Dead element IDs crashed the app** (`app.js:24-25` vs `index.html:42,53`).
*Fixed:* the JS targets the real modal IDs; the JS-built sort row/list/footer (`app.js:67-177`
in the old file) was deleted in favour of the markup already in `index.html`, which gained
`#exportLocationsBtn` / `#importLocationsBtn` (the old code built those buttons from
scratch); the modal is opened with `display:flex` so it still centres.

**B2. 3D mode rendered off-screen whenever WebGL rendering was on.**
*Fixed:* `#fractalCanvasWebGL` now has the same full-screen positioned CSS layer as
`#fractalCanvas`, and `enter3DMode()` hides **both** 2D canvases; `exit3DMode()` restores
the correct one through `updateWebGLState()`. The underlying smell — two full-screen
canvases stacked in normal flow under an `overflow:hidden` body — is now explicit rather
than incidental.

**B3. Startup animation desynchronised the CPU renderer.**
*Fixed:* when the animation settles it now starts a recalculation (CPU mode only; GPU mode
re-renders from uniforms every frame anyway). The remaining wart — the animation drives
`setView()` at 60 fps instead of the normal view-change path — belongs to the Phase 1
consolidation below.

**B4. The WebGL canvas is never resized.** `window.resize` → `viewer.resize()` only touches
the 2D canvas, so `canvasWebGL` keeps its old buffer size and `u_aspect`/viewport go stale
after any window resize. Both canvases also size their buffer from `innerWidth/innerHeight`
(CSS px), so everything is blurry on HiDPI.
*Fixed (S1):* `FractalViewer.applyCanvasSize()` and `WebGLFractalRenderer.resize()` size both
backing stores to CSS size × `devicePixelRatio` on startup, on `resize` and on a DPR change;
`Fractal3DViewer.onResize()` now calls `setPixelRatio`. The two old 2D resize listeners are
one path in `app.js`. Pinned by `tests/canvas-dpr.spec.js`.

**B5. Iteration cap mismatch.** The slider allows 2000 (`index.html:33`) but the fragment
shader loops `for (int i = 0; i < 1024; i++)` (`webglFractal.js:52,63,74,85`). Above 1024,
GPU-rendered pixels are silently mis-colored as escaped. Make the loop bound a constant
shared with the UI cap, or clamp the slider per renderer.
*Fixed (S3):* the cap is now ONE constant, `MAX_ITER = 2000` in `public/fractalKernel.js`; the
slider's `max` is derived from it (`app.js:59`), and the fragment shader is **templated** —
`#define MAX_ITER <FractalKernel.MAX_ITER>` (`webglFractal.js:67`) — so its four loop sites
(`webglFractal.js:89,100,111,122`) and the `u_maxIter` uniform clamp share the kernel's bound by
construction. GPU==CPU at the cap is pinned by `tests/kernel-parity.spec.js` pin 1, and the
dispatcher verified that pin goes RED (mean |CPU−GPU| 6.53 vs the <6 threshold) when the uniform
is pinned to a different value. The anchors quoted above (`webglFractal.js:52,63,74,85`) were
already stale after S1; at `cef6bcb` the four sites were 71,82,93,104.

**B6. Worker abort is a no-op.** `fractalWorker.js` checks `abortFlag` inside a synchronous
`while` loop; the abort `postMessage` cannot be dispatched while that loop runs, so the flag
is only ever set *between* jobs. Cancel instead by `worker.terminate()` + respawn, by
`SharedArrayBuffer` + `Atomics`, or by slicing jobs and yielding.

**B7. HTML injection via imported locations.** `renderSavedLocations()` interpolates
`loc.name` into `innerHTML` (`app.js:208` pre-fix), and `loc` objects come from a
user-supplied JSON file. Use `textContent` / element construction.

**B8. Color cycling in 3D recomputes the whole heightmap every frame.**
`colorCycleLoop` → `fractal3D.setColorOffset()` → `regenerateMesh()`, i.e. a full
`resolution²` fractal evaluation (up to 4096²) plus `PlaneGeometry` rebuild *per animation
frame*. Palette changes must only rewrite the geometry's `color` attribute (or be a shader
uniform).

*Also worth folding into this pass:* if WebGL context creation fails, the `catch` in
`updateWebGLState()` does not start a CPU calculation → blank canvas in the fallback path.
And `WebGLFractalRenderer.destroy()` only nulls `gl`, leaking programs, buffers and the
context itself on every GPU/CPU toggle.
*Fixed (S1):* every WebGL failure (context creation, shader compile, context loss, a throw
from `renderWebGL`) now runs one `handleWebGLFailure`/`handleWebGLLoss` exit that starts a
real CPU calculation and reports through the new non-modal `#appMessage` element instead of
`alert`. `destroy()` is idempotent and deletes the program, both shaders and the buffer, then
releases the context via `WEBGL_lose_context`; it also accounts for live renderers so the
suite can assert teardown. A canvas that lost its context is replaced before a later GPU
toggle, and `window` `error`/`unhandledrejection` listeners surface anything that still
escapes. Pinned by `tests/webgl-fallback.spec.js`.

---

## 3. P1 — architecture and correctness debt

**One fractal kernel, four copies.** The same iteration logic lives in
`fractalEngine.js` (which `fractalWorker.js:1` imports and then *completely overrides* —
dead code), inline in `fractalWorker.js:42-101`, in `fractalEngineMain.js:4-63`, and in GLSL
in `webglFractal.js:44-93`. Every behaviour change currently has to be made 3–4 times
(and the type/palette index maps are duplicated too: `app.js:617-623`, `app.js:717`,
shader branches). This is the single biggest maintainability problem in the codebase.
Target: one parameterised kernel (TS) + one palette table, with the shader generated or
kept as the one documented exception.
*Fixed (S3):* there is now ONE kernel, `public/fractalKernel.js` — a file with **no
`import`/`export`** that publishes `globalThis.FractalKernel`, so it is simultaneously a valid
classic script (loaded by the worker via `importScripts`) and a valid ES module (loaded by the
main thread). `public/fractalEngine.js` and `public/fractalEngineMain.js` were **DELETED** (both
were copies; note this paragraph's "which `fractalWorker.js:1` imports and then completely
overrides" is what was true, not that the dead code was `fractalEngine.js` itself), the inline
override in `fractalWorker.js` is gone (that file went 127 → 69 lines), and the type/palette
tables live in the kernel and are templated into the GLSL as `#define FT_*` / `#define CS_*`.
The GLSL remains the one documented exception. Pinned by `tests/kernel-parity.spec.js` pins 2–3.
Still open in this section: per-frame allocation in the 2D renderer, the per-pass buffer copies
/ single worker, and the prefix/`colorSchemes.js` re-export.

**Per-frame allocation in the 2D renderer.** `FractalViewer.render()` rebuilds a
`Uint32Array(maxIter+2)` LUT and calls `ctx.createImageData(w,h)` on every call — including
every `mousemove` during a drag (`fractalViewer.js:135-158`). Cache the LUT (key on
scheme/offset/maxIter) and reuse one `ImageData`.

**Progressive refinement copies the whole buffer per pass** (`fractalWorker.js:12`
`job.prior.slice()`, plus `{...job, chunk}` per chunk) and runs on a single worker. A
worker pool sized to `navigator.hardwareConcurrency`, tiles instead of grid halving, and
transferable buffers would be the modern shape.

**Zoom-cap logic is triplicated** (`app.js:279-298`, `app.js:650-672`, `app.js:701-714`
pre-fix), `FractalViewer.setView`/`onWheel` are monkey-patched from `app.js`, and the clamp
in `fractalViewer.js:117-121` can never fire because `WEBGL_MIN_SCALE`/`webglCheckbox` are
module-scoped in `app.js`, not globals. This is the classic "feature added by patching the
patch" smell and is what produced B1. Consolidate view state + clamping into one module.
*Fixed (S1):* `FractalViewer.setZoomLimit()`/`clampScale()` now own the cap; `setView`,
`onWheel` and the startup animation all route through it, `renderWebGL` no longer clamps, and
both monkey-patches plus the dead wheel guard are deleted. Pinned (all three paths must
produce the same scale) by `tests/zoom-clamp.spec.js`.

**Dead / orphan files.**
- `recursiveFractalVibe.js`, `recursiveFractalLetter.js`, `splashMandelbrotCurve.js` — never
  imported by anything; they query `#fractVibeSplashCanvas` / `#fractVibeSplashCurveCanvas`,
  IDs that no longer exist. Superseded by the CSS-only `#fractVibeSplash` div.
- `styles/fractSplashFractalText.css` — not linked from `index.html`, and still carries debug
  leftovers (`border: 2px solid red`, "fallback for debug").

**Debug instrumentation left in production.** ~15 `console.log`s per interaction
(`app.js:440-460`, `app.js:715`, `webglFractal.js:233` pre-fix), plus a `MutationObserver`
installed *only to log* canvas style changes (`app.js:635-644` pre-fix), plus
`alert`/`confirm`/`prompt` for naming, import errors and zoom-cap decisions.

**UI layer.** The DOM is built with `createElement` + dozens of inline style assignments in
JS (`app.js:185-266` pre-fix); the "save location" flow uses `window.prompt`; the modal is
three nested `div`s instead of `<dialog>`; there is no focus management, no ARIA, no
keyboard path to the canvas, and no touch/pointer events at all (mouse-only: `mousedown`,
`mousemove`, `wheel`) — so the app is unusable on touch devices. `Space` toggling 3D mode is
undocumented in the UI.

**Persistence.** `FractalMemoryRepository` is session-only by design, so Saved Locations die
on reload while Export/Import implies durability. `localStorage`/IndexedDB is the obvious
upgrade, and the repo abstraction is already the right seam for it.

---

## 4. P2 — tooling and platform

| Area | Now | Suggested |
|------|-----|-----------|
| `package.json` | had only `dependencies` | **done:** `name`/`version`/`private`/`description`, `start` + `test` scripts (still no `type`, `engines`, `dev`/`lint`/`format`) |
| three.js | vendored `public/three.module.js`, **r155** (April 2023), 51 466 lines / 1.2 MB, unminified, committed | depend on `three` (current **0.186.0**) and let the build handle it. Note: r163 removed the WebGL1 renderer; r155 code mostly ports cleanly but `outputColorSpace`/`useLegacyLights`/addon import paths need attention |
| Delivery | raw files, no bundling, no minification, no cache headers (Netlify adds gzip, the Express dev server does not) | Vite (dev server + build), content-hashed assets, `immutable` caching; keep `public/` as the Netlify publish dir or move to `dist/` |
| Node | `netlify.toml` pins `NODE_VERSION = "18"` — **EOL 2025-04-30** | Node 24 (active LTS, EOL 2028-04-30); 22 still in extended support |
| Dependencies | `express@5.1.0`; `npm audit` reports 3 advisories (1 high) in transitive `body-parser`/`path-to-regexp`/`qs` | `npm audit fix` (patch-level); low real exposure — the Express server is a dev convenience, Netlify serves `public/` statically |
| Quality | no README, no LICENSE, no CI, no `.editorconfig`, no linter/formatter, **zero tests** | **partly done:** Playwright smoke suite added; still want README + LICENSE, ESLint/Prettier, `.editorconfig`, GitHub Actions running `npm test` |
| Dev server | `server/server.js`: CommonJS, hardcoded `PORT=3000`, no compression/caching/error handling, duplicates Netlify static hosting | ESM, `process.env.PORT ?? 3000`, `compression` + cache headers; or drop it once Vite owns `dev` |
| Types | plain JS | incremental TypeScript (`checkJs` first) is the highest-leverage step for the kernel/view-state refactors above |
| `.gitignore` | ignores `node_modules/` (good) and `.git/` (meaningless); now also `test-results/`, `playwright-report/` | drop `.git/`, add `.env*`, editor/OS noise |
| History | `node_modules` present in 14 commits (~1.2 MB `.git`) | optional: `git filter-repo`/BFG to purge it (requires force-push and coordination); **not** needed for correctness |

---

## 5. Suggested sequence

1. ~~**Phase 0 — make it work again.**~~ **DONE.** B1–B3 fixed, `tests/smoke.spec.js` added
   (4 pass on the fix, 4 fail on the pre-fix revision, 2 targeted failures on a B1-only
   build). Without B1 the deployed site was a blank canvas, so nothing else mattered until
   this landed.
2. **Phase 1 — correctness & feel (1–2 days).** B4–B8, delete the dead code and debug
   instrumentation, consolidate the zoom/view-state patching.
3. **Phase 2 — foundation (2–4 days).** Vite build, `three` from npm, Node 24, ESM dev
   server, lint/format/CI, single fractal kernel (+ its palette table) shared by
   worker/main/shader, worker pool.
4. **Phase 3 — product.** `<dialog>` + accessible controls, pointer/touch input, persisted
   locations (IndexedDB), then optional TypeScript migration and feature work.

Explicitly deferred: WebGPU / `three/webgpu` rewrite, WASM/SIMD kernels, OffscreenCanvas.
All are reasonable later; none are needed to fix the current defects.

---

## 6. Reproducing the checks

```bash
# smoke suite: 4 tests — B1 (render + modal), B2 (3D canvas on screen), B3 (CPU recalc)
npm test                      # expects 4 passed
# Uses host Chrome via `channel: 'chrome'` in playwright.config.js, so no browser
# download is needed; elsewhere run `npx playwright install chromium` and drop the channel.

# prove the suite is not vacuous — run it against the unfixed revision
git worktree add --detach /tmp/fv-control HEAD
ln -s "$PWD/node_modules" /tmp/fv-control/node_modules
cp playwright.config.js /tmp/fv-control/ && mkdir -p /tmp/fv-control/tests
cp tests/smoke.spec.js /tmp/fv-control/tests/
(cd /tmp/fv-control && npx playwright test)     # expects 4 failed
git worktree remove --force /tmp/fv-control

# the original crash, by hand
python3 -m http.server 8123 --directory public &   # ES modules + Worker need HTTP
google-chrome --headless=new --no-sandbox --enable-logging=stderr --v=0 \
  --virtual-time-budget=8000 --dump-dom http://localhost:8123/index.html 2>&1 | grep CONSOLE
# pre-fix -> "Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')" app.js (181)

# dev server
node server/server.js && curl -sI http://localhost:3000/three.module.js   # 200, 1.2 MB
```

Sources for the currency claims: [three.js releases](https://github.com/mrdoob/three.js/releases)
(npm `three@0.186.0`), [Node.js release schedule](https://endoflife.date/nodejs)
(Node 18 EOL 2025-04-30; Node 24 LTS, EOL 2028-04-30).
