# PROBE — perturbation orbit transport & achievable depth (read-only evidence)

- **Probe:** subagent `defd8b05-2589-4c70-82b3-063b4e58d284`, read-only (repo
  `git status --porcelain` EMPTY; artifacts in `/tmp/fv-perturb-probe/`, full record
  `FINDINGS.md`)
- **Host:** ANGLE / **SwiftShader**, WebGL1 **and** WebGL2 available.
  **⚠ ALL TIMES ARE SOFTWARE PROXIES.** Correctness figures are valid.
- **Scene:** centre `-0.743643887037151 + 0.13182590420533i`, 320×240, rainbow,
  `colorOffset 0`. The reference is the repo's OWN `public/fractalKernel.js` (loaded,
  never written), iterated in float64 at the shader's pixel-centre points.
- **Centre escape count (app kernel): 3086** — the earlier probe's figure CONFIRMED.

## Q1 — orbit transport mechanisms that actually work here

- WebGL1 extensions: **`OES_texture_float` YES**, `OES_texture_float_linear` YES,
  `WEBGL_color_buffer_float` YES (`EXT_color_buffer_float` is WebGL2-only).
  `getContext('webgl2')` is available; there `EXT_color_buffer_float` and
  `OES_texture_float_linear` are present.
- **Float texture + NEAREST round trip is EXACT**, in WebGL1 *and* WebGL2: a shader
  samples the texture, compares with `==` against identical float32 uniforms, and a
  1×1 RGBA8 readback masks the result. The deep centre's X and Y split `hi/lo/res`
  (53 significant bits) both mask **15/15**; an adjacent-float32 control mismatches,
  so all 24 bits per channel survive (`hi/lo` = 48 bits, `hi/lo/res` = 53+). NPOT 6144
  and full-8192-wide float textures sample exactly (`texErr = 0`).
- **`MAX_TEXTURE_SIZE = 8192`**, so one texel per iteration just fits the shipped
  `MAX_ITER = 8192`. **Orbit transport by float texture is cheap, exact and
  obstacle-free here.**

## Q2/Q3 — achievable depth (this is the important part)

Arms: **A** f32 orbit + f32 delta; **B** hi/lo orbit + compensated (Dekker df) delta;
**C** f32 orbit + compensated delta; **D** hi/lo orbit + f32 delta.
`meanΔ/maxΔ` per-channel |ΔRGB| 0–255; `glitch%` at `|z|²/|Z|² < 1e-4`.

| zoom | arm | maxIter | meanΔ | maxΔ | mis% | glitch% | note |
|---|---|---|---|---|---|---|---|
| 1e8 | A | 4096 | 0.607 | 255 | 0.0026 | 0.077 | speckle, max component 4 px |
| 1e8 | B | 4096 | 0.457 | 255 | 0.0013 | 0.083 | speckle, max component 3 px |
| 1e8 | C | 4096 | 0.506 | 255 | 0.0013 | 0.086 | — |
| 1e8 | D | 4096 | 0.607 | 255 | 0.0026 | 0.077 | **BIT-IDENTICAL to A** |
| 1e12 | A | 6144 | 1.708 | 255 | 0.341 | 1.367 | max blob 81 px; colours 474→180 |
| 1e12 | B | 6144 | 2.201 | 255 | 0.966 | 1.368 | max blob 215 px; **WORSE than A** |
| 1e12 | C | 6144 | 2.200 | 255 | 0.970 | 1.375 | — |
| 1e12 | D | 6144 | 1.708 | 255 | 0.341 | 1.367 | == A |
| 1e15 | A | 7680 | **32.309** | 255 | **26.379** | 74.557 | max blob 642 px; 6 colours vs 53 |
| 1e15 | B | 7680 | **64.260** | 255 | **55.159** | 74.559 | one 40 444 px blob = WHOLE-FRAME COLLAPSE |
| 1e15 | C | 7680 | 49.376 | 255 | 41.745 | 74.559 | blob 14 899 px |
| 1e15 | D | 7680 | 32.309 | 255 | 26.379 | 74.557 | == A |
| 1e18 | all | 8192 | 0.333 | 1 | 0.000 | 0.000 | **NOT A TEST**: reference frame is ONE value, smooth spread exactly 0.0 |

