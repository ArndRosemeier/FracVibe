# PROBE — GPU deep-zoom precision (read-only evidence)

- **Probe:** subagent `b9243a50-ad14-4a4a-badb-474367419c36`, read-only (repo untouched,
  `git status --porcelain` empty; all artifacts under `/tmp/fv-gpu-probe/`)
- **Date:** 2026-09-21 · **Scene:** centre `-0.743643887037151 + 0.13182590420533i`,
  320×240, rainbow, `colorOffset 0`. A float64 JS reference mirrors the shader loop.
- **GL:** ANGLE / **SwiftShader** (Vulkan 1.3.0, Subzero), WebGL 1.0, highp fragment =
  23 bits, DITHER on.
- **⚠ EVERY TIME IS A SOFTWARE (SwiftShader) PROXY.** Correctness figures are valid;
  absolute speed on a real GPU is not established.
- **Fidelity:** the shader the probe measured (`gl.getShaderSource`) is byte-identical to
  the real `public/webglFractal.js` template (126 body lines). The compensated shader
  differs only by 4 `*Lo` uniforms, 3 `ds_*` helpers, 2 added coordinate lines and the
  Mandelbrot branch body.

## The table

`meanD` = mean per-pixel mean |ΔRGB| (0–255). `mis%` = GPU "inside" vs reference
`iter == maxIter`. Ratio = median of 3 trials, one compensated draw vs five float32
draws, same view. **Arm A** = maxIter 512 everywhere; **arm B** = zoom-adequate maxIter.

| zoom | arm | maxIter | f32 meanD | f32 maxD | f32 mis% | df meanD | df maxD | df mis% | ratio | ref inside% | coord err (px) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1e3 | A/B | 512 | 4.73 | 255 | 0.917 | 1.14 | 255 | 0.443 | 10.99× | 0.6 | 0.009 |
| 1e4 | A/B | 512 | 8.05 | 255 | 1.214 | 1.19 | 255 | 0.477 | 10.43× | 0.8 | 0.088 |
| 1e5 | A | 512 | 21.80 | 255 | 4.520 | 1.85 | 255 | 1.042 | — | 9.8 | 0.885 |
| 1e5 | B | 2000 | 7.60 | 255 | 0.391 | 0.71 | 255 | 0.009 | 11.91× | 5.7 | 0.885 |
| 1e6 | A | 512 | 6.50 | 255 | 4.250 | 0.025 | 255 | 0.022 | — | 90.8 | 8.825 |
| 1e6 | B | 32768 | **106.38** | 255 | **77.342** | **0.016** | 30 | 0.000 | 11.55× | 0.0 | 8.825 |
| 1e8 | A | 512 | 0.00 | 0 | 0.000 | 0.000 | 0 | 0.000 | — | 100.0 | 331.0 |
| 1e8 | B | 4096 | **92.19** | 255 | 0.000 | 0.312 | 224 | 0.000 | 12.49× | 0.0 | 331.0 |
| 1e9 | B | 4096 | 89.34 | — | — | 0.418 | — | 0.000 | — | — | — |
| 1e10 | B | 4096 | 79.71 | — | — | 0.987 | — | 0.000 | — | — | — |

At 1e6–1e10 in arm B the frame is **all-outside**, so `mis%` is trivially 0; `meanD` is
the informative column there. The 1e8/arm-A row is 100% inside: saturated (see finding 7).

## PROVEN (observed, with the command that produced it)

1. **The float32 coordinate grid crosses 0.5 device px at zoom 5.65e4** — 0.177 px at
   2e4, 0.265 at 3e4, 0.500 at 5.65e4 (0.31% of pixels already >0.5 px), 0.998 at 1.13e5
   (38.1% >0.5 px). Error is linear in zoom. **The shipped cap 1e4 = 0.088 px**, i.e.
   ~5.7× conservative *on the coordinate criterion*.
2. **Plain float32 has no exact regime.** It already disagrees with float64 at 1e3:
   0.917% misclassified, meanD 4.73. JS-only controls split the cause at 1e3 —
   coordinate quantisation alone 0.870%, iteration rounding alone 0.880% — so both
   contribute. There is no zoom at which plain float32 matches float64 exactly.
3. The measurement rig is validated: the GPU agrees with a faithful float32 JS emulation
   of the same shader to 0.0013% (1e3) / 0.0143% (1e4) misclassification.
4. **Compensated hi+lo (coordinates AND iteration) works.** At 1e6 / mi32768: **zero**
   pixels with Δ>32, meanD 0.0164, and 53 distinct colours — exactly the float64
   reference's 53. At 1e8 meanD 0.312, 0.000% misclassified; at 1e10 meanD 0.987,
   0.000%. **All at or BELOW the 1e3 compensated baseline** (meanD 1.14, mis 0.443%),
   i.e. divergence falls to (below) the shallow baseline and stays there.
