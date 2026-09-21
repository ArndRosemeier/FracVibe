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
| **D1** | **Continuous escape-time colour**, one definition shared by the kernel and the GLSL; the iterated buffer becomes continuous (the `-1` sentinel represented in a float buffer); the integer LUT is replaced; colour cycling applies to the continuous value. Removes the amplifier and kills visible banding. | colour is **Lipschitz** in the escape value; a continuous zoom sweep shows **no frame-to-frame spike**; CPU/GPU parity (`kernel-parity.spec.js:210`, `meanAbs < 6`) still holds; inside stays black, uncalculated stays the placeholder | **IN FLIGHT** |
| **D2** | **Zoom-scaled iteration budget.** The probe proved the view centre escapes only at iteration **3085**, so at the shipped maxIter (512/2000) every deep frame saturates to "inside" — 1e6/512 = 90.8% inside, 1e8/512 = 100%. **Without this, no deep zoom is meaningful at any precision.** Scale maxIter with zoom (and surface it), so detail appears instead of black. | at a fixed deep view, raising the budget changes the image (it is no longer saturated) and the reference classification is reproduced; the budget follows zoom monotonically; the existing maxIter cap/UI pins still hold | queued |
| **D3** | **Compensated float32 on the GPU** (hi+lo for coordinates *and* iteration). **Measured to hold to ≥1e10** — ~1e6× beyond today — at ~10–12× fragment work, with no reference orbit, no glitch detection and no rebasing. | at 1e6/1e8 the GPU matches a float64 reference within a stated threshold (the probe's rig is the model); the compensated path is selected only where it is needed; the switch into it shows no visible change (see the acceptance criterion) | queued |
| **D4** | **Retire the CPU handoff** over the range the GPU now covers, and raise the plain-float32 cap to its measured limit for the cheap path. Keep CPU as an explicit option, not the automatic fallback; `#zoomCapOffer` stops appearing where it no longer applies. | beyond the old cap the GPU stays selected and the image is correct; the offer does not appear in the covered range; CPU stays reachable | queued |
| **D5** | **Perturbation theory** — the only route beyond ~1e10. Reference orbit at >float64 precision, delta iteration, glitch detection **and exact rebasing**, series approximation. | a rebase changes the image **only by reducing error** (no pop); a known glitch converges to the float64 reference; a zoom sweep across each rebase shows no spike | **deferred pending the owner's call on the §6 fork**; entirely UNMEASURED |
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

## 6 · THE FORK (for the owner — the evidence changed the answer)
The owner picked C when the alternatives were unmeasured. Now:

- **Route 1 — staged (RECOMMENDED).** D1 (continuous colour, in flight) → D2 (budget) →
  **D3 compensated float32**: measured to ≥1e10, i.e. ~1e6× deeper than today, in one
  self-contained shader change with **no reference orbit, no glitch detection, no
  rebasing** — so the only hop is the plain→compensated switch, which D1's continuity plus
  a threshold chosen where the error is already sub-pixel makes invisible. Then, only if
  zoom beyond ~1e10 is actually wanted, build the reference-orbit machinery.
- **Route 2 — perturbation now (as originally chosen).** The only route beyond ~1e10, but
  unmeasured, needs >float64 reference orbits (big-float on the CPU), glitch detection and
  **exact rebasing** — and rebasing is precisely a visible-pop mechanism, so it carries the
  hop risk the owner explicitly wants avoided and needs the continuity design anyway.

**Recommendation: Route 1.** It reaches a depth no user will exhaust in normal use, for far
less work and with materially less pop risk, and it does not foreclose perturbation later —
D5 simply moves behind D3. Rejected: Route 2 now, because it buys zoom we have measured
nothing about while taking on the machinery most likely to produce the exact artifact the
requirement forbids.

## 7 · Out of scope
WebGPU, WASM/SIMD kernels, and any change to the CPU kernel's float64 accuracy. The
deliberately deferred items from the previous campaign (`MODERNIZATION.md` §3–§5) stay
deferred unless a slice here proves one is required — in which case it goes to the owner as
a fork, not in silently.
