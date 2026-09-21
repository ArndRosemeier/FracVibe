// public/fractalPerturb.js — the CPU lane's PERTURBATION + ORBIT port (prototype).
//
// WHY THIS FILE EXISTS. The CPU lane cannot render deep zoom at all
// (docs/DECISIONS.md row 63, re-measured in docs/PRECISION-CHAIN.md §6): the worker
// projects every pixel as an ABSOLUTE float64 coordinate, so below ~1e-13 the
// coordinate staircase quantises the whole frame, and from ~1e-16 there is one
// distinct coordinate (the centre's own ULP has swallowed the pixel offsets). It has
// no reference orbit, no perturbation, no rebasing and no glitch detection. This
// module is the missing mechanism (c) of DECISIONS 67, prototyped as a NEW FILE so
// the shipped lane is untouched.
//
// WHAT IT CONSUMES (the point of DECISIONS 52 — one copy of the arithmetic):
//   * `globalThis.BigOrbit`   — the arbitrary-precision reference orbit. This module
//     NEVER re-derives the orbit recurrence: it calls `BigOrbit.computeOrbitFixed`
//     exactly as the GPU lane does, so there is ONE orbit implementation.
//   * `globalThis.FractalKernel` — the iteration cap/clamps, the smooth (continuous)
//     escape-value definition and (through the viewer) the palette. Colours are NOT
//     computed here; this module produces the SAME `Float32Array` of smooth values
//     that `FractalKernel.calcFractalChunk` produces, so the existing
//     `FractalViewer`/LUT/GPU-parity colour path is reused unchanged.
//
// WHAT IT ADDS OVER THE GPU LANE: the CPU is not GLSL ES, so the delta arithmetic
// runs in float64 (53-bit significand, exponent to 1e-308) instead of float32. That
// is the standard architecture the research names (arbitrary-precision reference on
// the CPU, machine-precision deltas per pixel) and it removes the GPU's 24-bit delta
// mantissa and its 1e-38 delta-range wall in one step.
//
// LIMITS, STATED SO THEY ARE NOT OVERSELLED:
//   * The orbit is consumed through `BigOrbit.computeOrbitFixed`, whose return is the
//     GPU's float32 transport words (24-bit significand). At the depths measured here
//     that is sufficient (docs/PRECISION-CHAIN.md §4: 0.0000 % misclassification to
//     1e-40), but at depths where the perturbation samples past the orbit's own
//     chaotic divergence a float64/wide orbit accessor would be wanted — and that is
//     an edit to `public/bigOrbit.js`, deliberately NOT made by this slice.
//   * The per-pixel delta is float64, not arbitrary. So this port makes the CPU lane
//     deep and correct well past the GPU's float32 reach, but "genuinely arbitrary"
//     still needs the SAME delta-width ladder (mechanism b) on this path.
//   * Perturbation is Mandelbrot-only here, exactly as the GPU lane is
//     (`public/webglFractal.js:945-947`). Every other type, a shallow scale, or a
//     view with no exact decimal centre is delegated to `FractalKernel.calcFractalChunk`
//     — the shipped lane, byte-for-byte — so this module can never make a view worse.
(function (global) {
  'use strict';

  function K() {
    const k = global.FractalKernel;
    if (!k) throw new Error('FractalPerturb: globalThis.FractalKernel is not loaded');
    return k;
  }
  function B() {
    const b = global.BigOrbit;
    if (!b) throw new Error('FractalPerturb: globalThis.BigOrbit is not loaded');
    return b;
  }
  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  // --- the deep-lane condition -------------------------------------------------
  // A view can be perturbed only when it names its centre EXACTLY (a decimal string,
  // which is the only representation that survives past a float64 centre's own ULP)
  // and the type is Mandelbrot. This mirrors the GPU lane's own gate
  // (`public/webglFractal.js:945-969`): an exact centre below `BIGORBIT_MAX_SCALE`,
  // Mandelbrot only.
  function canPerturb(view, type) {
    return !!(view
      && typeof view.centerXExact === 'string'
      && typeof view.centerYExact === 'string'
      && (type === undefined || type === 'mandelbrot')
      && typeof view.scale === 'number' && view.scale > 0
      && view.scale < B().BIGORBIT_MAX_SCALE);
  }

  // --- the reference orbit (delegated to BigOrbit — ONE implementation) --------
  // The CPU lane has no texture limit, so the orbit may be maxIter + 1 entries even
  // where the GPU's MAX_TEXTURE_SIZE would clamp it. `bits` is the depth-derived
  // working precision (BigOrbit's own rule); it is exposed for the caller/observable.
  function referenceOrbit(centerXStr, centerYStr, maxIter, scale, widthLimit) {
    const k = K(), b = B();
    const cap = k.clampMaxIter(maxIter);
    const bits = b.bitsForScale(scale);
    const width = Math.max(1, Math.min(cap + 1, widthLimit || (cap + 1)));
    const t0 = nowMs();
    const r = b.computeOrbitFixed(centerXStr, centerYStr, cap, bits, width);
    return {
      zx: r.zx, zy: r.zy, width: r.width, bits: bits, escapedAt: r.escapedAt,
      cap: cap, scale: scale, centerXStr: centerXStr, centerYStr: centerYStr,
      ms: (typeof r.ms === 'number') ? r.ms : (nowMs() - t0),
      key: b.orbitKey(centerXStr, centerYStr, cap, bits),
    };
  }

  // --- the perturbation core ---------------------------------------------------
  // The SAME architecture as the shader (`public/webglFractal.js:253-309`), in
  // float64:
  //
  //     z_0 = 0,  z_{n+1} = 2 Z_m z_n + z_n^2 + dc,   pixel = Z_m + z_n
  //
  // with REBASING by the absorbed rule — when |Z_m + z|^2 < |z|^2, replace z with
  // Z_m + z and reset m to 0 — and Pauldelbrot GLITCH DETECTION
  // |Z_m + z|^2 < G |Z_m|^2. No rescaling is needed: float64's exponent range
  // (down to ~1e-308) cannot underflow at any scale the orbit itself can name, so
  // the GPU's `S`/`u_scaleShift` range split has no CPU analogue.
  //
  // The escape test is at the TOP of the loop, exactly like `FractalKernel`'s own
  // `iteratePixelState`, so `iter` is the number of updates completed before the test
  // fired and `smoothIterationValue(escapeRadiusSq, iter, cap)` is the identical
  // continuous value the shipped CPU lane and the shader produce.
  function perturbState(orbit, dcx, dcy, maxIter, opts) {
    const k = K();
    const G = k.PERTURB_GLITCH_G;
    const bail = k.BAILOUT_SQ;
    const rebaseOn = !(opts && opts.rebase === false);
    const ox = orbit.zx, oy = orbit.zy, wlast = orbit.width - 1;
    let dzx = dcx, dzy = dcy;   // z
    let m = 0, iter = 0, esc = 0;
    let rebases = 0, glitches = 0, maxM = 0, orbitClamped = 0;
    while (iter < maxIter) {
      let Zx = ox[m], Zy = oy[m];
      // current state, tested at the top like the kernel's own loop
      let x = Zx + dzx, y = Zy + dzy;
      esc = x * x + y * y;
      if (esc > bail) return { iter: iter, escapeRadiusSq: esc, rebases: rebases, glitches: glitches, maxM: maxM, orbitClamped: orbitClamped };
      // Pauldelbrot: a glitch is possible when |Z + z|^2 < G |Z|^2. Diagnostic only
      // (the shipped GPU lane also only records it), so it does not change the value.
      const Z2 = Zx * Zx + Zy * Zy;
      if (Z2 > 0 && esc < G * Z2) glitches++;
      // advance: z <- 2 Z_m z + z^2 + dc
      const nwx = 2 * (Zx * dzx - Zy * dzy) + (dzx * dzx - dzy * dzy) + dcx;
      const nwy = 2 * (Zx * dzy + Zy * dzx) + 2 * (dzx * dzy) + dcy;
      dzx = nwx; dzy = nwy;
      m++;
      if (m > maxM) maxM = m;
      if (m > wlast) { m = wlast; orbitClamped++; }
      // REBASING on the new state (the GPU's absorbed form, `webglFractal.js:288-293`)
      if (rebaseOn) {
        const wx = ox[m] + dzx, wy = oy[m] + dzy;
        const w2 = wx * wx + wy * wy;
        const z2 = dzx * dzx + dzy * dzy;
        if (w2 < z2) { dzx = wx; dzy = wy; m = 0; rebases++; }
      }
      iter++;
    }
    return { iter: iter, escapeRadiusSq: esc, rebases: rebases, glitches: glitches, maxM: maxM, orbitClamped: orbitClamped };
  }

  // The SMOOTH value of one pixel: the perturbation core's escape state mapped by
  // the kernel's ONE continuous definition, so this module owns no colour math.
  function perturbSmooth(orbit, dcx, dcy, maxIter, opts) {
    const k = K();
    const st = perturbState(orbit, dcx, dcy, maxIter, opts);
    st.smooth = k.smoothIterationValue(st.escapeRadiusSq, st.iter, maxIter);
    return st;
  }

  // --- the orbit cache -------------------------------------------------------
  // One orbit per (exact centre, budget, working precision) — the same identity the
  // GPU lane keys on (`BigOrbit.orbitKey`). A small bounded map, because the
  // prototype is driven per frame by the suite; a real worker would keep one.
  const MAX_CACHED_ORBITS = 8;
  const orbitCache = new Map();
  const counters = { orbitsBuilt: 0, orbitMs: 0, frames: 0, chunks: 0, perturbed: 0, delegated: 0 };

  function orbitFor(view, cap) {
    const key = B().orbitKey(view.centerXExact, view.centerYExact, cap, B().bitsForScale(view.scale));
    if (orbitCache.has(key)) return orbitCache.get(key);
    const o = referenceOrbit(view.centerXExact, view.centerYExact, cap, view.scale, cap + 1);
    orbitCache.set(key, o);
    counters.orbitsBuilt++;
    counters.orbitMs += o.ms;
    if (orbitCache.size > MAX_CACHED_ORBITS) {
      orbitCache.delete(orbitCache.keys().next().value);
    }
    return o;
  }

  // --- the frame: the shape the suite and a future worker both use --------------
  // Produces the SAME payload the shipped CPU lane produces — a Float32Array of
  // smooth escape values (NaN for uncalculated) — so the existing viewer colour path
  // applies it unchanged.
  function renderFrame(view, maxIter, width, height, opts) {
    const k = K();
    const type = (opts && opts.type) || 'mandelbrot';
    const cap = (opts && opts.cap) ? k.clampMaxIter(opts.cap) : k.effectiveMaxIter(maxIter, view.scale);
    const smooth = new Float32Array(width * height).fill(NaN);
    if (!canPerturb(view, type)) {
      // Delegate to the shipped kernel, one chunk at a time, exactly as the worker
      // does. This is why the prototype can never regress a view it cannot improve.
      const indices = [];
      for (let i = 0; i < width * height; i++) indices.push(i);
      const job = {
        width: width, height: height, type: type, maxIter: cap, view: view,
        params: (opts && opts.params) || {}, gridStep: 1, prior: null, chunk: indices,
      };
      k.calcFractalChunk(job, smooth);
      counters.delegated++;
      return { smooth: smooth, delegated: true, cap: cap, width: width, height: height };
    }
    const t0 = nowMs();
    const orbit = orbitFor(view, cap);
    const aspect = width / height;
    let rebases = 0, glitches = 0, maxM = 0, orbitClamped = 0;
    for (let j = 0; j < height; j++) {
      const v = (j + 0.5) / height;
      const dcy = ((1 - v) - 0.5) * view.scale;
      for (let i = 0; i < width; i++) {
        const u = (i + 0.5) / width;
        const dcx = (u - 0.5) * view.scale * aspect;
        const st = perturbSmooth(orbit, dcx, dcy, cap, opts);
        smooth[j * width + i] = st.smooth;
        rebases += st.rebases; glitches += st.glitches;
        if (st.maxM > maxM) maxM = st.maxM;
        orbitClamped += st.orbitClamped;
      }
    }
    counters.frames++;
    return {
      smooth: smooth, delegated: false, cap: cap, width: width, height: height,
      bits: orbit.bits, orbitWidth: orbit.width, orbitMs: orbit.ms, orbitKey: orbit.key,
      ms: nowMs() - t0, rebases: rebases, glitches: glitches, maxM: maxM,
      orbitClamped: orbitClamped,
    };
  }

  // --- the worker-shaped entry point -------------------------------------------
  // The same contract as `FractalKernel.calcFractalChunk`: fill the still-NaN cells
  // of `result` for `job.chunk`. A future CPU worker can call THIS instead of the
  // kernel with no other change; when the view cannot be perturbed it calls the
  // kernel itself, so the shallow lane and every non-Mandelbrot type are untouched.
  function calcPerturbChunk(job, result) {
    const k = K();
    const type = job.type || 'mandelbrot';
    const view = job.view;
    if (!canPerturb(view, type)) {
      counters.delegated++;
      return k.calcFractalChunk(job, result);
    }
    const width = job.width, height = job.height;
    const cap = k.clampMaxIter(job.maxIter);
    const maxIter = cap;
    const orbit = orbitFor(view, cap);
    const aspect = width / height;
    for (let ci = 0; ci < job.chunk.length; ci++) {
      const idx = job.chunk[ci];
      if (result[idx] === result[idx]) continue; // NaN is "not yet calculated"
      const x = idx % width;
      const y = (idx / width) | 0;
      const dcx = (x + 0.5 - width / 2) * view.scale / width * aspect;
      const dcy = (y + 0.5 - height / 2) * view.scale / height;
      result[idx] = perturbSmooth(orbit, dcx, dcy, maxIter, job).smooth;
    }
    counters.chunks++;
    counters.perturbed++;
    return null;
  }

  function stats() {
    return {
      orbitsBuilt: counters.orbitsBuilt,
      orbitMs: counters.orbitMs,
      frames: counters.frames,
      chunks: counters.chunks,
      perturbed: counters.perturbed,
      delegated: counters.delegated,
      cachedOrbits: orbitCache.size,
    };
  }
  function clearCache() { orbitCache.clear(); }

  global.FractalPerturb = Object.freeze({
    canPerturb: canPerturb,
    referenceOrbit: referenceOrbit,
    perturbState: perturbState,
    perturbSmooth: perturbSmooth,
    renderFrame: renderFrame,
    calcPerturbChunk: calcPerturbChunk,
    stats: stats,
    clearCache: clearCache,
  });
})(typeof self !== 'undefined' ? self : globalThis);
