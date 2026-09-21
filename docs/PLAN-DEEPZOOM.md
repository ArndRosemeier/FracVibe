# FracVibe — deep-zoom campaign: stay on the GPU, and make the hops invisible

Owner's requirement, 2026-09-21 (verbatim): *"I would like C but with special care
around precision hops. I know there was a problem earlier that those can become very
visible when zooming because of palette changes and things like that. The zoom needs
to stay visually as smooth as possible."*

The owner's INTENT is: **stay on the GPU at deep zoom, and never show a visible hop.**
"C" (perturbation) was the mechanism chosen when the alternatives were unmeasured. They
no longer are — see §4, and the fork in §6. `docs/STATE.md` is the live board.

---

## 1 · Why the GPU stops today

`WEBGL_ZOOM_CAP = 10000` (`public/app.js:424`) exists because the shader forms each
pixel's coordinate by adding a tiny step to an **absolute float32 centre**:

```glsl
float x0 = u_centerX + (v_uv.x - 0.5) * u_scale * u_aspect;   // webglFractal.js:82
```

Float32 carries ~24 mantissa bits (23 in this ANGLE/SwiftShader fragment stage), so near
|c| ≈ 1 its resolution is ≈ 6e-8. **Measured** (see §4): the coordinate error is linear in
zoom and crosses **0.5 device px at zoom 5.65e4** — 0.088 px at the shipped cap of 1e4.

*Correction to an earlier claim in this file:* I first called 1e4 "an honest ceiling".
The measurement says it is **conservative by roughly 5–10×** on the coordinate criterion.
But it is not simply timid either — plain float32 has **no exact regime** (it already
misclassifies ~0.9% of pixels at 1e3) and it **collapses between 1e5 and 1e6** (at 1e6,
77% of pixels misclassified and mean ΔRGB 106 against a float64 reference). So the cap
sits just before catastrophe, and raising it buys one order of magnitude at most. There is
**no `double` type in any GLSL ES version**, so the only routes are emulating precision or
changing the algorithm.

## 2 · The amplifier that makes hops visible

**Colour is a staircase in the escape value, in both renderers, and nothing smooths it.**

- CPU: `public/fractalViewer.js:197-208` builds `const lut = new Uint32Array(this.maxIter + 2)`
  — one entry per **integer** iteration — and colours each pixel with `lut[iter]`.
- GPU: `public/webglFractal.js` iterates `int iter`, then
  `float t = float(iter) / float(u_maxIter);`.
- A `grep` for escape-time smoothing across `public/*.js` finds **none**.

**Consequence.** A precision change of *any* size can shove a pixel across a step and flip
it **a whole colour band**. Pixels cluster at those steps near the fractal boundary, which
is where the user is looking while zooming, and colour cycling moves the steps through the
image. A continuous colour function turns an arbitrarily small precision change into an
arbitrarily small colour change — that is what makes a hop *invisible* rather than merely
small. **This is needed under every route, which is why it is D1.**

## 3 · Slices

