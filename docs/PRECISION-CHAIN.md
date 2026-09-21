# THE PRECISION CHAIN — a measured map from the view centre to the pixel

> **Slice:** `feat/precision-chain`, based on `origin/main` = `ca14755`.
> **Why this file exists:** the owner has asked five times for *arbitrary precision
> in both paths* and it is still not delivered. `docs/DECISIONS.md` row **67** names
> the three missing mechanisms — **(a)** the orbit's 24-bit transport to the GPU,
> **(b)** the depth-scaling delta mantissa ladder, **(c)** the CPU lane's missing
> orbit+perturbation port. This document is the measured map those three mechanisms
> have to be scheduled against: every stage of the chain, its effective significand
> bits and exponent range, and the number that says whether it is binding.
>
> **HOST CAVEAT (UNVERIFIED for hardware).** Every GPU number here and in the
> documents it cites was taken on **SwiftShader** (ANGLE/Vulkan software rasteriser):
> Chrome on this host reports `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
> (Subzero)), SwiftShader driver)`. SwiftShader is a correct IEEE-754 float32
> implementation, so these numbers are valid **for correctness**, but they are **not
> hardware numbers**, and a hardware-only GLSL defect (or an FMA/reassociation
> difference) could still pass here. **A hardware certification of any precision
> claim in this file is UNVERIFIED and impossible on this host.**
>
> **Measurement methods.** Stages 2–5 were measured with a throw-away Node probe that
> loads the real `public/bigOrbit.js` and runs (i) the shipped fixed-point orbit, (ii)
> a 40×30 float64 perturbation emulation of the shipped shader, and (iii) an
> independent per-pixel direct-BigInt iteration of the same exact centre. The
> browser-level numbers are the recorded pins `tests/gpu-arbitrary.spec.js` pin 1 and
> `tests/bigorbit.spec.js` pin 1, which compute the same independent reference in the
> page. Where a number comes from a probe script rather than a committed pin it is
> marked **[probe]**.

---

## 0 · The stated zoom

The whole table is stated at **scale `1e-30`** (zoom 10³⁰), the depth P2 verified
against an independent direct-BigInt reference, and re-stated at **`1e-40`**, the
depth GPU-ARBITRARY verified. The exact view centre used by every measurement is the
P2 Misiurewicz centre from `tests/bigorbit.spec.js`:

```
C0      = -1.4303576324512                       (a float64 literal)
CENTRE  = C0 + 2^-70                             (an exact 640-bit decimal, below C0's float64 ULP)
CENTRE_Y = "0"
```

`2^-70` is below C0's float64 ULP (~2.22e-16), so the requested point is **not
nameable as a float64** at all — that is the P1 wall, and it is exactly what the
exact decimal string exists to cross.

## 1 · The five stages at a glance

