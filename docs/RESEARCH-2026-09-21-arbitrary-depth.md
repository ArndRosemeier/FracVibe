# RESEARCH — arbitrary zoom depth in browser/WebGL renderers (cited)

- **Probe:** subagent `b5bc3b56-6098-4d16-a501-3770a3ce3aa2`, read-only (wrote nothing — this
  file is the dispatcher's transcript of its return, so the evidence survives the session).
- **Question asked:** how do real implementations reach **arbitrary** zoom depth (as deep as the
  user wants, accepting slowdown) rather than stopping at ~1e10–1e15?
- **Why it matters here:** the perturbation probe
  (`docs/PROBE-2026-09-21-perturbation.md`)measured a *naive* perturbation implementation failing at
  1e15 with 74.6 % glitches and blamed the float32 delta arithmetic. This research says the naive
  build was missing the two mechanisms that keep deltas representable — **rebasing** and
  **rescaling** — so that failure was a missing-mechanism result, not a precision ceiling.

## 1 · Precision growth rule — CONFIRMED, with the margin unsettled
- `pixel_spacing = view_radius / height`; `pixel_spacing_bits = -log2(pixel_spacing)`. Majewski's
  table (derived from Claude Heiland-Allen's book) gives **61 bits for radius 2.158e-16 at height
  1000**, and **exactly +1 bit per doubling of magnification** ⇒ **3.3219 bits per decimal digit**
  (= log2 10). So `bits ≈ log2(1/scale) + margin` is right.
  <https://gitlab.com/adammajewski/zoom_precision/-/blob/master/README.md>
- rust-fractal-core uses `precision = max(64, -radius.exponent + 64)` ⇒ **bits ≈ log2(zoom) + 64**,
  floor 64. <https://raw.githubusercontent.com/rust-fractal/rust-fractal-core/master/src/renderer.rs>
- The Fraktaler 3 / Kalles Fraktaler **manuals state no formula**: F3 picks a number type from
  "wisdom" benchmark metadata, KF exposes a fixed ladder of types.
  <https://fraktaler.mathr.co.uk/>, <https://mathr.co.uk/kf/manual.html>
- **Consequence:** the shape is settled; the MARGIN is not standardized (0 in the bare bound, +64
  in rust-fractal-core, implicit in KF/F3's ladders).

## 2 · Orbit arithmetic
- **Kalles Fraktaler:** GMP + MPFR arbitrary-precision float (Boost wrapper, `gmp_float<0>`, long
  double in the EXE), "virtually unlimited precision (memory needed for precise numbers is an
  issue)", MPFR capped at 2 giga-bits. **Reference runs on the CPU, multithreaded (≤64 threads).**
  <https://mathr.co.uk/kf/manual.html>
- **Fraktaler 3:** number-type ladder — float, double, long double (x87), `_Float128`, floatexp /
  doubleexp — plus MPFR; runs on CPU or OpenCL, chosen by wisdom. <https://fraktaler.mathr.co.uk/>
- **rust-fractal-core:** reference iterated at arbitrary precision (rug/MPFR), deltas in machine
  precision, mantissa-exponent extended range; "verified … exceeding E50000".
  <https://github.com/rust-fractal/rust-fractal-core>
- **BROWSER case — the closest analogue:** bertbaron/mandelbrot computes reference points in
  **BigInt fixed point** in JavaScript, with the size growing with zoom; deltas in float64, or
  float64/float32 **plus a shared implicit exponent**. <https://github.com/bertbaron/mandelbrot>
- **GPU reference:** FractalShark is the outlier — the high-precision reference recurrence runs in a
  fused CUDA kernel doing NTT multiplication over 32-bit limbs (16384 limbs ≈ 158 000 decimal
  digits). <https://github.com/mattsaccount364/FractalShark>

## 3 · Per-pixel delta precision, and what actually keeps deltas small
- 53-bit double is the norm. Claude: "Double precision … (53 bits) is more than enough for computing
  perturbed orbits: even single precision (24 bits) can be used successfully."
  <https://mathr.co.uk/blog/2021-05-14_deep_zoom_theory_and_practice.html>
- **REBASING** — when `|Z_m + z_n| < |z_n|`, set `z_n ← Z_m + z_n` and reset the reference iteration
  `m ← 0`.
- **RESCALING** — substitute `z = S·w`, `c = S·d` so `w → 2Zw + S·w² + d` with `|w| ≈ 1`, re-scaling
  every few hundred iterations. **This is what stops double UNDERFLOW, which is the real limit near
  1e308** — not mantissa precision. A full-range (floatexp) iteration is forced when `|Z|` itself
  gets tiny, then re-rescaled.
  <https://mathr.co.uk/web/deep-zoom.html>,
  <https://mathr.co.uk/blog/2021-05-14_deep_zoom_theory_and_practice.html>
- KF ships "rescaled double" (≈1e600 power-2 / 1e400 power-3) and "rescaled single"; single is
  **disabled by default because of "undetected glitches"** at some locations.
  <https://mathr.co.uk/kf/manual.html>

## 4 · Glitch detection, rebasing strategies, and their VISUAL ARTIFACTS
- **Detection (Pauldelbrot):** `|Z + z|² < G·|Z|²` with G "somewhere between **1e-2 and 1e-8**";
  nearly free because `|Z+z|²` is already computed for the escape test. KF exposes it as a
  **"Glitch tolerance"** slider (1 = good but very slow, 0 = fast but bad images), plus a
  "Derivative glitch test" and a "Reference strict zero" test.
  An older/looser statement of the same idea: `|Z_m + z_n| < |z_n|`.
  <https://mathr.co.uk/blog/2021-05-14_deep_zoom_theory_and_practice.html>,
  <https://mathr.co.uk/web/deep-zoom.html>
- **Strategies:** **S1** rebase to the SAME reference (`dz := Z+z; RefIteration := 0`); **S2** spawn a
  NEW reference near a glitched pixel and re-render affected pixels (KF "Auto solve glitches",
  "Add reference", selection by argmin|z| or random; default cap 10 000 secondary references);
  **S3** "near pixel" method — re-render only connected pixels sharing an iteration count;
  **S4** interpolate isolated single-pixel glitches from neighbours.
  <https://web.archive.org/web/20230125202704/https://fractalforums.org/f/28/t/4360>,
  <https://mathr.co.uk/kf/manual.html>
- **Artifacts, as documented — this is the owner's hard requirement:** S1 — images differ slightly
  from S2's (the author's diff images show single-reference closer to 97-reference than 22-reference
  is); "single reference" broke KF hybrids. S2 — glitched regions show a **"noisy appearance"** or
  **"weird flat blobs"**, and KF has known bugs of "endless references … comes to no end" and
  "endless references with little progress" (argmin|z|), worst case re-rendering large areas. S3 —
  **can corrupt pixels that merely share an iteration count**. S4 — **deliberately smooths real
  detail**.
- **Precision/number-type TRANSITIONS:** the only documented defect found is historical — KF
  2.13.10 (2018) "bugfix: corrupt image at transition between number types (eg near e600)". **No
  current source states the transition cost or appearance for F3/KF.** That is the gap the owner's
  requirement lives in.
- Other documented artifact classes: too-low "Max Ptb Iters" ⇒ blobby spiral centres / non-sharp
  mini-sets; too-low "Maximum BLA steps" ⇒ glitchy areas; wrong reference period ⇒ pixelation.
  <https://fraktaler.mathr.co.uk/>

## 5 · Series approximation (and BLA)
- **Primary (K.I. Martin, SFT):** perturbation `Δ_{n+1} = 2X_nΔ_n + Δ_n² + Δ_0`; series
  `Δ_n = A_nδ + B_nδ² + C_nδ³ + o(δ⁴)` with `A_{n+1} = 2X_nA_n + 1`, `B_{n+1} = 2X_nB_n + A_n²`,
  `C_{n+1} = 2X_nC_n + 2A_nB_n`. Valid "as long as the δ³ term has a magnitude significantly
  smaller than the δ² term". Buys: per-pixel time "largely independent of depth and iteration
  count". <https://web.archive.org/web/20160408070057if_/http://superfractalthing.co.nf/sft_maths.pdf>
- **Practice:** implementations do NOT use that analytic test — they iterate a few **probe points**,
  compare SA output against real perturbed iterations, and when it deviates roll back one iteration
  and initialise every pixel from the series there. Probe-based skipping is also stated in
  rust-fractal-core. <https://mathr.co.uk/blog/2021-05-14_deep_zoom_theory_and_practice.html>,
  <https://github.com/rust-fractal/rust-fractal-core>
- **Failure modes / when to disable:** KF's "Series approximation tolerance" (1 = good but slow,
  0 = fast but bad) and a "No series approximation" toggle; KF bug "analytic DE broken with some
  power 3 Mandelbrot locations (workaround: disable series approximation)"; Burning Ship SA "stops
  at the first fold (typically 1 period of a central miniship)".
  <https://mathr.co.uk/kf/manual.html>