Trend (`trend.json`): 1e9 A/B/C smooth-mean 4.62/3.58/3.85; 1e10 19.9/19.8/21.1;
1e11 224/165/208 (mis 7.1/7.9/8.0%). **Compensation was better at 1e8–1e9, tied at
1e10, mixed at 1e11, and worse on EVERY metric at 1e12 and 1e15.**

## PROVEN

1. **Both transports work at 1e8** (mis ≤ 0.003 %) and are **already degrading at 1e12**
   (0.34–0.97 %), and **both FAIL at 1e15** (26–55 % misclassified) on this centre.
   **The plan's "a float64 orbit reaches roughly 1e15" is NOT reproduced for either
   transport here.**
2. **Compensation did not buy depth** in this formulation — it was worse at 1e12–1e15.
   The measured limiter at 1e15 is the **float32 DELTA ARITHMETIC**: holding the same
   24-bit orbit but doing the arithmetic in float64 gives a mean error of **64
   iterations** against the GPU's **1235**. So "compensate the delta" is the right
   target, but *this* df composition did not achieve it.
3. **A hi/lo orbit is INERT under an f32 delta** — A and D are bit-identical, because
   `float(hi + lo)` returns `hi`. Orbit transport format alone changes nothing.
4. **1e18 with this centre is not a correctness test at all** (the reference frame is
   constant). Never use it as a pin.
5. **Controls rule out the obvious rig explanations:** the GPU is genuinely IEEE
   float32 (JS emulation with `Math.fround` everywhere matches the GPU *better* —
   mean 908 vs 1212 smooth-iterations — while f64 arithmetic on the same f32 orbit
   matches far worse, mean 64); the Dekker split constant is not the cause (rerunning
   B/C with `split=4097`, correct for 24-bit, is bit-identical); and the on-device
   `ds_add`/`ds_mul` self-tests pass (plain f32 loses `1+1e-8`, `ds_add` keeps it;
   `ds_mul((1+2⁻¹²)²).lo == 2⁻²⁴` exactly).
6. **Glitch baseline WITHOUT rebasing** (a geometry property, near-identical across
   arms): **0.08 % at 1e8, 1.37 % at 1e12, 74.6 % at 1e15.** At 1e15 the no-rebase
   image *is* the failure image (A: 26.4 % inside vs the reference's 0 %, 6 colours vs
   53, a 642 px blob; B: 55.2 % misclassified, one blob covering 53 % of the frame).
   PNGs in `bufs/`.
7. **Budget adequacy (`ref-center.cjs`):** with the D2 rule, the float64 frame needs
   **4669** iterations at 1e8 against a budget of 4096 (0.001 % saturated), and
   **9011** at 1e12 — **above the 8192 cap, so 1e12 cannot be made fully adequate
   without raising the cap** (0.026 % saturated). At 1e15 the need is 3597 and at 1e18
   it is 3086, both adequate but 1e18 is degenerate. Saturated pixels are `inside` in
   both reference and arm, so they do not inflate `mis%`.

## UNPROVEN / NOT MEASURED
Real-GPU behaviour (FMA, `mediump`, driver ordering — **the compensated regression may
not survive on hardware**); the causal mechanism for B being worse than C at 1e15;
other fractal types; other centres; **rebasing, series approximation and big-float
orbits (not prototyped)**; the campaign's hop-invisibility criterion (not tested); and
timing/interactivity.

## REPRODUCE (`/tmp/fv-perturb-probe/`)
```sh
node gl-info.cjs
node ref-center.cjs
ARMS=A,B,C,D node run-probe2.cjs 1e8,1e12,1e15,1e18
DSPLIT=4097 ARMS=B,C node run-probe2.cjs 1e12,1e15
DUMPDIR=.../bufs ARMS=A,B node run-probe2.cjs 1e15
node emulate.cjs 1000000000000000 A
node dump-images.cjs 1000000000000000
```
Files: `gl-info.{html,cjs,json}`, `probe.html`+`run-probe.cjs` (v1), `probe2.html`+
`run-probe2.cjs` (4-arm + float smooth pass), `ref-center.{cjs,json}`, `emulate.cjs`,
`dump-images.cjs`, `results2.json`, `trend.json`, `split4097.json`, `bufs/*.png|*.f32`,
`FINDINGS.md`.