| # | Stage | `file:line` | Significand at 1e-30 | Exponent range at 1e-30 | Mechanism (67) | Measured cost |
|---|-------|-------------|----------------------|--------------------------|----------------|---------------|
| 1 | view centre → orbit input | `public/fractalViewer.js:25`, `:165-173`, `:215-226`; `public/app.js:80-82`, `:445-446`, `:1620-1635` | **53 bits** (float64 double) in every production path; a decimal string exists **only** in the `__fv.setDeepView` test hook (`app.js:1620`) | 2^-1022 … 2^1023 | — (the producer of the exact-centre string is missing; this is a *reachability* gap, not a loss inside the chain) | the frame is displaced by the centre's own ULP 2.22e-16 past zoom ~1e16 → at 1e-30 the requested frame is ~10¹⁴ screen-widths from a float64 centre |
| 2 | BigInt reference orbit | `public/bigOrbit.js:37-49`, `:61-65`, `:71-92`, `:143-178` | **192 bits** (`bitsForScale(1e-30)`), margin +64, quantised to 64-bit steps (256 bits at 1e-39+) | **unbounded** (fixed-point: F fractional bits, integer part a BigInt) | — (exists; working) | orbit build once per view: measured 3–7 ms [DECISIONS 63]; counter `bigOrbitComputations` |
| 3 | orbit TRANSPORT to the GPU | `public/bigOrbit.js:105-131` (`toF32`), `public/orbitWorker.js:24-34`, `public/webglFractal.js:134`, `:829-846`, `:265-278` | **24 bits** (one float32 word per component; measured mean **25.78** bits over the range the perturbation actually samples) | 2^-126 … 2^127 normal; subnormals flushed (the `u_scale` range wall is separate, stage 4) | **(a)** | frame-level cost: **mean |Δ| 0.007–0.017 iterations, max 9, 0.0000 % misclassified** at 1e-20…1e-40; extra BigInt precision changes **0.0000 %** of pixels |
| 4 | `u_scale` / `u_scaleShift` delta seed + delta arithmetic | `public/webglFractal.js:240-242`, `:659-685`, `:990-1002`, `:259-309`; `public/fractalKernel.js:201`, `:183`, `:208` | seed arrives at ~2^-40; **delta arithmetic is 24 bits** (float32) | `u_scale = scale·2^shift` normal float32; `S = 2^-shift` normal float32; shift saturates at **120** (≈ scale 1e-48) | **(b)** | delta-width effect **0.003** mean iterations at 1e-30 and **0.005** at 1e-40; measured solver breakdown at **1e-42** (7.4 % misclassified, DECISIONS 57); rescale interval 256 is inert in the reachable float64-orbit range (DECISIONS 34) |
| 5 | CPU lane | `public/fractalKernel.js:435-441`, `:462-473`; `public/fractalWorker.js:5`, `:48`, `:58`; `public/app.js:445-446`, `:473`; `public/fractalViewer.js:85-89` | **53 bits** (float64 direct projection) | 2^-1022 … 2^1023 | **(c)** — **no orbit, no perturbation, no rebasing, no glitch detection at all** | coordinate staircase: 200 distinct x per 200 columns at 1e-12 → **61** at 1e-14 → **7** at 1e-15 → **1** from 1e-16; clamped to scale ≥ **1e-6** in production |

## 2 · Stage 1 — the exact centre string → `bigOrbit.js`

**The path, end to end.**

- The view centre is a float64 double everywhere in production:
  `FractalViewer` initialises `this.view = { centerX: -0.5, centerY: 0, scale: 3 }`
  (`public/fractalViewer.js:25`), and **both** user interactions mutate those doubles
  in place: `panView` does `view.centerX -= dx * scale / width * aspect` and
  `zoomView` does `view.scale *= zoomFactor` (`public/fractalViewer.js:165-173`),
  called from `onMouseMove` (`:197-208`) and `onWheel` (`:215-226`).
- A saved location serialises the **double**: `getCurrentLocationState()` returns
  `centerX: viewer.view.centerX` (`public/app.js:80-82`), and the schema validates
  only `isFiniteNumber(record.centerX)` (`public/memoryRepository.js:97`). So the
  import/export round-trip is float64 too.
- `renderWebGL` hands the renderer the **same double view object**
  (`public/app.js:1353-1359`), and the deep lane only consults an exact string when
  one happens to be present:
  `const exactCentre = typeof view.centerXExact === 'string' && …`
  (`public/webglFractal.js:960-963`).
- `ensureBigOrbit` posts that string to the Worker (`public/webglFractal.js:804-816`),
  which calls `BigOrbit.parseFixed` (`public/bigOrbit.js:71-92`) — the string is
  parsed straight to a BigInt fixed-point value, so **this link loses nothing**.
- **But the only producer of `centerXExact`/`centerYExact` in the whole tree is
  `window.__fv.setDeepView`** (`public/app.js:1620-1635`), the test hook.
  `grep -rn centerXExact public/` returns only that hook and the two consumer checks
  in `webglFractal.js`; `grep -rln centerXExact tests/` returns only the two specs
  that use the hook (`tests/bigorbit.spec.js`, `tests/gpu-arbitrary.spec.js`).

**Consequence (the finding, not an inference).** The arbitrary-precision orbit is
**unreachable from the shipped UI**. In production, `centerXExact` is `undefined`,
so `ensureBigOrbit` is never called and the deep lane runs P1's float64 orbit of the
float64-rounded centre — i.e. the BigInt work is wired and correct but has **no
producer on the user's path**. Closing mechanism (c) and "arbitrary in both paths"
requires, first, a *serialisable exact centre*: the wheel/drag/load path must carry a
decimal string (or a fixed-point pair) that the float64 `centerX` cannot. This is a
**new, separately dispatchable gap** that neither DECISIONS 67 nor the queue named.

## 3 · Stage 2 — the BigInt orbit at several scales

