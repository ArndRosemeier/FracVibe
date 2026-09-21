// public/fractalKernel.js — THE fractal kernel.
//
// One source of truth for the iteration math, the iteration cap, the fractal-type
// table and the palette table. Everything that used to be a separate copy of this
// logic now reads it from here:
//
//   * the render worker           — `importScripts('fractalKernel.js')` (classic)
//   * the main thread (2D LUT)    — `import './fractalKernel.js'` via a side-effect
//   * the main thread (3D height) — the same import; `calculateHeightmap` below
//   * the fragment shader         — `webglFractal.js` templates this file's
//                                   constants and index tables into the GLSL
//                                   (GLSL ES 1.00 needs a constant loop bound,
//                                   so a uniform is not an option).
//
// WHY THERE IS NO `import` AND NO `export` IN THIS FILE (docs/DECISIONS.md row 14):
// the render worker is CLASSIC (`app.js` does `new Worker('fractalWorker.js')`),
// so its kernel must be loadable by `importScripts`, which cannot load an ES
// module. At the same time the main thread is ES-module-only. A file with no
// import/export statements is simultaneously a valid classic script and a valid
// ES module, so this ONE file serves both without a build step. It publishes
// exactly one frozen global, `globalThis.FractalKernel`.

(function () {
  'use strict';

  // --- the ONE iteration cap -------------------------------------------------
  // Every iteration bound in the app derives from this number and nothing else:
  // the slider's `max` attribute (app.js), the clamps in this kernel (worker chunk
  // and 3D heightmap), the shader's loop bound and the `u_maxIter` uniform clamp
  // (webglFractal.js). Before S3 the slider allowed 2000 while the shader looped
  // to a hardcoded 1024, so every pixel that needed more than 1024 iterations was
  // silently coloured as if it had escaped (finding B5).
  //
  // D2 raised it 2000 -> 8192. The zoom-scaled budget below (§D2) needs more than
  // 2000 to resolve a deep view — the probe's view centre escapes only at iteration
  // 3086 — and it asks for 4096 at zoom 1e8 and 7680 at zoom 1e15 (the practical
  // reach of a float64 reference orbit, P6). 8192 is the smallest power of two that
  // lets the RULE, not the cap, decide over that whole reachable range, so nothing
  // reachable is truncated by the cap. Raising the cap alone does NOT raise any
  // frame's cost: a job still runs at its own (scaled) budget, and the colour table
  // is sized by that job's cap, never by this maximum (see colorTableSize below).
  const MAX_ITER = 8192;
  const MIN_ITER = 1;
  const BAILOUT = 4;
  // The escape radius squared at which the iteration test fires. ONE constant,
  // used by the kernel, templated into the GLSL (D1).
  const BAILOUT_SQ = BAILOUT;
  // 1 / ln(BAILOUT_SQ): the constant factor of the smooth (continuous) escape
  // count. Templated into the GLSL as a float32 literal so BOTH renderers
  // evaluate the identical expression (see smoothIterationValue below).
  const SMOOTH_LOG_BAILOUT = 1 / Math.log(BAILOUT_SQ);

  // --- the ONE fractal-type table --------------------------------------------
  // `index` is the shader's `u_fractalType`. `glsl` is the identifier that
  // webglFractal.js templates into the shader as `#define FT_<glsl> <index>`, so
  // the GLSL branch can never drift from this table. Order is owned HERE.
  const FRACTAL_TYPES = [
    { value: 'mandelbrot', label: 'Mandelbrot', index: 0, glsl: 'MANDELBROT' },
    { value: 'julia', label: 'Julia', index: 1, glsl: 'JULIA' },
    { value: 'burningship', label: 'Burning Ship', index: 2, glsl: 'BURNINGSHIP' },
    { value: 'tricorn', label: 'Tricorn', index: 3, glsl: 'TRICORN' }
  ];

  // --- the ONE palette table (names + implementations) -----------------------
  // t in [0,1], returns [r,g,b] in 0-255. These are the ONLY palette
  // implementations in the app; the GLSL keeps its own for the GPU (the one
  // documented exception), keyed off the `index`/`glsl` fields below.

  function rainbow(t) {
    const a = (1 - t) * 4;
    const X = Math.floor(a);
    const Y = Math.floor(255 * (a - X));
    switch (X) {
      case 0: return [0, Y, 255]; // blue->cyan
      case 1: return [0, 255, 255 - Y]; // cyan->green
      case 2: return [Y, 255, 0]; // green->yellow
      case 3: return [255, 255 - Y, 0]; // yellow->red
      default: return [255, 0, 0];
    }
  }

  function fire(t) {
    // Black -> red -> yellow -> white
    if (t < 0.33) return [Math.floor(255 * t * 3), 0, 0];
    if (t < 0.66) return [255, Math.floor(255 * (t - 0.33) * 3), 0];
    return [255, 255, Math.floor(255 * (t - 0.66) * 3)];
  }

  function ocean(t) {
    // Deep blue -> cyan -> white
    if (t < 0.5) return [0, Math.floor(255 * t * 2), Math.floor(128 + 127 * t * 2)];
    return [Math.floor(255 * (t - 0.5) * 2), 255, 255];
  }

  function grayscale(t) {
    const g = Math.floor(255 * t);
    return [g, g, g];
  }

  function viridis(t) {
    // Approximate viridis colormap
    const stops = [
      [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142],
      [33, 144, 141], [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37]
    ];
    const idx = Math.floor(t * (stops.length - 1));
    const frac = t * (stops.length - 1) - idx;
    if (idx >= stops.length - 1) return stops[stops.length - 1];
    const c0 = stops[idx], c1 = stops[idx + 1];
    return [
      Math.floor(c0[0] + (c1[0] - c0[0]) * frac),
      Math.floor(c0[1] + (c1[1] - c0[1]) * frac),
      Math.floor(c0[2] + (c1[2] - c0[2]) * frac)
    ];
  }

  const COLOR_SCHEMES = [
    { value: 'rainbow', label: 'Rainbow', index: 0, glsl: 'RAINBOW', fn: rainbow },
    { value: 'fire', label: 'Fire', index: 1, glsl: 'FIRE', fn: fire },
    { value: 'ocean', label: 'Ocean', index: 2, glsl: 'OCEAN', fn: ocean },
    { value: 'grayscale', label: 'Grayscale', index: 3, glsl: 'GRAYSCALE', fn: grayscale },
    { value: 'viridis', label: 'Viridis', index: 4, glsl: 'VIRIDIS', fn: viridis }
  ];

  // name -> function, the shape `fractalViewer.js` / `fractal3d.js` already use.
  const colorSchemes = {};
  COLOR_SCHEMES.forEach(function (s) { colorSchemes[s.value] = s.fn; });

  // --- the clamps: the ONE place an iteration count is bounded ----------------
  // The UI slider cannot exceed `MAX_ITER`, but a hostile or stale imported
  // location can carry any number, so every entry point clamps here.
  function clampMaxIter(value) {
    const n = Math.floor(Number(value));
    if (!isFinite(n)) return MIN_ITER;
    if (n < MIN_ITER) return MIN_ITER;
    if (n > MAX_ITER) return MAX_ITER;
    return n;
  }

  // --- D2: the zoom-scaled iteration budget -----------------------------------
  // The probe proved the iteration budget — not precision — masks deep zoom today:
  // its view centre escapes only at iteration 3086 (float64, stable across budgets
  // 2e4..2e6), so at the shipped budget of 512 the centre is called "inside" and a
  // 1e8 frame is 100% black. Measured here with this kernel: the probe's centre at
  // scale 1e-8 is 100.0% inside at cap 512 and 0.0% inside at cap 4096, and 1e6/512
  // is 90.9% inside. Until the budget follows the zoom, no deep view is meaningful
  // at any arithmetic precision (docs/PROBE-2026-09-21-gpu-precision.md item 7).
  //
  // THE RULE. The budget is `max(the user's slider value, floor(zoom))`: the
  // slider's value is a FLOOR, and the floor may raise the effective budget above
  // it. The floor is OFF at and above the app's shipped GPU zoom cap — the probe
  // measured no saturation there (1e4/512 = 0.7% inside) and D1's pins deliberately
  // hold a cap of 50 at zooms up to 1e4 to make one iteration a visible colour band,
  // so a floor there would silently override an explicit user budget and destroy the
  // band those pins measure. Below that scale it grows 512 iterations per DECADE of
  // zoom. Why that shape: the escape count of an exterior point goes as log2(1/d)
  // for the quadratic map, so the budget must be linear in the LOGARITHM of the
  // zoom, not in the zoom; one decade of zoom is 3.32 doublings of the boundary
  // distance, and 512 per decade is 154 per doubling, which covers the probe's
  // measured 3086 with the budget it actually needed:
  //     zoom 1e5 -> 2560     zoom 1e6 -> 3072     zoom 1e8 -> 4096
  //     zoom 1e9 -> 4608     zoom 1e12 -> 6144    zoom 1e15 -> 7680
  // 4096 at 1e8 is EXACTLY the budget the probe used to turn that 100%-black frame
  // into a real one, and 3086 < 4096, so the centre escapes.
  const ITER_BUDGET_PER_DECADE = 512;
  // --- P1: the perturbation core's two named constants ------------------------
  // Pauldelbrot's glitch test is |Z+z|^2 < G |Z|^2. The sources put G anywhere in
  // 1e-2..1e-8 and publish no principled value at all (Kalles Fraktaler exposes it
  // as a user slider whose extremes are "good but very slow" and "fast but bad
  // images"; Claude Heiland-Allen's blog says choosing it "remains open"). This is
  // therefore a CHOSEN value, not a derived one, and it is stated here so the
  // shader and every measurement name the same number:
  //
  //   PERTURB_GLITCH_G = 1e-4
  //
  // WHY 1e-4: it is the middle of the published band, it is the threshold the
  // committed perturbation probe (docs/PROBE-2026-09-21-perturbation.md) reported
  // its glitch fractions at, and the choice is MEASURED to be discriminating
  // rather than asserted. At zoom 1e15 on the probe's centre, the fraction of
  // pixels the detector fires on is 0.000% once same-reference rebasing is in
  // force and 74.6% with rebasing disabled (docs/DECISIONS.md row 33) — i.e. at
  // this G the detector tracks exactly the structural collapse rebasing repairs.
  const PERTURB_GLITCH_G = 1e-4;
  // Rescaling in the delta iteration: z = S*w, c = S*d, w -> 2Zw + S w^2 + d, with
  // S renormalised so |w| is near 1. The sources say "typically a few hundred
  // iterations" and give no exact value, so this is a CHOSEN interval:
  //
  //   PERTURB_RESCALE_INTERVAL = 256
  //
  // 256 is a power of two, so the rescale factor S is an exact float32 scaling and
  // the trigger `mod(iter, 256) == 0` is exact. MEASURED: over the whole range a
  // float64 reference orbit can reach (<=1e16), rescaling is INERT — the image is
  // bit-identical with the interval at 256, at 64, at 1024 and with rescaling
  // disabled entirely. It exists for the range below, not for the range above:
  // the delta's square underflows in float32 at |z| < ~1e-19, which is a zoom
  // around 1e19, and a float64 view centre has already lost all of its pixels to
  // its own ULP (~1.1e-16 near |c|~0.74) by 1e16. So rescaling is the mechanism
  // P2 (an arbitrary-precision reference orbit) needs, and it is implemented and
  // range-preserving here; its contribution is NOT measurable within P1's reach
  // (docs/DECISIONS.md row 34 records the measurement that says so).
  const PERTURB_RESCALE_INTERVAL = 256;
  // The scale of the app's GPU zoom cap (`WEBGL_ZOOM_CAP = 10000` in app.js ->
  // `WEBGL_MIN_SCALE = 1 / WEBGL_ZOOM_CAP`). The floor starts strictly BELOW this
  // scale, so a view clamped at the cap gets no floor at all. This is the one
  // number this rule shares with app.js; it is not a silent duplicate: a pin holds
  // `iterBudgetMinScale` exactly equal to `window.__fv.minScale`, so the slice that
  // lifts the zoom cap (P4) is forced to revisit the rule.
  const ITER_BUDGET_MIN_SCALE = 1e-4;

  // The FLOOR the zoom asks for, clamped to [MIN_ITER, MAX_ITER]. `MIN_ITER` means
  // "no floor": the user's slider value is the whole budget. Monotone non-decreasing
  // as the scale falls (the zoom rises), with one step at the shipped zoom cap.
  function iterBudgetForScale(scale) {
    if (typeof scale !== 'number' || !isFinite(scale) || scale <= 0) return MIN_ITER;
    if (!(scale < ITER_BUDGET_MIN_SCALE)) return MIN_ITER;
    return clampMaxIter(Math.ceil(ITER_BUDGET_PER_DECADE * Math.log10(1 / scale)));
  }

  // The budget a job actually runs at. The user's slider value is a FLOOR: the
  // zoom-derived floor raises it, and the ONE cap bounds both. A caller that wants
  // the user's own value (for a readout or a saved record) asks for it directly.
  function effectiveMaxIter(maxIter, scale) {
    return Math.max(clampMaxIter(maxIter), iterBudgetForScale(scale));
  }

  function findIndex(table, value) {
    for (let i = 0; i < table.length; ++i) {
      if (table[i].value === value) return table[i].index;
    }
    return table[0].index;
  }

  // The shader's `u_fractalType` for a type name.
  function indexForType(value) { return findIndex(FRACTAL_TYPES, value); }
  // The shader's `u_colorScheme` for a scheme name.
  function indexForColorScheme(value) { return findIndex(COLOR_SCHEMES, value); }
  // The palette function for a scheme name (2D and 3D CPU rendering).
  function paletteFunction(value) { return colorSchemes[value] || colorSchemes.rainbow; }

  // --- D1: THE smooth (continuous) escape-time value ---------------------------
  // Colour used to be a STEP function of an INTEGER iteration count, in both
  // renderers: the CPU had one LUT entry per integer (`Uint32Array(maxIter + 2)`)
  // and the shader did `float(iter) / float(u_maxIter)`. A staircase like that
  // AMPLIFIES a precision hop: a difference far smaller than one iteration can
  // push a pixel across a step and flip it a whole colour band, and those pixels
  // cluster at the fractal boundary — which is exactly what is on screen when you
  // are zoomed in. This function makes colour continuous in the escape value, so
  // a small change in the value is a small change in the colour.
  //
  // The value returned is
  //
  //     v = n + 1 - log2( log(|z|²) / log(BAILOUT_SQ) )
  //
  // where |z|² is the squared magnitude at which the escape test fired and n is
  // the 1-based index of the update that produced it. It is the standard
  // continuous iteration count: `log2( log|z| / log R )` is the renormalised
  // fraction of the last step. Everything here is in log space, so the escape
  // RADIUS is not needed — only its square, which is the value the loop already
  // has, and ONE constant `SMOOTH_LOG_BAILOUT = 1 / ln(BAILOUT_SQ)`.
  //
  // The GLSL in `webglFractal.js` evaluates the SAME expression with the same
  // constants (`u_maxIter` and `SMOOTH_LOG_BAILOUT` are templated in from here);
  // `tests/kernel-parity.spec.js` and `tests/smooth-color.spec.js` hold the two
  // to that. This is what keeps a GPU↔CPU switch from being a visible colour
  // change at the cap, which is the defect this slice exists to remove.
  //
  // The `n > maxIter` guard is the "inside the set" case: a point that never
  // escaped has n = maxIter + 1, and must come out EXACTLY maxIter so both
  // renderers paint it black (the GPU's `iter == u_maxIter` test).
  function smoothIterationValue(escapeRadiusSq, n, maxIter) {
    const cap = clampMaxIter(maxIter);
    if (n > cap || !(escapeRadiusSq > 0) || !isFinite(escapeRadiusSq)) return cap;
    const v = 1 + n - Math.log(Math.log(escapeRadiusSq) * SMOOTH_LOG_BAILOUT) / Math.LN2;
    if (!isFinite(v)) return cap;
    return Math.min(v, cap);
  }

  // The colour parameter for a smooth value: t = (v / maxIter + colorOffset) mod 1,
  // clamped to [0, 1) for the mod's floating-point edge. Colour cycling applies to
  // the CONTINUOUS value (D1), not to a quantised iteration index.
  function colorParameter(smoothValue, maxIter, colorOffset) {
    const cap = clampMaxIter(maxIter);
    const offset = isFinite(colorOffset) ? colorOffset : 0;
    let t = (smoothValue / cap + offset) % 1;
    if (!isFinite(t)) t = 0;
    if (t < 0) t += 1;
    if (t >= 1) t = 0;
    return t;
  }

  // The ONE colour of one smooth value. `undefined` is returned only when a
  // palette function misbehaves, which the 2D renderer paints as the placeholder.
  function colorAtSmoothIteration(smoothValue, maxIter, paletteName, colorOffset) {
    const cap = clampMaxIter(maxIter);
    if (smoothValue >= cap) return [0, 0, 0]; // inside the set is black
    return paletteFunction(paletteName)(colorParameter(smoothValue, cap, colorOffset));
  }

  // --- D1: the quantised colour table (the ONE mapping the 2D renderer uses) ----
  // The integer LUT is gone (it cannot index a Float32 value). Colour is now a
  // table over the QUANTISED CONTINUOUS value: COLORS_LUT_STRIDE steps per unit
  // of smooth value, fixed, independent of maxIter. The residual is a
  // half-stride palette step — at 256 steps/iteration for a palette whose fastest
  // segment changes ~1/255 per 1/255 of t, under 1 RGB unit out of 255, i.e. below
  // the quantisation the canvas can display at all — and it does NOT grow with
  // maxIter (a maxIter-proportional table WOULD: at maxIter 8192 it could not
  // resolve neighbouring escape values at all). See docs/DECISIONS.md row 27.
  const COLORS_LUT_STRIDE = 256;
  // The colour an uncalculated cell is painted with. Deliberately NOT a palette
  // colour, so a cell the worker has not reached can never be mistaken for a
  // rendered value (pinned by tests/smooth-color.spec.js).
  const UNCALCULATED_COLOR = [40, 40, 40];

  // --- D2: the colour table is sized by the cap A JOB RAN AT -------------------
  // D1 exported `COLORS_LUT_SIZE = MAX_ITER * STRIDE + 1`, the size of a table for
  // the module MAXIMUM. Nothing allocated it, but it named the wrong quantity: at
  // MAX_ITER 8192 it would be 2 097 153 entries (~8 MB) for EVERY frame, whatever
  // cap that frame actually ran at. The table a frame needs is a function of ITS
  // cap (D1's pin 6: a finished frame is indexed at its own job's cap), so the size
  // is a function, not a constant, and the renderer allocates only that (plus one
  // placeholder entry) and reuses it while the key (scheme, offset, cap) holds.
  // +1 is the inside-the-set entry at exactly maxIter.
  function colorTableSize(maxIter) {
    return clampMaxIter(maxIter) * COLORS_LUT_STRIDE + 1;
  }

  // The LUT entry a smooth value maps to:
  //   0 .. cap*STRIDE - 1   an escaped value (palette colour)
  //   cap*STRIDE            exactly maxIter: inside the set (black)
  //   -1                    not a smooth value at all: the uncalculated NaN
  //                         sentinel, an infinity, or a negative value
  function colorLutIndex(smoothValue, maxIter) {
    const cap = clampMaxIter(maxIter);
    if (!isFinite(smoothValue)) return -1;
    if (smoothValue >= cap) return cap * COLORS_LUT_STRIDE;
    let t = smoothValue / cap;
    if (t < 0) t = 0; // only reachable for a negative smooth value
    return Math.floor(t * (cap * COLORS_LUT_STRIDE));
  }

  // The colour of a LUT entry (the exact colour the pixel path writes), so the
  // suite can compare the quantised path against the continuous definition rather
  // than restating either. The inside-the-set entry is black; `-1` (uncalculated)
  // is the fixed placeholder, which is deliberately NOT a palette colour.
  function colorAtLutIndex(index, maxIter, paletteName, colorOffset) {
    const cap = clampMaxIter(maxIter);
    if (index < 0) return UNCALCULATED_COLOR;
    if (index >= cap * COLORS_LUT_STRIDE) return [0, 0, 0];
    const t = colorParameter(index / COLORS_LUT_STRIDE, cap, colorOffset);
    return paletteFunction(paletteName)(t);
  }

  // The ONE place a colour becomes a canvas pixel value. The 2D renderer's table
  // holds these, so the palette functions are evaluated ONCE per table entry and
  // the pixel loop is a lookup.
  function toRGBA(color) {
    if (!color) return (255 << 24) | (40 << 16) | (40 << 8) | 40;
    return (255 << 24) | (color[2] << 16) | (color[1] << 8) | color[0];
  }

  // --- the iteration core -----------------------------------------------------
  // `px, py` are the point in the complex plane (already projected from the
  // pixel). For Julia the point is z0 and (jx, jy) is the constant c; for every
  // other type z0 = 0 and c = the point.
  //
  // Returns the FULL escape state, not just a count, because the smooth value
  // needs both: `iter` is the number of update steps applied before the escape
  // test fired, and `escapeRadiusSq` is the squared magnitude that test saw.
  // `iter` EQUALS maxIter exactly when the point never escaped (it is inside),
  // which is the classification every consumer uses and which D1 does NOT change.
  function iteratePixelState(type, px, py, maxIter, jx, jy) {
    let zx, zy, cx = px, cy = py;
    if (type === 'julia') {
      zx = px;
      zy = py;
      cx = jx;
      cy = jy;
    } else {
      zx = 0;
      zy = 0;
    }
    let iter = 0;
    let zx2 = 0, zy2 = 0, escapeRadiusSq = 0;
    while (iter < maxIter) {
      zx2 = zx * zx; zy2 = zy * zy;
      escapeRadiusSq = zx2 + zy2;
      if (escapeRadiusSq > BAILOUT_SQ) return { iter: iter, escapeRadiusSq: escapeRadiusSq };
      if (type === 'burningship') {
        zy = Math.abs(2 * zx * zy) + cy;
        zx = Math.abs(zx2 - zy2 + cx);
      } else if (type === 'tricorn') {
        zy = -2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
      } else {
        // Mandelbrot and Julia share the recurrence; only z0 / c differ.
        zy = 2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
      }
      ++iter;
    }
    return { iter: iter, escapeRadiusSq: escapeRadiusSq };
  }

  // The integer count every pre-D1 consumer used. Kept as the one definition of
  // "how many iterations", so the 3D heightmap and any caller cannot drift from
  // the kernel's own loop.
  function iteratePixel(type, px, py, maxIter, jx, jy) {
    return iteratePixelState(type, px, py, maxIter, jx, jy).iter;
  }

  // The SMOOTH value of a point: the D1 replacement for the integer count in every
  // colour path.
  //
  // The `n` it passes is the 1-BASED INDEX OF THE UPDATE WHOSE RESULT EXCEEDED THE
  // BAILOUT, and the magnitude is that same result — exactly what the shader's loop
  // holds when it breaks. `iteratePixelState` returns the number of updates
  // COMPLETED before the escape test fired, and because this kernel tests at the TOP
  // of the iteration that count already INCLUDES the escaping update, while the
  // shader breaks BEFORE its `iter++` and therefore EXCLUDES it. Passing `iter` here
  // (not `iter + 1`) is what makes the two renderers compute the identical value; a
  // systematic ONE-ITERATION colour difference otherwise — a whole 5-unit band at
  // maxIter 50, and an invisible-but-real 0.5 units at 2000 — is measured by the
  // low-cap GPU/CPU parity check in tests/smooth-color.spec.js pin 5.
  //
  // A point that never escaped is INSIDE and must come out EXACTLY maxIter, the
  // same value the shader's `iter == u_maxIter` case produces.
  function iteratePixelSmooth(type, px, py, maxIter, jx, jy) {
    const cap = clampMaxIter(maxIter);
    const state = iteratePixelState(type, px, py, cap, jx, jy);
    if (state.iter >= cap) return cap;
    return smoothIterationValue(state.escapeRadiusSq, state.iter, cap);
  }

  // Project a pixel to the complex plane. `view` is {centerX, centerY, scale}.
  function pixelToCoord(x, y, width, height, view) {
    const aspect = width / height;
    const scale = view.scale;
    const cx = view.centerX + (x - width / 2) * scale / width * aspect;
    const cy = view.centerY + (y - height / 2) * scale / height;
    return [cx, cy];
  }

  // --- the worker's entry point: fill the not-yet-computed entries of `chunk` --
  // `result` is a Float32Array of width*height whose computed entries hold a
  // SMOOTH (continuous) iteration value and whose uncomputed entries hold NaN (D1:
  // an Int32Array cannot hold the value, so the "-1 not yet calculated" sentinel is
  // represented as the non-finite value instead — `!isFinite` is the skip test).
  function calcFractalChunk(job, result) {
    const width = job.width, height = job.height;
    const type = job.type;
    const maxIter = clampMaxIter(job.maxIter);
    const view = job.view;
    const params = job.params || {};
    const chunk = job.chunk;
    const aspect = width / height;
    const scale = view.scale;
    let jx = 0, jy = 0;
    if (type === 'julia' && params.c) {
      jx = params.c[0];
      jy = params.c[1];
    }
    for (let i = 0; i < chunk.length; ++i) {
      const idx = chunk[i];
      // NaN is the "not yet calculated" sentinel: a cell that is NOT NaN has
      // already been computed by a coarser level and must be skipped (the
      // progressive-refinement contract that used to be `!== -1`).
      if (result[idx] === result[idx]) continue;
      const x = idx % width;
      const y = (idx / width) | 0;
      const cx = view.centerX + (x - width / 2) * scale / width * aspect;
      const cy = view.centerY + (y - height / 2) * scale / height;
      result[idx] = iteratePixelSmooth(type, cx, cy, maxIter, jx, jy);
    }
    return null;
  }

  // --- the main thread's entry point: the 3D heightmap ------------------------
  // Same iteration core, same clamp; only the output shape differs. Height is 0
  // inside the set and log-scaled outside it, exactly as before.
  function calculateHeightmap(width, height, params) {
    const type = params.type;
    const view = params.view;
    const maxIter = clampMaxIter(params.maxIter);
    const exaggeration = params.exaggeration == null ? 0.07 : params.exaggeration;
    const juliaParams = params.juliaParams;
    let jx = 0, jy = 0;
    if (type === 'julia' && juliaParams && juliaParams.c) {
      jx = juliaParams.c[0];
      jy = juliaParams.c[1];
    }
    const aspect = width / height;
    const scale = view.scale;
    const centerX = view.centerX;
    const centerY = view.centerY;
    const heights = new Float32Array(width * height);
    const logDen = Math.log(maxIter + 1);
    for (let y = 0; y < height; ++y) {
      for (let x = 0; x < width; ++x) {
        const cx = centerX + (x - width / 2) * scale / width * aspect;
        const cy = centerY + (y - height / 2) * scale / height;
        const state = iteratePixelState(type, cx, cy, maxIter, jx, jy);
        // The height is the DISCRETE iteration count, exactly as before: the 3D
        // heightmap is a geometry, not a colour, and D1 changes colour only.
        const iter = state.iter;
        const h = iter < maxIter ? Math.log(iter + 1) / logDen : 0;
        heights[y * width + x] = h * exaggeration;
      }
    }
    return heights;
  }

  // --- the ONE published global ----------------------------------------------
  FRACTAL_TYPES.forEach(Object.freeze);
  COLOR_SCHEMES.forEach(Object.freeze);
  const FractalKernel = Object.freeze({
    MAX_ITER: MAX_ITER,
    MIN_ITER: MIN_ITER,
    BAILOUT: BAILOUT,
    BAILOUT_SQ: BAILOUT_SQ,
    // D1: the ONE smooth-colour definition and the constants the GLSL is
    // templated with, so both renderers evaluate the identical expression.
    SMOOTH_LOG_BAILOUT: SMOOTH_LOG_BAILOUT,
    COLORS_LUT_STRIDE: COLORS_LUT_STRIDE,
    // D2: the size of the table a frame at THIS cap needs (a function, not the
    // module-maximum constant D1 exported), and the zoom-scaled budget rule.
    colorTableSize: colorTableSize,
    ITER_BUDGET_PER_DECADE: ITER_BUDGET_PER_DECADE,
    ITER_BUDGET_MIN_SCALE: ITER_BUDGET_MIN_SCALE,
    // P1: the perturbation core's chosen constants (see their definitions above).
    PERTURB_GLITCH_G: PERTURB_GLITCH_G,
    PERTURB_RESCALE_INTERVAL: PERTURB_RESCALE_INTERVAL,
    iterBudgetForScale: iterBudgetForScale,
    effectiveMaxIter: effectiveMaxIter,
    UNCALCULATED_COLOR: Object.freeze(UNCALCULATED_COLOR.slice()),
    FRACTAL_TYPES: Object.freeze(FRACTAL_TYPES),
    COLOR_SCHEMES: Object.freeze(COLOR_SCHEMES),
    colorSchemes: Object.freeze(colorSchemes),
    clampMaxIter: clampMaxIter,
    indexForType: indexForType,
    indexForColorScheme: indexForColorScheme,
    paletteFunction: paletteFunction,
    smoothIterationValue: smoothIterationValue,
    colorParameter: colorParameter,
    colorAtSmoothIteration: colorAtSmoothIteration,
    colorLutIndex: colorLutIndex,
    colorAtLutIndex: colorAtLutIndex,
    toRGBA: toRGBA,
    iteratePixel: iteratePixel,
    iteratePixelState: iteratePixelState,
    iteratePixelSmooth: iteratePixelSmooth,
    pixelToCoord: pixelToCoord,
    calcFractalChunk: calcFractalChunk,
    calculateHeightmap: calculateHeightmap
  });
  globalThis.FractalKernel = FractalKernel;
})();