- SA reduces **per-pixel** low-precision work, **not** the reference's high-precision requirement;
  coefficients are per-reference. NanoMB1/2 extend it to two variables and need an exact period;
  NanoMB2 "disables glitch detection and correction". F3 replaces SA with **BLA** (bivariate linear
  approximation) with an analogous "Maximum BLA steps" limit whose failure is glitchy images.
- **Honesty from the field:** "there is still no complete mathematical proof of correctness with
  rigorous error bounds" either for choosing G or for SA skipping.

## 6 · GPU feasibility
- **Correction to a premise I had repeated:** the FOSDEM 2023 talk "Multiple Double Arithmetic on
  GPUs" (Jan Verschelde) is about QDlib/CAMPARY multiple-double **for the polynomial-homotopy
  package PHCpack — NOT fractals**. It evidences generic GPU multiple-double practice only.
  <https://archive.fosdem.org/2023/schedule/event/gpu_multiple_double_arithmetic/>
- **KF:** "Currently OpenCL is used for perturbation iterations only"; fp64 auto-detected; for
  ~1e300–1e4900 **the CPU is likely faster** because OpenCL lacks x87 long double and must use the
  slower floatexp type. ⇒ **reference on CPU, deltas on GPU**.
- **Fraktaler 3 (older manual):** "OpenCL is only good until about 1e300 zoom (double precision)";
  its CPU path can use long double through ~1e4920.