`bitsForScale(scale) = ceil( max(64, ceil(log2(1/scale)) + 64) / 64 ) * 64`
(`public/bigOrbit.js:61-65`). Measured anchors **[probe]**:

| scale | 1 | 1e-4 | 1e-6 | 1e-15 | 1e-19 | 1e-20 | 1e-30 | 1e-38 | 1e-39 | 1e-40 | 1e-42 | 1e-48 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bits | 64 | 128 | 128 | 128 | 128 | 192 | 192 | 192 | 256 | 256 | 256 | 256 |

- **Significand:** the f32/f64 language is the wrong one here — the orbit is
  **fixed point** with `F = bits` fractional bits (`parseFixed`, `shiftRound`), so its
  significand is `F` bits and its **exponent range is unbounded**: the integer part
  is a `BigInt` whose size grows with `|Z|`, so the orbit cannot overflow or
  underflow. It is bounded by memory and time, not by a numeric wall — this is the
  one stage that is genuinely arbitrary.
- **Margin:** +64 (`BIGORBIT_MARGIN`), measured sufficient: the shipped setting
  matches an orbit computed 256 bits wider at 1e-30 (mean |Δ escape index| 0.007, 0
  misclassified), while a deliberately starved setting (`bits = log2(1/scale) - 96`)
  measures mean |Δ| **12.9** (DECISIONS 38).
- **Working precision DOES matter for the raw orbit tail.** The f32-transported
  orbit computed at 192 bits differs from the one at 448 bits in **7 560 of 8 193**
  entries (first difference at index **612**); 448 vs 704 bits differ in 6 511. The
  BigInt recurrence is chaotic, so the two orbits separate once rounding error
  exceeds the float32 resolution. **This is exactly where the dispatcher's 24-bit
  claim would bind — if the shader read those indices. It does not (§5).**

## 4 · Stage 3 — the orbit's transport to the GPU (mechanism a)

**What it is.** `BigOrbit.computeOrbitFixed` returns `Float32Array` words;
`toF32` (`public/bigOrbit.js:105-131`) keeps 53 bits of the BigInt value and then
`Math.fround`s it — a correctly rounded **24-bit** significand. `orbitWorker.js`
transfers those two `Float32Array`s; `_onBigOrbitMessage` uploads them as an **RGBA
FLOAT texture, one texel per iteration, `.r = Re Z_m`, `.g = Im Z_m`**
(`public/webglFractal.js:829-846`), NEAREST + CLAMP_TO_EDGE, and the shader reads
`Zx = o.r; Zy = o.g` (`:265-268`). The float64 lane's orbit is quantised the same way
(`Math.fround`, `public/webglFractal.js:736-737`). The orbit width is
`min(MAX_TEXTURE_SIZE, MAX_ITER) = 8192` (`:134`), so at the shipped cap the orbit is
one texel shorter than `maxIter + 1` and `m` is clamped.

**How many bits actually arrive?** Measured **[probe]**, over the index range the
perturbation actually samples:

| scale | orbit working bits | mean delivered significand bits | worst relative error |
|---|---|---|---|
| 1e-20 | 192 | **25.78** | 5.80e-8 |
| 1e-30 | 192 | **25.78** | 5.80e-8 |
| 1e-40 | 256 | **25.78** | 5.80e-8 |

25.78 rather than 24.0 is the ordinary round-to-nearest gain (a half-ULP error is
2^-25 on average). So **~24 bits of the orbit arrive, and the BigInt precision beyond
that is discarded in transit.** The delivery is exact-round-to-nearest, not lossy
beyond the rounding.

**VERDICT ON THE 24-BIT ORBIT-TRANSPORT CLAIM.** The claim on record
(`docs/STATE.md` QUEUE row MANTISSA-LADDER / `docs/DECISIONS.md` row 67a) is that the
one-float32 transport *"is a second, independent cap that must be lifted
(multi-component orbit words) before deep depths are trustworthy."*

- **CONFIRMED as a statement about significand width.** Only ~24 bits of the orbit
  arrive, whatever the BigInt working precision (`toF32` keeps 53 then frounds to 24);
  changing the BigInt precision leaves the *transport width* unchanged. So the orbit
  delivered to the shader is a 24-bit object by construction.