5. **The compensated failure mode is scattered speckle, not artifacts.** At 1e8 the 752
   pixels with Δ>32 form 724 components, largest 2 px; 1e9 → 940 components, largest 6;
   1e10 → 2057, largest 5. Distinct colours 221 vs the reference's 233 at 1e8. Mild
   return of divergence with zoom (0.016 → 0.31 → 0.42 → 0.99 from 1e6 to 1e10), monotone
   and still under baseline; **no blocky/glitch structure.** Compiles clean under ANGLE
   (the Dekker split survives optimisation).
6. **Plain float32 collapses at depth.** At 1e8 the whole 320×240 frame renders as ONE
   distinct colour (reference: 233) and 76 768/76 800 pixels differ by >32 in a single
   connected component. At 1e6: 233 distinct colours vs reference 53, 100% of pixels
   >Δ32.
7. **The iteration budget, not precision, masks everything at the shipped defaults.** The
   view centre itself escapes only at iteration **3085** (float64, stable across budgets
   2e4–2e6). At the shipped maxIter of 512/2000 the deep frames therefore saturate to
   "inside": 1e8/mi512 = 100% inside, 1e6/mi512 = 90.8% inside. **Every deep number above
   requires a zoom-scaled maxIter.** Without that, deeper zoom shows black no matter how
   precise the arithmetic is.
8. **Cost of the compensated shader: ~10.4–12.5×** fragment work vs plain float32, per
   draw, same view (median of 3; an earlier identical setup gave 6.5–9.6× under heavier
   host load). Absolute medians, SwiftShader proxy: 1e3 7.9/81.1 ms, 1e5 18.0/218.4,
   1e6 74.9/859.5, 1e8 44.7/544.3.
9. **The shipped CPU and GPU paths disagree from a HALF-PIXEL sample-point offset, not
   from precision.** `FractalKernel.pixelToCoord` samples pixel CORNERS; the shader
   samples pixel CENTRES. Classification disagreement app-CPU vs float64: 1.264% (1e3),
   1.497% (1e4), 9.012% (1e5) — while the SAME kernel evaluated at the shader's sample
   points agrees to 0.003%/0.003%/0.027%. **That misregistration exceeds the GPU's
   float32 error at 1e3–1e4**, so the CPU fallback is not a precision-clean reference.

## UNPROVEN / NOT MEASURED

- **Perturbation theory: UNMEASURED.** It requires (a) a reference orbit at
  >float64 precision (fixed-point / big-float) for the view centre, (b) delta iteration
  `z = Z + delta` with cancellation compensation, (c) glitch detection (e.g. a
  `|z|²/|Z|²` test) plus rebasing to a new orbit and re-rendering affected pixels, and
  (d) series approximation to skip early iterations. Published implementations reach
  1e10–1e100+; **none of that was prototyped or timed here.** Every claim about it is
  UNMEASURED.
- No real GPU was available: all timings are software rasterisation.
- Unmeasured: zooms beyond 1e10; non-Mandelbrot types (Julia / burning-ship / tricorn);
  the 2D and 3D CPU paths; interactive FPS; memory; and GPU-specific hazards (FMA
  contraction on real drivers, `mediump` fallback).

## REPRODUCE (`/tmp/fv-gpu-probe/`)

```sh
node /tmp/fv-gpu-probe/run-probe.cjs 1e3,1e4,1e5,1e6,1e8                    # arm A
MAXITER=1e5:2000,1e6:32768,1e8:4096 node /tmp/fv-gpu-probe/run-probe.cjs 1e3,1e4,1e5,1e6,1e8   # arm B
MAXITER=... TIMING=1 REFMODE=none REPSF=5 REPSD=1 node /tmp/fv-gpu-probe/run-probe.cjs ...      # ratios
node /tmp/fv-gpu-probe/analyze-center.cjs   # escape-time / saturation maths
node /tmp/fv-gpu-probe/bench.cjs            # timing-sync sanity
```
Artifacts: `probe.html`, `run-probe.cjs`, `real_frag.glsl`, `df_frag.glsl`,
`repo_frag_body.glsl`, `FINDINGS.md`, `final.json`, `sweepA_maxiter512.json`,
`sweepB_timing2.json`, `glitchcheck.json`, `extra_1e9_1e10.json`, `cpucompare.json`,
`coord_crossing.json`, `sweep.log`. `public/` there is a symlink into the repo, so the
probe read the real shader without writing into the repo.