- **FractalShark:** the counter-example — a fused CUDA kernel doing the high-precision reference via
  NTT over 32-bit limbs, plus a custom "2×32 + shared exponent" ≈48-bit-mantissa CUDA type.
- **Browser/WebGPU:** bertbaron reaches **~1e1500 "still within seconds"** before artifacts with
  float32 + extended exponent; "WebGPU does not support float64 yet. To take it even further
  Double-Double arithmetic might be an option, but this is not implemented yet." Its **reference is
  still computed in BigInt on the CPU/JS side** — textbook CPU-orbit-uploaded, GPU-deltas.

## 7 · Reference implementations (reading order, most useful first)
1. <https://mathr.co.uk/web/deep-zoom.html> — consolidated, corrected theory (perturbation, exact
   rebasing rule, BLA, DE, references). **Start here.**
2. <https://mathr.co.uk/blog/2021-05-14_deep_zoom_theory_and_practice.html> — the engineering
   narrative: glitch criterion and its open threshold, rescaling to dodge underflow, probe-based SA,
   and an honest list of what is unsolved.
3. <https://mathr.co.uk/kf/manual.html> — what a shipping arbitrary-depth explorer exposes and where
   it breaks (number-type ladder, glitch tolerance, artifacts, known bugs).
4. <https://web.archive.org/web/20230125202704/https://fractalforums.org/f/28/t/4360> — primary
   pseudocode and author discussion of single-reference rebasing, with measured visual equivalence.
5. <https://github.com/bertbaron/mandelbrot> — closest analogue to a browser target: explicit
   zoom→arithmetic ladder, BigInt reference, float32+exponent WebGPU deltas.

## CONTRADICTIONS between sources
1. **Delta precision:** the blog says 24-bit single "can be used successfully"; KF disables single by
   default because of "undetected glitches at some locations".
2. **Glitch threshold G:** the blog hedges G anywhere in 1e-2…1e-8 and says choosing it "remains
   open"; deep-zoom.html states the criterion with no G at all; KF exposes it as a user slider whose
   extremes are "good but very slow" vs "faster but bad images". **Nobody publishes a principled G.**
3. **Rebasing target:** Pauldelbrot/KF add NEW references; Zhuoran + Claude rebase to the SAME
   reference. Claude's own diff images show these are NOT identical (1-ref vs 97-ref), though closer
   than 22-ref.
4. **BLA vs SA:** KF's author calls BLA "much better than series approximation (including NanoMB1
   and NanoMB2)" but will not implement it in KF; F3's manual warns "Reusing bilinear approximation
   is not generally applicable".
5. **GPU relevance:** the FOSDEM multiple-double citation is about homotopy, not fractals; F3 3.0.305
   says OpenCL is good only to ~1e300 while KF says OpenCL stays usable deeper via slow floatexp;
   FractalShark contradicts the "reference is CPU-bound" consensus. And bertbaron's WebGPU path is
   float32+exponent, already running out of room.