- **FALSIFIED as the binding depth limit, and as "must be lifted before deep depths
  are trustworthy."** Measured through the real deep path against an **independent
  per-pixel direct-BigInt reference** (no orbit, no deltas, its own parser and
  rounder — `tests/gpu-arbitrary.spec.js` pin 1), the shipped 24-bit transport is
  **0.00000 % misclassified at 1e-30, 1e-35 and 1e-40** (mean |Δ escape index|
  0.003–0.007, DECISIONS 57/116). My own **[probe]** isolation (same frame, float64
  delta, orbit at 192 vs 448 vs 704 bits) measures **0.0000 % difference** between the
  orbits: extra BigInt precision buys **nothing** in the frame. And the reason is
  measured: **the per-pixel perturbation never samples the orbit tail.** On the P2
  centre the largest reference index `m` reached during a full 1e-30 frame is **364**
  (164 at 1e-15), because rebasing resets `m` to 0 (`public/webglFractal.js:289-293`)
  long before the orbit's own chaotic divergence (first difference at index 612) is
  reached. The indices where the 24-bit transport is the binding quantiser — the tail
  of the orbit — are **not read**.

So mechanism (a) is real but **second-order at every depth this repo has verified**:
its frame-level cost is ≤0.017 iterations mean and 0 misclassification through 1e-40.
It becomes the binding mechanism only **after** mechanism (b) is widened (and the
reference tail is sampled) — i.e. it is the *next* rung of the ladder, not the
current wall. The dispatcher's "regardless of the BigInt work" is right about the
width and wrong about the consequence.

## 5 · Stage 4 — the delta seed and the delta's arithmetic width (mechanism b)

**The seed.** `deepScaleUniforms` (`public/webglFractal.js:659-685`) splits the scale:
`shift = clamp(round(-40 - log2(scale)), 0, 120)`, `u_scale = scale·2^shift`,
`u_scaleShift = shift`; the shader forms `S = exp2(-shift)` and
`dcx = (v_uv.x-0.5)·u_scale·u_aspect` (`:240-242`). The physical offset is unchanged
because `2^shift·2^-shift = 1` exactly. Measured seed values **[probe]**:

| scale | shift | `u_scale` | `S` | `S` subnormal? |
|---|---|---|---|---|
| 1e-4 | 0 | 1.000e-4 | 1.000e0 | no |
| 1e-15 | 10 | 1.024e-12 | 9.766e-4 | no |
| 1e-20 | 26 | 6.711e-13 | 1.490e-8 | no |
| 1e-30 | 60 | 1.153e-12 | 8.674e-19 | no |
| 1e-40 | 93 | 9.904e-13 | 1.010e-28 | no |
| 1e-42 | 100 | 1.268e-12 | 7.889e-31 | no |
| 1e-48 | 119 | 6.646e-13 | 1.505e-36 | no |
| 1e-50 | **120 (saturated)** | 1.329e-14 | 7.523e-37 | no |

