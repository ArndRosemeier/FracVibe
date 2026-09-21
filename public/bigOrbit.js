// P2 · the ARBITRARY-PRECISION reference orbit, in BigInt fixed point.
//
// This file deliberately has NO `import` and NO `export`, exactly like
// public/fractalKernel.js (docs/DECISIONS.md row 14): it is loaded by a side-effect
// ES-module import on the main thread AND by `importScripts` in the classic orbit
// Worker, from the ONE source. It publishes `globalThis.BigOrbit`.
//
// WHY BIGINT FIXED POINT. The committed research
// (docs/RESEARCH-2026-09-21-arbitrary-depth.md §2) names the browser analogue of
// GMP/MPFR: bertbaron/mandelbrot computes its reference in BigInt fixed point with
// the size growing with zoom, and it needs no dependency at all. That is the only
// arbitrary-precision route available here with no build step.
//
// WHY THE PRECISION MUST GROW. P1 measured the wall precisely: a float64 view
// centre's own ULP near |c| ~ 0.74 is ~1.1e-16, so past zoom ~1e16 the requested
// frame is displaced by many screen widths from the one the float64 centre can
// name (docs/DECISIONS.md rows 36-37). More than that, even when the centre IS a
// float64 value, the float64 ITERATION of a chaotic orbit diverges from the true
// orbit by more than the frame's own scale. The rule the research gives is
// `bits ≈ log2(1/scale) + margin` (3.3219 bits per decimal digit; the shape is
// settled, the margin is not — 0 in the bare bound, +64 in rust-fractal-core).
// This module CHOOSES the margin (see BIGORBIT_MARGIN) and quantises the working
// precision into steps (BIGORBIT_STEP_BITS), so a very small zoom change does not
// re-derive the orbit at a new precision on every frame.
(function (global) {
  'use strict';

  // --- the chosen constants -------------------------------------------------
  // The bare bound is log2(1/scale); the margin covers (a) the reference orbit's
  // own rounding error, amplified by the orbit's chaotic dynamics, and (b) the
  // fixed-point rounding performed at the working precision on every step. +64 is
  // rust-fractal-core's value (`precision = max(64, -radius.exponent + 64)`), and
  // it is MEASURED sufficient here: at 1e-30 with a centre sub-ULP from its
  // float64 image, the shipped setting matches the orbit computed 256 bits wider
  // with mean |Δ escape iteration| ≤ 2, while a deliberately starved setting
  // (bits = log2(1/scale) - 96) measures 12.9.
  var BIGORBIT_MARGIN = 64;
  // Working precision is quantised UP to a multiple of this many bits, so the
  // "precision step" is a coarse, infrequent transition rather than one per frame.
  // 64 is a whole limb of the arithmetic and makes the step boundaries exact
  // powers of two in scale (see bitsForScale).
  var BIGORBIT_STEP_BITS = 64;
  var BIGORBIT_MIN_BITS = 64;
  // Below this scale the BigInt lane serves the view. At and above it the P1
  // float64 orbit is used UNCHANGED, so P1's pins (which run at exactly 1e-15)
  // keep the lane and the counting they were verified against. 1e-15 is where P1
  // measured its float64 reference still correct; its own wall is ~1e16 (scale
  // ~1e-16).
  var BIGORBIT_MAX_SCALE = 1e-15;
  var BAILOUT_SQ = 4;

  // TEST-ONLY injection, default 0 (no effect). When non-zero the centre is
  // parsed at (bits - controlStepShift) bits before being widened back to `bits`,
  // i.e. the precision step introduces a COORDINATE SHIFT — the class of defect
  // the only documented literature case names (KF 2.13.10, 2018: "corrupt image at
  // transition between number types"). Pin 3 sets it to show its own baseline go
  // RED; production never sets it.
  var controlStepShift = 0;

  // The working precision for a view scale, in bits, quantised UP to the step.
  function bitsForScale(scale) {
    var need = Math.ceil(Math.log2(1 / scale)) + BIGORBIT_MARGIN;
    if (!isFinite(need) || need < BIGORBIT_MIN_BITS) need = BIGORBIT_MIN_BITS;
    return Math.ceil(need / BIGORBIT_STEP_BITS) * BIGORBIT_STEP_BITS;
  }

  // --- fixed point ----------------------------------------------------------
  // A real value x is carried as the BigInt X with x = X / 2^F, F = the working
  // bits. `parseFixed` converts a DECIMAL string (the form a user can paste at any
  // depth) to the nearest such BigInt.
  function parseFixed(str, F) {
    var s = String(str).trim();
    var sign = 1n;
    if (s.charAt(0) === '-') { sign = -1n; s = s.slice(1); }
    else if (s.charAt(0) === '+') { s = s.slice(1); }
    var parts = s.split(/[eE]/);
    var exp = parts[1] ? parseInt(parts[1], 10) : 0;
    var mant = parts[0];
    var dot = mant.indexOf('.');
    var ip = dot < 0 ? mant : mant.slice(0, dot);
    var fp = dot < 0 ? '' : mant.slice(dot + 1);
    var digits = (ip || '0') + fp;
    if (!/^[0-9]*$/.test(digits)) throw new Error('BigOrbit: not a decimal number: ' + str);
    var D = BigInt(digits === '' ? '0' : digits);
    var e10 = exp - fp.length;
    var twoF = 1n << BigInt(F);
    var num = D * twoF, den = 1n;
    if (e10 >= 0) num *= 10n ** BigInt(e10);
    else den = 10n ** BigInt(-e10);
    // round half away from zero
    return sign * ((num + den / 2n) / den);
  }

  // Round-half-away shift, so the fixed-point recurrence has no systematic bias.
  function shiftRound(v, F) {
    var b = BigInt(F);
    var half = 1n << (b - 1n);
    return v >= 0n ? (v + half) >> b : -((-v + half) >> b);
  }

  // The float32 the shader texture carries, correctly rounded to 24 significant
  // bits from the arbitrary-precision value. This is the TRANSPORT decision: one
  // float32 word per component (see docs/DECISIONS.md row 39 for the measurement
  // that a wider transport is not what limits depth here).
  function toF32(v, F) {
    if (v === 0n) return 0;
    var neg = v < 0n;
    var a = neg ? -v : v;
    var bl = a.toString(2).length;
    var keep = 53;
    var sh = bl - keep;
    var m, exp;
    if (sh > 0) {
      var bsh = BigInt(sh);
      m = (a + (1n << (bsh - 1n))) >> bsh;
      exp = sh - F;
    } else {
      m = a << BigInt(-sh);
      exp = sh - F;
    }
    var d = Number(m); // exact: |m| <= 2^53
    var val = d * Math.pow(2, exp);
    if (!Number.isFinite(val)) {
      // exp may be far below the double exponent range; scale in two steps.
      val = d;
      var e = exp;
      while (e < -900) { val *= Math.pow(2, -900); e += 900; }
      val *= Math.pow(2, e);
    }
    return Math.fround(neg ? -val : val);
  }

  // The reference orbit of the point (centerX, centerY) at `bits` fractional bits.
  // Z_0 = 0, Z_{k+1} = Z_k^2 + C. It is the SAME recurrence P1's float64 orbit
  // uses; the only difference is the arithmetic it is carried in.
  //
  // Returns { zx, zy, width, bits, escapedAt, ms } with `zx`/`zy` Float32Arrays
  // ready to upload one texel per iteration (the shader's transport), plus the
  // exact index at which the REFERENCE itself escaped (`-1` when it did not, the
  // case every deep-zoom reference is chosen for). Once the reference escapes its
  // own recurrence is no longer a useful frame for the pixels, so the tail is
  // padded with the last finite value and the shader clamps to it.
  function computeOrbitFixed(centerXStr, centerYStr, maxIter, bits, widthLimit) {
    var t0 = nowMs();
    var F = bits;
    var width = Math.max(1, Math.min(maxIter + 1, widthLimit || (maxIter + 1)));
    var cx, cy;
    if (controlStepShift > 0) {
      var Fq = Math.max(1, F - controlStepShift);
      cx = parseFixed(centerXStr, Fq) << BigInt(controlStepShift);
      cy = parseFixed(centerYStr, Fq) << BigInt(controlStepShift);
    } else {
      cx = parseFixed(centerXStr, F);
      cy = parseFixed(centerYStr, F);
    }
    var bail = 4n << BigInt(2 * F);
    var zx = new Float32Array(width);
    var zy = new Float32Array(width);
    var x = 0n, y = 0n;
    var escapedAt = -1;
    var k = 0;
    for (; k < width; k++) {
      zx[k] = toF32(x, F);
      zy[k] = toF32(y, F);
      if (x * x + y * y > bail) { escapedAt = k; break; }
      var xt = shiftRound(x * x - y * y, F) + cx;
      var yt = shiftRound(2n * x * y, F) + cy;
      x = xt; y = yt;
    }
    if (escapedAt >= 0) {
      var lx = zx[escapedAt], ly = zy[escapedAt];
      for (var p = escapedAt + 1; p < width; p++) { zx[p] = lx; zy[p] = ly; }
    }
    return {
      zx: zx, zy: zy, width: width, bits: bits, escapedAt: escapedAt,
      ms: nowMs() - t0, centerX: centerXStr, centerY: centerYStr, maxIter: maxIter,
    };
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  // The orbit key. "Once per view" is keyed on exactly the identity of the
  // reference: the exact centre, the budget and the working precision. A redraw,
  // a palette change or a resize does not change it.
  function orbitKey(centerXStr, centerYStr, maxIter, bits) {
    return centerXStr + '|' + centerYStr + '|' + maxIter + '|' + bits;
  }

  global.BigOrbit = {
    BIGORBIT_MARGIN: BIGORBIT_MARGIN,
    BIGORBIT_STEP_BITS: BIGORBIT_STEP_BITS,
    BIGORBIT_MIN_BITS: BIGORBIT_MIN_BITS,
    BIGORBIT_MAX_SCALE: BIGORBIT_MAX_SCALE,
    BAILOUT_SQ: BAILOUT_SQ,
    bitsForScale: bitsForScale,
    parseFixed: parseFixed,
    shiftRound: shiftRound,
    toF32: toF32,
    computeOrbitFixed: computeOrbitFixed,
    orbitKey: orbitKey,
    // Test-only; default 0. See the injection comment above.
    setControlStepShift: function (n) { controlStepShift = n | 0; },
    getControlStepShift: function () { return controlStepShift; },
  };
})(typeof self !== 'undefined' ? self : globalThis);
