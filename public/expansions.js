// public/expansions.js — the JS-side FACADE and REFERENCE IMPLEMENTATION for the
// k-component floating-point expansion ladder (docs/DECISIONS.md rows 64-67).
//
// THE SPLIT OF WORK.
//   * public/expansions.glsl.js owns the GLSL: it EMITS the shader source for a
//     given k. `FractalExpansions.emitGLSL(k)` is the facade for it.
//   * this file owns the JS REFERENCE: `FractalExpansions.Expansion(k)` returns
//     the same algorithms evaluated in JavaScript with `Math.fround` after every
//     arithmetic operation, i.e. a faithful model of IEEE float32 semantics. The
//     tests use it three ways:
//       1. as the model the GPU output must match BIT-EXACTLY (does the shader
//          compiler preserve the rounding points the error-free transforms need?);
//       2. as the definition of the cost model (`opCounts`);
//       3. as a way to build the expected values for the independent BigInt
//          oracle without a second implementation of the same algorithm.
//   * the EXACT ORACLE (arbitrary-precision BigInt dyadic arithmetic) lives in
//     the TEST, deliberately not here: an oracle that shares code with the thing
//     under test is a tautology (docs/STATE.md §TRAP, "a reference that shares the
//     code path under test"). tests/expansions.spec.js carries its own.
//
// WHY THERE IS NO `import` AND NO `export` IN THIS FILE (docs/DECISIONS.md row
// 14): the same no-import/no-export shape as public/fractalKernel.js, so ONE
// source is loadable by a classic Worker (`importScripts`) AND by an ES-module
// main thread, with no build step. It publishes exactly one frozen global,
// `globalThis.FractalExpansions`.
//
// LOAD ORDER. `expansions.glsl.js` must be loaded before `emitGLSL` is called
// (it publishes `globalThis.FractalExpansionsGLSL`). The two files are loadable
// in either order; `emitGLSL` throws a precise error if the emitter is absent.
(function (global) {
  'use strict';

  var fround = Math.fround;
  // Double-single is the FIRST rung and the default (docs/DECISIONS.md row 66:
  // "k=2 (double-single) as the first rung ... the cheapest rung with a known
  // price").
  var K_DEFAULT = 2;

  // --- the primitives, exactly as emitted into GLSL ---------------------------
  // Every arithmetic step is rounded to float32, so this models the SAME sequence
  // of rounding events the shader executes. `Math.fround` of a float64 expression
  // is exactly one round-to-nearest-float32, and every intermediate below is
  // exactly representable in float64, so no double rounding is possible.

  function twoSum(a, b) {
    var s = fround(a + b);
    var bv = fround(s - a);
    var err = fround(fround(a - fround(s - bv)) + fround(b - bv));
    return [s, err];
  }

  function fastTwoSum(a, b) {
    var s = fround(a + b);
    var err = fround(b - fround(s - a));
    return [s, err];
  }

  function split(a) {
    var c = fround(4097 * a);
    var abig = fround(c - a);
    var hi = fround(c - abig);
    var lo = fround(a - hi);
    return [hi, lo];
  }

  function twoProd(a, b) {
    var p = fround(a * b);
    var ah = split(a), bh = split(b);
    var al = ah[1], bl = bh[1];
    ah = ah[0]; bh = bh[0];
    var t = fround(ah * bh);
    var err = fround(fround(fround(fround(t - p) + fround(ah * bl)) + fround(al * bh)) + fround(al * bl));
    return [p, err];
  }

  // Priest distillation over a flat list of float32s. Preserves the EXACT sum
  // (each TwoSum is exact) and leaves the leading term first. The GLSL emitter
  // generates the identical pair order, so the two agree bit-for-bit.
  function distill(list) {
    var t = list.slice();
    for (var i = 0; i < t.length - 1; i++) {
      for (var j = i + 1; j < t.length; j++) {
        var r = twoSum(t[i], t[j]);
        t[i] = r[0];
        t[j] = r[1];
      }
    }
    return t;
  }

  // --- the k-component expansion reference -----------------------------------

  /**
   * The reference implementation of the ladder at a fixed component count `k`.
   * Components are most-significant first; the value is the exact sum of them.
   */
  function Expansion(k) {
    if (typeof k !== 'number' || k !== (k | 0) || k < 1) {
      throw new Error('FractalExpansions.Expansion: k must be a positive integer, got ' + k);
    }
    function zero() {
      var a = new Array(k);
      for (var i = 0; i < k; i++) a[i] = 0;
      return a;
    }
    function fromFloat(x) {
      var a = zero();
      a[0] = fround(x);
      return a;
    }
    function toFloat(A) {
      var s = A[0];
      for (var i = 1; i < k; i++) s = fround(s + A[i]);
      return s;
    }
    function add(A, B) {
      if (k === 1) return [fround(A[0] + B[0])];
      return distill(A.concat(B)).slice(0, k);
    }
    function sub(A, B) {
      if (k === 1) return [fround(A[0] - B[0])];
      var l = A.concat(B.map(function (x) { return fround(-x); }));
      return distill(l).slice(0, k);
    }
    function mul(A, B) {
      if (k === 1) return [fround(A[0] * B[0])];
      var l = [];
      for (var i = 0; i < k; i++) {
        for (var j = 0; j < k; j++) {
          var r = twoProd(A[i], B[j]);
          l.push(r[0], r[1]);
        }
      }
      return distill(l).slice(0, k);
    }
    function sqr(A) {
      if (k === 1) return [fround(A[0] * A[0])];
      return mul(A, A);
    }
    function scale(A, s) {
      if (k === 1) return [fround(A[0] * fround(s))];
      var l = [];
      for (var i = 0; i < k; i++) {
        var r = twoProd(A[i], fround(s));
        l.push(r[0], r[1]);
      }
      return distill(l).slice(0, k);
    }
    // Multiplying by a power of two changes no significand bit, so it is exact
    // component-wise. The recurrence's `S` is `exp2(-u_scaleShift)`, a power of
    // two by construction.
    function scalePow2(A, s) {
      return A.map(function (x) { return fround(x * s); });
    }
    function double(A) {
      return A.map(function (x) { return fround(x * 2); });
    }
    // One perturbation step: w -> 2 Z w + S w^2 + d. Mirrors EX_DELTA_STEP.
    function deltaStep(wx, wy, dx, dy, Zx, Zy, S) {
      var ax = scale(wx, Zx);
      var ay = scale(wy, Zy);
      var lx = double(sub(ax, ay));
      var bx = scale(wy, Zx);
      var by = scale(wx, Zy);
      var ly = double(add(bx, by));
      var wx2 = sqr(wx);
      var wy2 = sqr(wy);
      var sqx = scalePow2(sub(wx2, wy2), S);
      var sqy = scalePow2(double(mul(wx, wy)), S);
      return {
        nx: add(add(lx, sqx), dx),
        ny: add(add(ly, sqy), dy)
      };
    }
    return Object.freeze({
      k: k,
      bitsPerComponent: 24,
      bits: 24 * k,
      zero: zero,
      fromFloat: fromFloat,
      toFloat: toFloat,
      add: add,
      sub: sub,
      mul: mul,
      sqr: sqr,
      scale: scale,
      scalePow2: scalePow2,
      double: double,
      deltaStep: deltaStep
    });
  }

  function emitGLSL(k, opts) {
    var G = global.FractalExpansionsGLSL;
    if (!G) {
      throw new Error('FractalExpansions.emitGLSL: public/expansions.glsl.js has not been loaded '
        + '(it publishes globalThis.FractalExpansionsGLSL); load it first.');
    }
    return G.emitGLSL(k, opts);
  }

  function opCounts(k) {
    var G = global.FractalExpansionsGLSL;
    if (!G) {
      throw new Error('FractalExpansions.opCounts: public/expansions.glsl.js has not been loaded.');
    }
    return G.opCounts(k);
  }

  global.FractalExpansions = Object.freeze({
    K_DEFAULT: K_DEFAULT,
    MAX_K: (global.FractalExpansionsGLSL && global.FractalExpansionsGLSL.MAX_K) || 8,
    SPLITTER: 4097.0,
    // TwoProd's Dekker split requires |a|,|b| < this (see expansions.glsl.js).
    SPLITTER_MAX: (global.FractalExpansionsGLSL && global.FractalExpansionsGLSL.SPLITTER_MAX)
      || (Math.pow(2, 128) / 4097),
    fround: fround,
    twoSum: twoSum,
    fastTwoSum: fastTwoSum,
    split: split,
    twoProd: twoProd,
    distill: distill,
    Expansion: Expansion,
    emitGLSL: emitGLSL,
    opCounts: opCounts
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
