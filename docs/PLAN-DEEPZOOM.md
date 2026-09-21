# FracVibe — deep-zoom campaign: stay on the GPU, and make the hops invisible

Owner's requirement, 2026-09-21 (verbatim): *"I would like C but with special care
around precision hops. I know there was a problem earlier that those can become very
visible when zooming because of palette changes and things like that. The zoom needs
to stay visually as smooth as possible."*

"C" = a GPU **perturbation** renderer, so the app stops handing off to the CPU at deep
zoom. This file is the campaign. `docs/STATE.md` is the live board.

---

## 1 · Why the GPU stops today (verified in the code, not inferred)

`WEBGL_ZOOM_CAP = 10000` (`public/app.js:424`) exists because the shader forms each
pixel's coordinate by adding a tiny step to an **absolute float32 centre**:

```glsl
float x0 = u_centerX + (v_uv.x - 0.5) * u_scale * u_aspect;   // webglFractal.js:82
```

Float32 carries ~24 mantissa bits, so near |c| ≈ 1 its resolution is ≈ 6e-8. Across a
1000-px view at zoom *Z* the per-pixel step is `1/(1000·Z)`, which stops being
representable when `Z ≳ 1/(1000 × 6e-8) ≈ 1.7e4`. **The cap of 1e4 is therefore an
honest ceiling, slightly conservative — raising it is not an option, because it is the
*formulation* that fails.** There is no `double` type in any GLSL ES version (WebGL 1
or 2), so the only GPU routes are emulating extra precision or changing the algorithm.

## 2 · The amplifier that makes hops visible (also verified)

**Colour is a staircase in the escape value, in both renderers, and nothing smooths it.**

- CPU: `public/fractalViewer.js:197-208` builds `const lut = new Uint32Array(this.maxIter + 2)`
  — one entry per **integer** iteration — and colours each pixel with `lut[iter]`.
  `iteratePixel` (`public/fractalKernel.js:143`) returns an integer, carried through the
  worker in an `Int32Array` (`public/fractalWorker.js:45`, `.fill(-1)`).
- GPU: `public/webglFractal.js` iterates `int iter`, then
  `float t = float(iter) / float(u_maxIter);`.
- A `grep` for escape-time smoothing across `public/*.js` finds **none** (the only
  "smooth" is `smoothHeightmap`, the 3D mesh).

**Consequence.** Because colour steps, a precision change of *any* size — a hop between
precision levels, a rebased reference orbit, a float32 rounding difference — can shove a
pixel across a step and flip it **a whole colour band**. Pixels cluster at those steps
near the fractal boundary, which is exactly where the user is looking while zooming, and
colour cycling moves the steps through the image. A continuous colour function turns an
arbitrarily small precision change into an arbitrarily small colour change — that is what
makes a hop *invisible* rather than merely small. This is why D1 comes first.

## 3 · Slices

| id | intent | pins (must go RED when broken) | status |
|---|---|---|---|
| **D1** | **Continuous escape-time colour**, one definition shared by the kernel and the GLSL; the iterated buffer becomes continuous (the `-1` sentinel represented in a float buffer); the integer LUT is replaced; colour cycling applies to the continuous value. Removes the amplifier and kills the visible banding. | colour is **Lipschitz** in the escape value (a sub-iteration change is a sub-perceptual colour change); a continuous zoom sweep shows **no frame-to-frame spike** at any scale including the 1e4 boundary; CPU/GPU parity (`kernel-parity.spec.js:210`, `meanAbs < 6`) still holds; inside stays black and uncalculated cells stay the placeholder | **in flight** |
| D2 | **The perturbation renderer.** A reference orbit in float64 computed once per view (the CPU has float64; the GPU does not), with per-pixel **delta** iteration in float32 on the GPU. This is what actually removes the handoff. | at zoom far beyond 1e4 the GPU image matches a float64 CPU reference within a stated threshold; the reference orbit is computed **once per view**, not per pixel (counted); the hop from the old float32 path to the perturbation path produces no visible change | queued |
| D3 | **Glitch detection + rebasing, exactly.** Perturbation glitches are handled by re-rendering with a better reference. | a rebase changes the image **only by reducing error** — the frame after a rebase differs from the frame before by less than the visual threshold (no pop); a known glitch case converges to the float64 reference | queued |
| D4 | **Retire the CPU handoff** over the zoom range the GPU now covers; keep CPU as an explicit option, not the automatic fallback. The `#zoomCapOffer` ("switch to CPU?") stops appearing where it no longer applies. | beyond the old cap, the GPU stays selected and the image is correct; the offer does not appear in the covered range; CPU remains reachable | queued |

### Acceptance criterion for EVERY slice (the owner's requirement, made measurable)
A **continuous zoom sweep** through the scale range a slice touches — including every
boundary where precision, the reference orbit, or the algorithm changes — must show **no
step-to-step image-difference spike**. A hop that changes the image more than its
neighbours is a failure, no matter how correct the steady-state image is.

## 4 · What is being measured, and by what

A read-only probe is running against `/tmp` (it may not touch this repo) to measure, with
numbers: where float32 actually breaks (GPU vs a float64 reference at zooms 1e3, 1e4,
1e5, 1e6, 1e8, on a real deep coordinate), whether double-float compensation fixes it and
at what relative shader cost, and precisely what perturbation theory requires. Anything
it does not prototype is marked **UNMEASURED**. Its numbers seed D2's brief.

**Two standing limits on evidence from this host:** Chrome here renders WebGL through
**SwiftShader (software)**, so any *timing* is a proxy and a real speed claim needs the
owner's GPU; *correctness* measurements are valid. And on GPUs where fragment `highp` is
unavailable, the current cliff is far worse than 1e4.

## 5 · Out of scope
WebGPU, WASM/SIMD kernels, and any change to the CPU kernel's float64 accuracy. The
deliberately deferred items from the previous campaign (`MODERNIZATION.md` §3–§5) stay
deferred unless a slice here proves one is required — in which case it goes to the owner
as a fork, not in silently.
