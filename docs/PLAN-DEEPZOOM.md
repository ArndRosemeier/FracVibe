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
| **D2** | **Zoom-scaled iteration budget.** The probe proved the view centre escapes only at iteration **3085**, so at the shipped maxIter (512/2000) every deep frame saturates to "inside" — 1e6/512 = 90.8% inside, 1e8/512 = 100%. **Without this, no deep zoom is meaningful at any precision.** Scale maxIter with zoom (and surface it), so detail appears instead of black. | at a fixed deep view, raising the budget changes the image (it is no longer saturated) and the reference classification is reproduced; the budget follows zoom monotonically; the existing maxIter cap/UI pins still hold | **LANDED & VERIFIED** — writer FULL gate exit 0, **52 passed**. The rule is `effective = max(sliderValue, floor(zoom))` with the slider as a FLOOR; the floor is OFF at and above the shipped GPU zoom cap's scale and grows **512 iterations per decade** below it (zoom 1e8 -> **4096**, exactly the budget the probe used; 1e15 -> 7680), and `MAX_ITER` is raised 2000 -> **8192** as the ONE cap (S3 pin 2 stays green). At the probe's centre / scale 1e-8, measured with the app's own kernel at 200x150: the fixed 512 budget is **100.0% inside** (the frame is black) and the scaled 4096 budget is **0.0% inside** (a real image). The effective budget and the `"(auto)"` readout are observable at `window.__fv`; the colour table is sized by the job's own cap and cached (0 rebuilds over repeated renders, 4.0 MB at cap 4096 instead of 8.0 MB at the module maximum). Pins in `tests/iter-budget.spec.js`; decisions in `docs/DECISIONS.md` rows 30-32. **Stated limitation:** the shipped GPU zoom cap (1e4) clamps every UI path to scale 1e-4, which is exactly where the floor starts, so the floor is DORMANT until P4 lifts that cap — the pin drives the deep view through `__fv.setDeepView`, which lifts ONLY that clamp and restores it. |
| **P1** | **The perturbation core** (the owner's chosen route, §6). A **reference orbit** for the view centre computed ONCE per view at float64 precision on the CPU and uploaded to the GPU, then per-pixel **delta** iteration `dz ← 2·Z·dz + dz² + dc` in the shader, with compensation wherever cancellation bites (the probe measured that hi+lo compensation works). This is what removes the handoff. | on a glitch-free deep view the GPU matches a float64 reference within a stated threshold at 1e6 and beyond; the orbit is computed **once per view, not per pixel** (counted, never inferred); the delta path reproduces the reference's inside/outside classification | **SUPERSEDED by the revised P1 in §9** (which adds RESCALING and REBASING and is the row that was built: `session-p1-perturb-core`, BLOCKED on the sweep clause only — see §9's P1 row and `docs/DECISIONS.md` rows 33-37) |
| **P2** | **Exact rebasing.** Detect glitches — pixels whose orbit departs from the reference — and re-render them against a better reference. **A rebase may only REDUCE error.** This is the slice that carries the owner's smoothness requirement. | a zoom sweep across each rebase shows **no spike**; a known glitch case converges to the float64 reference; the frame AFTER a rebase differs from the frame before by less than the visual threshold | queued |
| **P3** | **The path switch** — plain float32 ↔ perturbation — placed where the plain path's error is already sub-pixel, with no visible change across the boundary. | a zoom sweep across the switch shows no spike; at the switch the two paths agree within the stated threshold | queued |
| **P4** | **Retire the CPU handoff** over the range the GPU now covers, and lift the cap past the range wall. **LANDED 2026-09-21 (`session-gpu-arbitrary`, branch `feat/gpu-arbitrary`).** The float32 delta-coordinate RANGE wall is removed by a uniform SPLIT (`u_scale <- scale * 2^shift`, `u_scaleShift <- shift`, `S = exp2(-u_scaleShift)`) — the delta is seeded in float32's NORMAL range and the exponent rides the rescaled representation's own `S`, with the physical offset unchanged. The automatic CPU switch is REMOVED (`#zoomCapOffer` and its buttons deleted; the cap now reports a brief non-modal notice) and the manual checkbox plus the genuine no-GPU path are untouched. | beyond the old cap the GPU stays selected and correct; the offer does not appear in the covered range; CPU stays reachable — **all three measured.** Through the REAL render path at 128x96 against an independent per-pixel BigInt iteration: **1e-40 renders at 0.00000 % misclassified, mean \|Δ escape index\| 0.003, worst 2**, where the SAME view through the pre-fix seed is **100 % misclassified with ONE distinct value** (baseline in-pin, `tests/gpu-arbitrary.spec.js` pin 1). The old wall (2e-38) is no longer special (pin 3). `WEBGL_ZOOM_CAP` is 1e4 -> **1e6**, set from the measured cost curve (14 ms/image at 1e-4 to 640 ms/image at 1e-40 at 640x480 on this host's SOFTWARE rasteriser) rather than from precision (pin 3, `docs/DECISIONS.md` row 49). The per-full-image render time is user-visible and observable (pin 2, row 50). **NO REGRESSION proven byte-for-byte: the shallow plain lane's readback hashes are IDENTICAL to the pristine pre-change build at four shallow views** (pin 4, row 52a), and P1's 1e-15 pins stay green. Recorded limit: the single-factor form degrades past ~1e-41 (7.4 % at 1e-42) and the two-factor alternative measured WORSE (32 % at 1e-40), so the shipped reach is measured, not asserted (row 48). Also recorded: the deep lane's boundary at 1e-4 is a PROGRAM SWITCH inside the lifted range, measured at a 0.469 hop fraction at 6.7e-5 (row 52d) — making it invisible belongs with this row's refinement half. | LANDED 2026-09-21, `session-gpu-arbitrary`, branch `feat/gpu-arbitrary`; decisions in `docs/DECISIONS.md` rows 48-52 |
| **P5** | **Series approximation** — speed, not correctness: skip the first N delta iterations with a polynomial in `dc`. | an SA-skipped render equals the non-skipped render within the stated threshold | queued |
| **P6** | **Reference orbits beyond float64.** A float64 orbit reaches roughly 1e15; past that the ORBIT itself needs big-float precision. This is where "unlimited" actually lives. | beyond the float64 range the image stays correct and the sweep shows no spike | **deferred until/unless >1e15 is wanted** |
| **D6** | **Align the CPU and GPU sample points.** `FractalKernel.pixelToCoord` samples pixel CORNERS while the shader samples CENTRES, so the two renderers disagree by 1.26% (1e3) / 9.0% (1e5) — **more than the GPU's float32 error at shallow zoom**, and it inflates the parity pins' tolerances. | CPU and GPU agree at the same sample points to the float32 floor; the parity pins' thresholds can tighten and are tightened | queued |

### Acceptance criterion for EVERY slice (the owner's requirement, made measurable)

> **⚠ RE-SPECIFIED 2026-09-21, after P1 measured the rule below to be BOTH unachievable and
> non-discriminating at the current stage.** The operative criterion is now:
>
> **A differential, correctness-at-depth test against a float64 PERTURBATION reference**, with four
> stated thresholds — `misclassification %`, `mean per-channel |ΔRGB|`, `largest connected Δ>32 blob`,
> `distinct-colour count` — and **the failing/naive baseline shown inside the same pin**, so it cannot
> pass vacuously. Removing the mechanism must break it, and it does: rebase-disabled gives a 90-px
> blob and **6 colours against the reference's 136**.
>
> **Why the hop rule below cannot be used yet.** P1 swept 0.1 %-per-step with the cap at 7680 and
> measured **1–4 hopping pixels per step at 1e-8 and 7–16 at 1e-13** out of ~10 500 sub-iteration
> pixels — never 0. Worse, the **rebase-disabled** build scores **0–1** and passes the rule
> *vacuously*, because it has collapsed to 6 colours (mean step change 0.90) against the correct
> build's 9.8. The rule compares each pixel's GPU colour against the float64 reference's value change,
> so at chaotic boundary pixels it measures **float32 delta ACCURACY** (measured: mean 6.6, max 2656
> iterations of error), not smoothness; reformulated on the GPU's own value it reads 0 on every build
> — non-discriminating the other way. Shipping a nonzero threshold to make it pass would be massaging
> the test, and the writer refused to do it — correctly.
>
> **The strict sweep criterion remains the owner's requirement and is DEFERRED to P2/P3**, where an
> arbitrary-precision coordinate and accurate deltas can make a hop measurement separable from
> accuracy noise. It must be re-attempted there, not quietly dropped.
**Corrected after D1, which measured the original version of this criterion to be
NON-DISCRIMINATING.** The original wording — *"a continuous zoom sweep must show no
step-to-step image-difference spike"* — was wrong: at deep zoom the frame-to-frame
difference is dominated by genuine image change (measured mean 9–45 L1 per step), so a
boundary is **not** an outlier in either a correct or a broken build. It passed both ways.
The criterion is therefore a **hop-classification** rule, not a raw-difference rule:

1. **Hop classification — the deciding assertion.** Whenever the value a pixel is coloured
   from moves by less than half an iteration (precision changed, so the image should not
   have), the colour may not move more than its own proportional change plus **2 RGB
   units**. Every violating pixel is a *hopping* pixel, and the count must be **0** at every
   step of the sweep — including every boundary where precision, the reference orbit, or
   the algorithm changes. D1 measured 0 hopping pixels at every step of a 14-step sweep
   down to the cap's `1e-4`, with a half-iteration hop flipping 0 of 21 856 pixels.
2. **Non-vacuity floor.** The sweep must also prove it exercised sub-iteration values (D1
   measured 41–80% sub-iteration population per step) and that the image was genuinely
   changing. A sweep in which nothing changes proves nothing.
3. A hop that violates rule 1 is a **failure**, however correct the steady-state image is.

The raw frame-difference bound is still recorded alongside as honest information, but it
does **not** decide the test. Any future slice adding a precision path must also pin the
path's own boundary the way D1 pinned pin 6: assert the mismatch was REAL (a job was
genuinely in flight, at a different cap) before asserting the outcome, so the pin cannot
pass vacuously.

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

**Honest scope — ORIGINALLY stated as "a float64 orbit reaches roughly 1e15", and that claim is
now FALSIFIED BY MEASUREMENT.** It was reasoning (the orbit needs about as many digits as the
zoom), not evidence. The perturbation probe (`docs/PROBE-2026-09-21-perturbation.md`) measured a
straightforward implementation on a genuinely deep centre and found:

- **clean at 1e8** (misclassification 0.0026 % float32 orbit, 0.0013 % hi/lo orbit; ≤4 px speckle);
- **degraded at 1e12** (0.34 % / 0.97 %, blobs to 215 px);
- **structurally wrong at 1e15** (26.4 % / 55.2 % misclassified; the hi/lo arm collapses to one
  blob covering 53 % of the frame);
- **the limiter is the float32 DELTA arithmetic, not the orbit** — holding the same 24-bit orbit and
  doing the arithmetic in float64 drops the 1e15 error from a mean of 1235 iterations to 64;
- **a hi/lo orbit is INERT without a compensated delta** (arms A and D are bit-identical, because
  `float(hi + lo)` returns `hi`), and **the specific hi/lo + Dekker-`ds_mul` compensation tested made
  1e12–1e15 WORSE, not better**;
- orbit transport itself is **exact and cheap** here (one float texel per iteration, NEAREST,
  `MAX_TEXTURE_SIZE = 8192`, NPOT fine) — no transport obstacle exists;
- **glitches without rebasing** are 0.08 % at 1e8, 1.37 % at 1e12 and **74.6 % at 1e15**, so P2 is
  not optional past ~1e12;
- the D2 iteration rule is **slightly under-provisioned at 1e8** (the frame needs 4669 against a
  4096 budget) and **cannot be adequate at 1e12** (needs 9011 > the 8192 cap) — so the cap, not only
  precision, becomes a limit.

**Therefore the measured reach of a first perturbation implementation is ~1e8–1e10 — COMPARABLE TO
the compensated-float32 route that was rejected as "not deep enough".** The depth advantage Route 2
was chosen for does not exist yet: it must be *earned* by (a) a delta formulation that actually
compensates — the measured limiter, and now an identified target — and (b) rebasing (P2).
"Unlimited" remains P6. This re-opens the choice; see §8.

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

## 8 · THE FORK — RESOLVED (owner, 2026-09-21): ARBITRARY DEPTH
**The owner's answer, verbatim:** *"1e15 is not really enough, i would like to have it as arbitrary
deep as the user wants (getting slower of course). Please consult the web for that."*

Research is done and committed: `docs/RESEARCH-2026-09-21-arbitrary-depth.md` (cited throughout).
It resolves the fork decisively: **arbitrary depth is achievable, and the naive probe's 1e15 collapse
was a MISSING-MECHANISM result, not a precision ceiling.** The two mechanisms it lacked are exactly
the ones the sources name — **REBASING** (keeps the deltas small) and **RESCALING** (defeats double
*underflow*, which is the real wall near 1e308, not mantissa precision). The measured 74.6 % glitch
rate at 1e15 in that probe is precisely the signature of un-rebased deltas. See §9 for the route and
the revised slices. The options below are kept as the history of how the fork was put.

The measurement above changes the value proposition the owner accepted. The honest options:

- **Route 1 — compensated float32** (measured: holds to **≥1e10**) at ~10–12× fragment cost. No
  reference orbit, no glitch detection, no rebasing; the only hop is the plain→compensated switch,
  which D1's continuous colour plus a threshold chosen where the error is already sub-pixel makes
  invisible. It reaches about what perturbation reaches today, for far less machinery.
- **Route 2 — perturbation (chosen).** Measured **~1e8–1e10** for a straightforward implementation.
  Its advantage must be *earned*: the limiter is the float32 delta arithmetic (identified, with a
  concrete target), and past ~1e12 **rebasing is mandatory** because 1.37 % of pixels glitch at 1e12
  and 74.6 % at 1e15. Its ceiling is genuinely higher than Route 1's — but only after that work lands.
- **Route 2-lite — build P1 as the CORE only**, accept ~1e8–1e10, and stop there while keeping the
  orbit machinery in place for later. Cheapest path to "deeper than 1e4, on the GPU, smooth".

**Recommendation: Route 2-lite** — proceed with P1 as the core, with the expectation reset to
**~1e8–1e10** and a pin at a zoom where correctness is MEASURED rather than assumed, because the
orbit transport is proven exact, the limiter is identified, and this same code is the foundation for
whatever depth comes later. Rejected: "keep chasing 1e15 first", which requires a delta formulation
nobody has yet demonstrated here *plus* glitch rebasing, before shipping any user-visible improvement.

## 9 · THE ARBITRARY-DEPTH ROUTE (from cited research) — revised slices
**Architecture, as practised by shipping renderers and the closest browser analogue:**
- **Reference orbit: arbitrary precision, computed ONCE per view, on the CPU** (in a Web Worker, so
  the main thread stays free). Native renderers use GMP/MPFR; the **browser** analogue (bertbaron)
  uses **BigInt fixed point** with the limb count growing with zoom — available here with no
  dependency at all. Precision follows **bits ≈ log2(1/scale) + margin**, i.e. **3.3219 bits per
  decimal digit** of zoom (the shape is settled); the **margin is NOT standardized** — 0 in the bare
  bound, **+64** in rust-fractal-core — so it must be chosen and measured, not assumed.
- **Per-pixel deltas: float64 on the GPU**, kept representable by **rebasing** (`|Z+z| < |z|` ⇒
  `z ← Z+z`, reset the reference iteration) and **rescaling** (`z = S·w` with `|w| ≈ 1`, re-scaled
  every few hundred iterations). With those in place, double precision is not the limit — underflow,
  memory and time are.
- **Glitches: Pauldelbrot detection** `|Z+z|² < G·|Z|²`, G between 1e-2 and 1e-8, essentially free
  because `|Z+z|²` is already computed. **No principled G is published** — KF exposes it as a user
  slider whose extremes are "good but very slow" and "fast but bad images".
- **Speed: series approximation** (probe-point-based skip; the analytic test is NOT used in
  practice), or Fraktaler 3's BLA. It cuts per-pixel work, never the reference's precision need.
- **GPU:** the consensus for our depth range is **reference on the CPU, deltas on the GPU**; KF notes
  OpenCL is only good to ~1e300 for double, which is exactly why it keeps the reference on the CPU.

**Revised slices (superseding the P-list in §3):**

| id | intent | the pin that matters |
|---|---|---|
| **P1** | **Perturbation core WITH rescaling and rebasing.** The naive probe lacked both — that is why it collapsed at 1e15. Expect a large depth jump over that result. | at a depth beyond the naive failure (≥1e15) the image matches a float64 reference within a stated threshold; the orbit is computed **once per view** (counted); **a zoom sweep across every rebase shows no spike**. **OUTCOME 2026-09-21 (`session-p1-perturb-core`, branch `feat/p1-perturb-core`): BLOCKED on the third clause only.** The depth jump is real and measured: REBASING is the mechanism (as the research predicted) — the shipped shader at 1e15 against a float64 PERTURBATION reference measures **0.00000 % misclassification, mean per-channel \|ΔRGB\| 0.453, a 3-px largest blob and 136 distinct colours (the reference's own 136)**, where the rebase-disabled control measures 3.18 / a 90-px blob / 6 colours; RESCALING, however, is measured **inert** everywhere a float64 orbit can reach (bit-identical with the interval at 64/256/1024 or removed — it belongs to the range past float32 underflow, ~1e19, which a float64 centre cannot reach because its own ULP degenerates the frame at ~1e16). The orbit is computed once per view, counted (`orbitComputations`: five re-draws of one view build 0; each centre or budget change builds exactly 1). **The zoom sweep does NOT reach count 0**: 1-4 hopping pixels per 0.1 % step at 1e-8, 7-16 at 1e-13 (0.07-0.15 % of sub-iteration pixels), because the reference-based rule measures per-pixel float32 delta accuracy at chaotic boundary pixels rather than smoothness — and the rebase-disabled build passes it vacuously by collapsing to 6 colours. See `docs/DECISIONS.md` rows 33-37 for the full measurements and the control arms. |
| **P2** | **Arbitrary-precision reference orbit** — BigInt fixed point in a Worker, precision growing with zoom (`bits ≈ log2(1/scale) + margin`). **LANDED & VERIFIED** 2026-09-21 (`session-p2-bigint-orbit`, branch `feat/p2-bigint-orbit`): `public/bigOrbit.js` + `public/orbitWorker.js`, ONE long-lived classic Worker, the orbit computed **once per view** keyed `(exact centre string, budget, bits)` and transported to the shader exactly as P1's orbit (one float32 word per component, one texel per iteration). The deep lane at 1e-15 is byte-identical to P1's, so P1's three pins stay green. | depth keeps increasing as the limb count grows, measured, with the margin stated — **margin CHOSEN +64** (rust-fractal-core's value; the bare bound is 0), working precision quantised UP to 64-bit steps; measured sufficient: at the 1e-30 view the shipped setting matches a DIRECT per-pixel BigInt reference computed 256 bits wider with **mean \|Δ escape index\| 0.007** and 0 misclassification, while a starved setting (`bits = log2(1/scale) − 96`) measures **12.9**. **Depth reached in the real shader: 1e-30, 0.00000 % misclassification, where the P1 float64-orbit baseline on the same view measures mean \|Δ\| 9.47** — the view's exact centre is `-1.4303576324512 + 2^-70`, BELOW its own float64 ULP (pin 1, baseline in-pin). The **precision-STEP boundaries change nothing visible**: the 128→192-bit step at 1e-20 measures colour mean **0.0000** and escape-index mean **0.0000**, and the only documented literature defect in this class — KF 2.13.10 (2018) "corrupt image at transition between number types" — is injected in-pin (the high side parses its centre at a 32-bit type) and measures mean **11.69** with **98.4 %** of pixels differing (pin 3). "Once per view" is counted: five redraws post **0** requests, a centre change completes exactly **1**, a scale change inside a step reuses the orbit (**0**), crossing a step completes exactly **1**, and one Worker is spawned for the renderer's life (pin 2). **MEASURED CEILING (a finding, `docs/DECISIONS.md` row 42): the next wall is NOT orbit precision — it is float32 RANGE.** One float32 word per component is measured sufficient (P1's hi/lo split was already inert under a float32 delta, row 36); the frame stays structured to **5e-38** and collapses to a single value at **~2e-38** (float32's smallest normal ≈1.175e-38, subnormals flushed), i.e. the `u_scale`/`dc` product, not the orbit mantle. So "arbitrary" still needs the research's per-iteration scale / shared exponent (`float32 + exponent`) applied to the COORDINATE — deliberately not built here, since fabricating reach is forbidden. |
| **P3** | **Glitch solving beyond same-reference rebasing** (new references / near-pixel), chosen by measurement. | each strategy's documented artifact is absent or bounded and pinned: no "noisy appearance", no "weird flat blobs", no endless-reference loop, no corruption of pixels that merely share an iteration count |
| **P4** | **Series approximation** for speed (probe-point skip). | an SA-skipped render equals the non-skipped render within a stated threshold, and SA is disabled where sources say it is invalid (some power-3 locations, Burning Ship) |
| **P5** | **Lift the zoom cap** so any of this becomes user-visible; retire the CPU handoff over the covered range. | beyond the old cap the GPU stays selected and correct; the offer no longer appears in the covered range |
| **P6** | GPU-side reference (NTT / limb arithmetic) **only if** the CPU orbit becomes the bottleneck. | deferred — FractalShark is the only implementation found that does it |

**The owner's smoothness requirement, restated against the research.** The two hop sources are
(a) **precision / number-type transitions**, for which the ONLY documented defect in the literature is
the 2018 KF corruption bug — i.e. a real and *under-documented* risk class, and (b) **rebasing**,
whose artifacts are documented per strategy. Both get the sweep-no-spike criterion, and P2's step
boundaries and P3's strategy choice each need their own measurement.

**Honest unknowns, to be resolved by measurement rather than assumption:** no rigorous error bound or
correctness proof exists for the glitch threshold G or for series-approximation skipping (stated by
the field's own author); no source states how a current renderer's precision transition looks during
interactive zoom; and the depth ceiling of a **BigInt** reference in a browser is not published —
bertbaron's ~1e1500 figure is for a WebGPU float32+exponent path, not a BigInt orbit.