- **Exponent range:** the seeded delta is deliberately aimed at ~2^-40 (normal,
  comfortably above float32's 2^-126 normal floor); `S` is a normal float32 down to
  `shift = 120` (S = 2^-120 ≈ 7.5e-37). Past `shift = 120` (scale ≈ 1e-48) the split
  **saturates** and `u_scale` starts shrinking again — that is the range mechanism's
  own measured end. It is **not** the binder at 1e-30 (shift 60) or 1e-40 (shift 93).
- **Significand: 24 bits.** The delta and every shader operation are float32
  (`public/webglFractal.js:259-309`). My faithful float32 emulation **[probe]**
  (fround on every op, the shipped seed, no FMA contraction — a caveat, since GLSL may
  fuse) measures the delta-width effect alone at **0.003** mean iterations at 1e-30
  and **0.005** at 1e-40. The **recorded solver breakdown** is **1e-42: 7.4 %
  misclassified** for the single-factor `S` (DECISIONS 57). This is the first
  precision mechanism to fail as depth grows, and it is exactly what the k-component
  mantissa ladder (DECISIONS 66) exists to widen.
- **Rescaling is inert in the reachable range.** `PERTURB_RESCALE_INTERVAL = 256`
  (`public/fractalKernel.js:201`); measured bit-identical at 256/64/1024/off for
  every scale a float64 orbit can reach (DECISIONS 34). It is the range mechanism the
  arbitrary-precision orbit needs, not a current cost or benefit.
- **Glitch detection.** `PERTURB_GLITCH_G = 1e-4` (`public/fractalKernel.js:183`);
  at 1e-15 it fires on 73.8 % of pixels — a diagnostic, not a repair trigger
  (DECISIONS 35). (Small source note, not a finding: the shader's `z2g` at
  `webglFractal.js:285` combines `|Z_m|²` with the *next* `Z_{m+1}` and the new delta;
  the CPU prototype implements the standard Pauldelbrot form on one state. Neither
  feeds the rendered value.)

## 6 · Stage 5 — the CPU lane (mechanism c)

**Confirmed independently from the code (not taken from the probe).**

- `public/fractalKernel.js:462-473` (`calcFractalChunk`) computes each pixel's
  coordinate with the **direct absolute float64 projection**
  `cx = view.centerX + (x - width/2)·scale/width·aspect`,
  `cy = view.centerY + (y - height/2)·scale/height`; the same formula is
  `pixelToCoord` at `:435-441`. There is **no reference orbit, no delta, no rebasing
  and no glitch detection anywhere in the CPU lane**:
  `grep -cin "orbit\|perturb\|rebase\|glitch" public/fractalWorker.js public/fractalViewer.js`
  → **0 and 0**; `public/fractalKernel.js` mentions them only as the exported P1
  constants `PERTURB_GLITCH_G` / `PERTURB_RESCALE_INTERVAL` (`:183`, `:201`, `:530-531`),
  which the GPU shader templates and the CPU kernel never reads.
- `public/fractalWorker.js:5` loads only the kernel (`importScripts('fractalKernel.js')`)
  and `:58` calls only `calcFractalChunk`. The job it receives carries the float64
  `view` (`public/app.js:809`), so even if an exact-centre string were present it
  would be ignored.
- **The clamp.** The **shared** viewer carries the GPU cap —
  `viewer.setZoomLimit(WEBGL_MIN_SCALE, …)` (`public/app.js:473`) with
  `WEBGL_MIN_SCALE = 1/WEBGL_ZOOM_CAP` (`:445-446`) — and `clampScale`
  (`public/fractalViewer.js:85-89`) applies it on every path, so the CPU lane is
  clamped to exactly the same scale. **Disagreement with the record, measured:**
  DECISIONS 63 and the board's `PROBE-DONE` row say the CPU lane is clamped to
  `scale >= 1e-4`. That was true when `WEBGL_ZOOM_CAP = 1e4`; GPU-ARBITRARY lifted the
  cap to **`1e6`** (`public/app.js:445`), so the clamp is now `scale >= 1e-6`. The
  *conclusion* of DECISIONS 63 is unaffected (the CPU lane still cannot deep-zoom),
  but the *number* on the board is stale and should read **1e-6**.
- **The collapse, measured [probe]** on C0 with 200 sampled columns (distinct
  projected x): **200** at 1e-12, **61** at 1e-14, **7** at 1e-15, **1** from 1e-16
  onward. C0's float64 ULP is 2.22e-16 and the per-pixel offset at 1e-15 is
  6.7e-16, so the projection's catastrophic cancellation quantises the frame to a
  handful of coordinates. The probe's numbers (200/26/3/1, a different centre) agree
  qualitatively.

**So "arbitrary precision in both paths" fails on the CPU path for a different and
larger reason than on the GPU:** the CPU lane does not lose precision — it has **no
deep-zoom algorithm at all**. Mechanism (c) is a port, not a tuning.

## 7 · What limits depth, ranked

No precision mechanism is *failing* at 1e-30 or 1e-40 on this centre: the shipped
GPU frame is **0.00000 % misclassified** at both (DECISIONS 57/116), and the total
per-pixel error against the independent direct-BigInt reference is **mean 0.007–0.020
iterations** (0.003–0.017 of it the 24-bit orbit transport, 0.003–0.005 the float32
delta). The ranking below is therefore about **what binds next**, each with the
number that justifies it.

### At scale 1e-30
1. **REACHABILITY — the app cap.** `WEBGL_ZOOM_CAP = 1e6` → `WEBGL_MIN_SCALE = 1e-6`
   (`public/app.js:445-446`), enforced by the shared clamp (`public/fractalViewer.js:85-89`).
   1e-30 is **24 decades** past the deepest view a user can reach; every 1e-30 number
   in this file is reachable only through `__fv.setDeepView`. The CPU lane is clamped
   to the same 1e-6.
2. **THE FIRST PRECISION MECHANISM TO BIND — the float32 DELTA mantissa (67b).**
   Incremental cost **0.003 mean iterations** at 1e-30; the measured solver breakdown
   is **1e-42 (7.4 % misclassified, DECISIONS 57)**. This is the next thing that
   fails as depth grows, and it is a mantissa-width problem no constant can fix — the
   k-component ladder (DECISIONS 66) is the remedy.
3. **THE ORBIT TRANSPORT, 24 bits (67a) — second-order.** Frame-level cost
   **0.007–0.017 mean iterations, max 9, 0.0000 % misclassified**; extra BigInt
   precision changes **0.0000 %** of pixels because the perturbation samples only the
   first **364** orbit indices. It becomes binding only after (2) is widened.

*(Also measured, not binding here: the D2 budget rule wants `ceil(512·30) = 15360`
but `MAX_ITER = 8192` clamps it (`public/fractalKernel.js:42`); on this centre the
largest iteration any pixel needed was **401**, so `0/768` pixels change
classification between cap 8192 and cap 32768. On the P2 probe's other centre at
1e-12 the need was **9011 > 8192** (probe item 7), so the budget clamp can bind
elsewhere — it is a frame/centre property, not a fixed wall.)*

### At scale 1e-40
1. **REACHABILITY — the app cap**, now **34 decades** past the deepest reachable view.
2. **THE float32 DELTA mantissa (67b)** — incremental cost **0.005 mean iterations**,
   and only **~2 decades** from its measured **1e-42 / 7.4 %** breakdown. Widening the
   delta (k components) is the only thing that extends this.
3. **THE ORBIT TRANSPORT, 24 bits (67a)** — still second-order: 0.007 mean iterations,
   max ~3, **0.0000 % misclassified**, and still only the first few hundred orbit
   indices are sampled. The delta RANGE split (shift 93 of a 120 saturating shift) is
   *not* binding at 1e-40; it ends near scale 1e-48.

**The CPU lane is off this ranking entirely at both scales** (mechanism c): it cannot
render 1e-30 or 1e-40 at all (1 distinct coordinate from 1e-16), so its first
requirement is the orbit+perturbation port, not a precision improvement.

## 8 · What is UNVERIFIED

- **Hardware.** All GPU numbers are SwiftShader. Whether the shipped exponent split
  and any future k-component delta survive a real GPU's FMA/reassociation is
  UNVERIFIED (RESEARCH §7 warning 2; DECISIONS 47).
- **Other centres / fractal types.** The orbit-tail finding (max `m` = 364) and the
  budget-saturation result are properties of the P2 Misiurewicz centre and the
  Mandelbrot type. A centre that rebases less often would sample deeper orbit
  indices, where the 24-bit transport could bind sooner. The perturbation lane is
  Mandelbrot-only by construction (`public/webglFractal.js:945-947`).
- **The float32 delta emulation [probe]** uses non-contracted `Math.fround`; GLSL on
  a real driver may contract to FMA, which changes the exact error. The recorded
  browser numbers (DECISIONS 37/57) are the authority for the delta.
- **The exact-centre producer gap** (§2) is a code fact, but *how* the UI should
  carry an exact centre (a decimal string per view change? a fixed-point delta chain?)
  is a design question this document does not settle.
- **The `z2g` mismatch** at `public/webglFractal.js:285` is noted from reading the
  shader; whether it changes the `u_diag = 1` glitch fraction was **not** measured.

---

## 9 · PART 2 — the CPU port prototype, measured

`public/fractalPerturb.js` (new, no `import`/`export`, publishes
`globalThis.FractalPerturb`) implements mechanism (c): the same perturbation
architecture the GPU lane runs — the reference orbit from `BigOrbit.computeOrbitFixed`
(the ONE orbit implementation), float64 delta iteration, rebasing by the GPU's
absorbed rule, and Pauldelbrot glitch detection — and it maps the escape state through
`FractalKernel.smoothIterationValue`, so it owns **no** palette, cap or smooth-colour
math (DECISIONS 52). `tests/fractal-perturb.spec.js` pins it.

**Correctness, against an independent direct-BigInt reference (its own parser and
rounder, no orbit, no deltas), 48×36, cap 8192, through the committed pin:**

| scale | orbit bits | port: misclassified | port: mean \|Δ smooth\| | port: distinct colours | shipped CPU lane: misclassified | lane: mean \|Δ\| | lane: distinct |
|---|---|---|---|---|---|---|---|
| 1e-30 | 192 | **0.00000 %** | 0.023 | 646 / 646 | 2.78 % | 226.6 | 19 |
| 1e-40 | 256 | **0.00000 %** | 0.013 | 610 / 611 | 2.78 % | 231.1 | 19 |
| 1e-120 | 512 | **0.00000 %** | 0.00 | — | 4.17 % | ~295 | 13 |

**The failing baseline is in-pin:** the SAME view through the shipped lane's own code
(`FractalKernel.calcFractalChunk`, the direct absolute float64 projection) is 2.8–4.2 %
misclassified with a mean error of ~230–300 iterations and ~19 distinct colours — the
flat coordinate staircase this port removes.

**Reach [probe], 16×24–32×24, the same independent reference:** the port matches at
**1e-50, 1e-60, 1e-80, 1e-100, 1e-120, 1e-150, 1e-200 and 1e-250** (0.0000 %
misclassified, mean \|Δ\| ≤0.008) and begins to degrade at **1e-300** (6.3 %
misclassified, mean 0.063) — where the per-pixel float64 offset itself approaches
underflow (~1e-308) and the 24-bit orbit transport finally starts to count. The shipped
lane is already 4.2–8.3 % misclassified at every one of those scales.

**Cost, measured in the browser on this host (SwiftShader-irrelevant; this is the JS
engine's own float64), 320×240, one full frame, orbit build amortised:**

| scale | cap | orbit bits | ms / 320×240 frame | ms / kpx | orbit build | rebases / frame | max orbit index sampled |
|---|---|---|---|---|---|---|---|
| 1e-20 | 8192 | 192 | **118** | 1.53 | 5–11 ms | 188 184 | 236 |
| 1e-30 | 8192 | 192 | **187** | 2.43 | 5–11 ms | 189 390 | 372 |
| 1e-40 | 8192 | 256 | **251** | 3.27 | 5–11 ms | 185 644 | 508 |

At 160×120 the same frames cost 30 / 47 / 63 ms. **Usable, with caveats:** a per-pixel
cost that grows only ~2× from 1e-20 to 1e-40; a 320×240 deep frame is a fifth of a
second on ONE core, and a full-window (1280×800) frame is ~4–6× that — so like the
shipped CPU lane it wants the row-band tiling the CPU-PATH probe measured at 11.6× and
the existing 8→4→2→1 progressive refinement. The orbit is built **once per view**
(measured: two extra re-renders of one view add **0** builds).

**Is the CPU path "genuinely arbitrary" once ported? — measured answer: the ORBIT is,
the DELTA is not yet.** The BigInt orbit's precision does grow with depth
(192→256→512 bits over the table above) and its exponent range is unbounded, so the
reference is exact. But the per-pixel delta in this port is **float64 (53-bit)**, so
the port is bounded by the float64 delta's own range/precision (~1e-300 measured here),
not by the orbit. **Mechanism (b) — the delta-width ladder — applies to the CPU path
too.** What the port *does* deliver is a measured jump from "cannot render 1e-16 at
all" to "0.00000 % misclassified at 1e-120, degrading near 1e-300", and it needs no
new arithmetic library: the CPU already has `bigOrbit.js` and JS `BigInt`.

**Two honest notes.** (1) Rebasing fires 46k–190k times per frame but is nearly inert
on THIS centre with float64 deltas — the no-rebase arm measures mean 0.043 vs 0.022 at
1e-30 and is identical at 1e-20/1e-40 — which is the same "range mechanism inert inside
the reachable range" result DECISIONS 34 recorded for rescaling; its value is on other
centres and in the float32 formulation. (2) The correct Pauldelbrot detector fires on
**0** pixels here after rebasing, while the GPU's `u_diag` pass measured 73.8 % at
1e-15 (DECISIONS 35); the difference is the shader's mixed-state `z2g`
(`public/webglFractal.js:285`). The detector is diagnostic on both paths, so neither
number changes a rendered value — but the two are not measuring the same quantity.

**What remains for the integration slice:** (i) wire `calcPerturbChunk` into
`public/fractalWorker.js` and the job/dispatch path (a modification this read-only-safe
slice deliberately did not make); (ii) give the UI an exact-centre producer (§2); (iii)
a wide (float64 or multi-component) orbit accessor from `bigOrbit.js` so the CPU never
inherits the GPU's 24-bit transport; (iv) the delta ladder for both lanes; (v) tiling.