| id | intent | pins (must go RED when broken) | status |
|---|---|---|---|
| **D1** | **Continuous escape-time colour**, one definition shared by the kernel and the GLSL; the iterated buffer becomes continuous (the `-1` sentinel represented in a float buffer); the integer LUT is replaced; colour cycling applies to the continuous value. Removes the amplifier and kills visible banding. | colour is **Lipschitz** in the escape value; a continuous zoom sweep shows **no frame-to-frame spike**; CPU/GPU parity (`kernel-parity.spec.js:210`, `meanAbs < 6`) still holds; inside stays black, uncalculated stays the placeholder; **and a finished frame is indexed at the cap ITS OWN JOB ran at** (the frame-must-not-be-reindexed-at-the-viewer's-cap invariant, pin 6) | **LANDED & VERIFIED** at `8e752d8` + the pin-6 fix-forward — writer FULL gate exit 0, **49 passed**; the smooth value, the `Float32Array`/`NaN` sentinel, the colour table and the CPU/GPU `n` convention are `docs/DECISIONS.md` rows 27–28, the six pins and six control arms are in `tests/smooth-color.spec.js` (row 29 records pin 6). One measured correction to this row's pin wording: the raw frame-difference **spike** bound is not discriminating at deep zoom (genuine image change dominates it); the deciding assertion is a hop classification — a pixel whose escape value moved < 0.5 iterations may not change colour by more than its own proportional change. |
| **D2** | **Zoom-scaled iteration budget.** The probe proved the view centre escapes only at iteration **3085**, so at the shipped maxIter (512/2000) every deep frame saturates to "inside" — 1e6/512 = 90.8% inside, 1e8/512 = 100%. **Without this, no deep zoom is meaningful at any precision.** Scale maxIter with zoom (and surface it), so detail appears instead of black. | at a fixed deep view, raising the budget changes the image (it is no longer saturated) and the reference classification is reproduced; the budget follows zoom monotonically; the existing maxIter cap/UI pins still hold | **NEXT after D1 — prerequisite for P1** |
| **P1** | **The perturbation core** (the owner's chosen route, §6). A **reference orbit** for the view centre computed ONCE per view at float64 precision on the CPU and uploaded to the GPU, then per-pixel **delta** iteration `dz ← 2·Z·dz + dz² + dc` in the shader, with compensation wherever cancellation bites (the probe measured that hi+lo compensation works). This is what removes the handoff. | on a glitch-free deep view the GPU matches a float64 reference within a stated threshold at 1e6 and beyond; the orbit is computed **once per view, not per pixel** (counted, never inferred); the delta path reproduces the reference's inside/outside classification | **NEXT** |
| **P2** | **Exact rebasing.** Detect glitches — pixels whose orbit departs from the reference — and re-render them against a better reference. **A rebase may only REDUCE error.** This is the slice that carries the owner's smoothness requirement. | a zoom sweep across each rebase shows **no spike**; a known glitch case converges to the float64 reference; the frame AFTER a rebase differs from the frame before by less than the visual threshold | queued |
| **P3** | **The path switch** — plain float32 ↔ perturbation — placed where the plain path's error is already sub-pixel, with no visible change across the boundary. | a zoom sweep across the switch shows no spike; at the switch the two paths agree within the stated threshold | queued |
| **P4** | **Retire the CPU handoff** over the range the GPU now covers. Keep CPU as an explicit option, not the automatic fallback; `#zoomCapOffer` stops appearing where it no longer applies. | beyond the old cap the GPU stays selected and correct; the offer does not appear in the covered range; CPU stays reachable | queued |
| **P5** | **Series approximation** — speed, not correctness: skip the first N delta iterations with a polynomial in `dc`. | an SA-skipped render equals the non-skipped render within the stated threshold | queued |
| **P6** | **Reference orbits beyond float64.** A float64 orbit reaches roughly 1e15; past that the ORBIT itself needs big-float precision. This is where "unlimited" actually lives. | beyond the float64 range the image stays correct and the sweep shows no spike | **deferred until/unless >1e15 is wanted** |
| **D6** | **Align the CPU and GPU sample points.** `FractalKernel.pixelToCoord` samples pixel CORNERS while the shader samples CENTRES, so the two renderers disagree by 1.26% (1e3) / 9.0% (1e5) — **more than the GPU's float32 error at shallow zoom**, and it inflates the parity pins' tolerances. | CPU and GPU agree at the same sample points to the float32 floor; the parity pins' thresholds can tighten and are tightened | queued |

### Acceptance criterion for EVERY slice (the owner's requirement, made measurable)
A **continuous zoom sweep** through the scale range a slice touches — including every
boundary where precision, the reference orbit, or the algorithm changes — must show **no
step-to-step image-difference spike**. A hop that changes the image more than its
neighbours is a failure, however correct the steady-state image is.

## 4 · What the probe measured (full evidence: `docs/PROBE-2026-09-21-gpu-precision.md`)

A read-only probe measured the real shader (read live from `getShaderSource`, byte-identical
to the repo template) against a float64 reference at 320×240 on a genuine deep coordinate.
**All timings are SwiftShader software proxies; correctness figures are valid.**

1. **Compensated float32 works, and further than anything else measured here.** At
   1e6 / maxIter 32768 it produced **zero** pixels differing by >32 and **53 distinct
   colours — exactly the float64 reference's 53**. At 1e8 mean ΔRGB 0.31, 1e9 0.42,
   1e10 0.99, all with **0.000% misclassification** — i.e. **at or below the 1e3
   compensated baseline**. Its failure mode is scattered speckle (largest connected
   component 2–6 px), **not** blocky artifacts.
2. **Cost ≈ 10.4–12.5× fragment work** per draw, same view (median of 3; 6.5–9.6× in an
   earlier run under heavier load).
3. **Plain float32 collapses** between 1e5 and 1e6 — at 1e8 the whole frame renders as
   **one** distinct colour vs the reference's 233.
4. **The iteration budget masks the whole question today** (this is D2).
5. **The CPU fallback is not a precision-clean reference**: the half-pixel sample-point
   offset makes it disagree with float64 by more than the GPU's float32 error at 1e3–1e4
   (this is D6).
6. **Perturbation theory is entirely UNMEASURED.** The probe prototyped none of it and
   says so. Any comparative claim about it is unsupported.

## 5 · Standing limits on all of this evidence
Chrome on this host renders WebGL through **SwiftShader (software)**, so timings are a
proxy and **a real-GPU speed claim is not established** — in particular whether ~10×
fragment work stays interactive on the owner's hardware is UNMEASURED. Unmeasured too:
zooms beyond 1e10, non-Mandelbrot types, the CPU/3D paths, interactive FPS, and real-driver
hazards (FMA contraction, `mediump` fallback — on GPUs without fragment `highp` the cliff
is far worse than 1e4).

## 6 · DECISION (owner, 2026-09-21) — Route 2: perturbation now
The owner was shown the measured fork and chose **Route 2: go straight to perturbation**, taking the
only route past ~1e10 and accepting that it is unmeasured here and that its rebasing is itself a
pop mechanism. The compensated route is therefore **not built** — but the probe's compensation
measurements are retained, because P1's delta arithmetic needs exactly that kind of compensation.

**Honest scope of what this buys.** With a **float64 reference orbit** the practical reach is
roughly **1e15** — the orbit needs about as many digits as the zoom — i.e. about 1e11× beyond
today's 1e4 cap. Past ~1e15 the *orbit itself* needs big-float precision, which is P6 and is
deferred. "Unlimited" lives at P6, not at P1.

**Good news on the owner's specific worry.** While the orbit stays float64 there is **no precision
hop inside the deep path at all** — the orbit is recomputed each view at a fixed precision. So the
hop sources in this design are exactly two, and each is its own slice: the **path switch** (P3) and
**rebasing** (P2). Continuity is enforced on those two by the acceptance criterion above, not by
luck — and rebasing is where the risk actually lives, which is why it gets its own slice and its
own "may only reduce error" pin rather than being folded into P1.

**Also confirmed by the owner:** continuous colour as the ONLY mode, with no banded toggle. That is
what D1 is already building.

## 7 · Out of scope
WebGPU, WASM/SIMD kernels, and any change to the CPU kernel's float64 accuracy. The compensated
float32 route is deliberately **not** built (owner decision, §6) though its measurements inform P1.
The deliberately deferred items from the previous campaign (`MODERNIZATION.md` §3–§5) stay deferred
unless a slice here proves one is required — in which case it goes to the owner as a fork, not in
silently.