6. **Retracted material:** deep-zoom.html explicitly retracts an earlier BLA validity check ("my
   earlier attempt at a validity check was nonsense").

## UNKNOWN / COULD NOT VERIFY (do not fill these by plausibility)
- F3's source-level precision selection (`code.mathr.co.uk` git web returns HTTP 403; no mirror).
- FOSDEM 2025 slide content (fetch blocked) — whether it mentions fractals at all.
- KF's exact bits-vs-zoom formula (not in the manual; source unreachable).
- **Any current, authoritative statement on how a precision TRANSITION looks or costs in F3/KF
  during interactive zoom** — only the 2018 KF corruption bugfix was findable. This is precisely the
  question our owner's requirement turns on.
- Whether F3's Web build computes its reference in WASM/CPU or on the GPU.
- The StackOverflow WebGL2 series-approximation/perturbation question (HTTP 403).
- SuperFractalThing's paper contains the algebra only — **no bits-per-zoom guidance**.
- **Any rigorous error bound or correctness proof** for rebasing, G, or SA skipping — explicitly
  absent per Claude.
- FractalShark's GPU numbers and bertbaron's ~1E1500 / rust-fractal's E50000 are **authors' own
  claims, not benchmarked by this probe**.

## 7 · GPU extended-precision LIBRARIES AND TECHNIQUES (web search 2026-09-21, owner-directed)

The prior conclusion "no library exists for the GPU" was **wrong as stated**: GLSL/WGSL
high-precision arithmetic libraries exist, several are aimed at *exactly* our problem
(deep-zoom fractal rendering), and one ships a production WebGL/WebGPU implementation with
a documented precision benchmark. Sources below; treat them as external and unvetted until
we measure them here.

### What exists
- **luma.gl `fp64` / `fp64arithmetic`** (vis.gl — production WebGL2/WebGPU library) —
  double-single ("expansion") arithmetic in **both GLSL and WGSL**; the guide explicitly
  demonstrates **deep-zoom Mandelbrot** with an fp32-vs-fp64 side-by-side and a precision
  benchmark. **Up to ~48 significant bits (~14 decimal digits)**, within the f32 exponent
  range. Also ships **integer-controlled double-single** for backends whose compiler will not
  preserve rounding points, and `fp64u32` exact-delta helpers.
  <https://github.com/visgl/luma.gl> · <https://luma.gl/docs/api-guide/shaders/gpu-floating-point-precision>
- **`glsl-arbitrary-precision`** — "an arbitrary-precision arithmetic library for GLSL".
  <https://github.com/RohanFredriksson/glsl-arbitrary-precision>
- **`glsl-arb-prec`** — "a mini-library for performing arbitrary-precision arithmetic in
  OpenGL ES Shader Language" (i.e. exactly our GLSL ES 1.00 target).
  <https://github.com/alexozer/glsl-arb-prec>
- **CAMPARY** — CUDA multiple-precision arithmetic (library + applications).
  <https://hal.science/hal-01312858/document>
- **deep-fractal** (munrocket/JMaio) — a WebGL deep-zoom Mandelbrot viewer built on
  perturbation theory: a working reference implementation of the architecture we use.
  <https://github.com/JMaio/deep-fractal>

### The technique ladder (mapped onto OUR failure mode)
Precision = **significand width**; the shipped exponent split fixed **range**. For the delta
mantissa the established options, cheapest first:

| technique | precision | notes for us |
|---|---|---|
| double-single (`hi + lo`) | ~48 bits | what DECISIONS 37 measured here, at 10.4–12.5× fragment cost |
| integer-controlled double-single | ~48 bits | deterministic rounding points; robust where the compiler reassociates |
| full software binary64 | 53 bits + binary64 range | "expensive, but a small application-specific subset can be reasonable" |
| fixed point | chosen | the guide lists **"deep iterative calculation over a bounded interval"** as its fit — that is literally our kernel |
| k-component expansion | ≈ k × 24 bits | the general ladder; cost ≈ k |

### TWO WARNINGS THAT CHANGE OUR PLAN
1. **WGSL's floating-point rules permit reassociation and fusion, and do not specify one
   rounding direction — so the classic double-single transforms are NOT portable in WebGPU.**
   An error-free transform is an algorithm over *rounding events*: the low term of `TwoSum` is
   algebraically ZERO over the reals, so a reassociating compiler can erase the very
   information being recovered. luma.gl therefore selects an **integer-controlled** path on
   Apple WebGPU automatically, and states plainly that `let`/`var` assignment, parentheses,
   identity `bitcast`, `+0.0`, `*1.0` and WGSL `fma` are all **not** portable precision
   barriers. **Consequence for us: a WebGPU mantissa ladder must use integer-controlled
   transforms, or be validated per-adapter — the GLSL route is safer than the WGSL route.**
2. **Validation requires real hardware.** The guide is explicit: "a software adapter or a
   compile-only test cannot demonstrate that residual terms survive execution", and it
   recommends inspecting **both the high component and a required nonzero low component**,
   because "a final value can look plausible even after the expansion silently collapses to
   f32". **This host runs SwiftShader for BOTH WebGL and WebGPU**, so our measurements here
   can develop and falsify the mechanism but **cannot certify that the extra precision
   survives on real GPUs** — that certification needs hardware we do not have.

### What this means for DECISIONS 64/65 (unchanged in substance, sharpened in route)
The 1e-42 limit remains a **solver limitation, not a floor** — now with named, existing
implementations to build from rather than a from-scratch derivation. The ladder is
double-single (measured here) → integer-controlled double-single (robust) → k-component
expansion → full software binary64 (arbitrary), each bounded by time, not by a wall.
