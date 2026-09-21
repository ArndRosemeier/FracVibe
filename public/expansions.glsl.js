// public/expansions.glsl.js — THE GLSL emitter for the k-component floating-point
// EXPANSION ladder (docs/DECISIONS.md rows 64-67; docs/STATE.md row
// MANTISSA-LADDER).
//
// WHAT THIS IS. A value is carried as an EXPANSION: k float32 components whose
// SUM is the value, most-significant first (`c0` is the leading term). The
// components are produced by ERROR-FREE TRANSFORMS, so the low components carry
// the rounding error the plain float32 arithmetic threw away. k is a parameter
// of the BUILD, not a constant of the algorithm: `emitGLSL(k)` returns source for
// that k, exactly the way `public/webglFractal.js` templates `MAX_ITER` into the
// shader. Depth grows with k, cost grows with k — the owner's accepted trade
// (docs/DECISIONS.md row 62: "slower the deeper it gets ... but no hard stop").
//
// WHY GLSL FIRST. An error-free transform is an algorithm over ROUNDING EVENTS:
// the low term of `TwoSum` is algebraically ZERO over the reals, so a compiler
// that may reassociate or fuse can erase the very information being recovered.
// GLSL fixes enough of that contract to be usable; WGSL explicitly does not
// (docs/RESEARCH-2026-09-21-arbitrary-depth.md §7, warning 1). Nothing here is
// WGSL-verified. See `docs/DECISIONS.md` row 66 for the WGSL warning in full.
//
// WHY THE ALGORITHMS ARE IMPLEMENTED FROM THE PUBLISHED PAPERS, NOT VENDORED.
// No third-party source was copied. The primitives are the published
// error-free transforms — Moller/Knuth `TwoSum`, Dekker's `FastTwoSum`, Dekker's
// split and `TwoProd` — and the arbitrary-k renormalisation is Priest's
// DISTILLATION (a fixed list of floats is turned into a nonoverlapping expansion
// while preserving its exact sum; see the `EX_*` bodies below). luma.gl's
// `fp64arithmetic` (MIT, vis.gl) is the reference implementation we build FROM
// conceptually, but no luma.gl source is reproduced here: the code below is
// generated for general k and is measured against our own BigInt oracle. The
// licence status of the prior art is recorded in docs/DECISIONS.md.
//
// WHY THERE IS NO `import` AND NO `export` IN THIS FILE (docs/DECISIONS.md row
// 14): the same no-import/no-export shape as `public/fractalKernel.js` and
// `public/bigOrbit.js`, so ONE source is loadable by a classic Worker
// (`importScripts`) AND by an ES-module main thread. It publishes exactly one
// frozen global, `globalThis.FractalExpansionsGLSL`.
//
// THE SPLITTER CONSTANT. `4097.0` is `2^12 + 1` for float32 (24-bit significand,
// 12-bit halves). The split it produces is EXACT for |a| < 2^60 or so, i.e. for
// every coordinate value this app forms.
(function (global) {
  'use strict';

  var SPLITTER = 4097.0;
  var SPLITTER_BITS = 12;
  // Dekker's split multiplies by the splitter before subtracting, so the split is
  // exact only while `SPLITTER * |a|` does not overflow float32. That bounds the
  // operands of `TwoProd` (NOT of `TwoSum`, which has no such precondition) to
  // |a| < 2^128 / 4097 ~= 8.3e34. Everything this renderer multiplies — a
  // coordinate or delta of order 1, an orbit value bounded by the escape radius —
  // is many orders inside that. The bound is exported and pinned so a future
  // caller cannot discover it as a surprise (a NaN residual).
  var SPLITTER_MAX = Math.pow(2, 128) / SPLITTER;
  // The largest k this emitter will produce. k is a build parameter, but an
  // unbounded k is a footgun: the unrolled distillation is O(k^4) statements, so
  // a typo silently emits a megabyte of GLSL. 8 is 192 bits of delta mantissa,
  // ~1e57 decimal, far past anything the orbit transport can feed.
  var MAX_K = 8;

  function checkK(k) {
    if (typeof k !== 'number' || k !== (k | 0) || k < 1 || k > MAX_K) {
      throw new Error('FractalExpansionsGLSL: k must be an integer in 1..' + MAX_K + ', got ' + k);
    }
  }

  function fields(k, fmt) {
    var out = [];
    for (var i = 0; i < k; i++) out.push(fmt(i));
    return out;
  }

  function constructor(k, name) {
    return name + '(' + fields(k, function (i) { return 'c' + i; }).join(', ') + ')';
  }

  // `a.c0, a.c1, ...` — the struct's own components in order.
  function spread(prefix, k) {
    return fields(k, function (i) { return prefix + '.c' + i; }).join(', ');
  }

  // EX_TO_FLOAT's body: (c0 + c1) + c2 + ..., left-associated, largest first.
  // This is the ONE place a whole expansion is collapsed to a float32, and it is
  // deliberately the plain order so it cannot drift from `hi + lo + ...`.
  function collapse(prefix, k, start) {
    var s = start === undefined ? 0 : start;
    if (k === 1) return prefix + '.c0';
    var expr = '(' + prefix + '.c0 + ' + prefix + '.c1)';
    for (var i = 2; i < k; i++) expr = '(' + expr + ' + ' + prefix + '.c' + i + ')';
    return expr;
  }

  // --- the shared primitive bodies ------------------------------------------
  // These are k-independent; nothing about them changes with k except how many
  // components the caller has.

  function primitiveSource() {
    return [
      '// Moller-Knuth TwoSum (6 flops, NO magnitude assumption).',
      '//   s + err == a + b EXACTLY, in float32.',
      'void TwoSum(float a, float b, out float s, out float err) {',
      '  s = a + b;',
      '  float bv = s - a;',
      '  err = (a - (s - bv)) + (b - bv);',
      '}',
      '',
      '// Dekker FastTwoSum (3 flops) — VALID ONLY WHEN |a| >= |b|.',
      '// The magnitude precondition is load-bearing: with |a| < |b| the residual is',
      '// wrong. It is emitted because the published ladder includes it and because',
      '// this project\'s pins must show the precondition is real, not decorative.',
      'void FastTwoSum(float a, float b, out float s, out float err) {',
      '  s = a + b;',
      '  err = b - (s - a);',
      '}',
      '',
      '// Dekker split: a == hi + lo EXACTLY, each half <= 12 bits of significand.',
      'void DekkerSplit(float a, out float hi, out float lo) {',
      '  float c = ' + SPLITTER.toFixed(1) + ' * a;',
      '  float abig = c - a;',
      '  hi = c - abig;',
      '  lo = a - hi;',
      '}',
      '',
      '// Dekker TwoProd: p == a * b rounded, p + err == a * b EXACTLY.',
      'void TwoProd(float a, float b, out float p, out float err) {',
      '  p = a * b;',
      '  float ah, al, bh, bl;',
      '  DekkerSplit(a, ah, al);',
      '  DekkerSplit(b, bh, bl);',
      '  float t = ah * bh;',
      '  err = ((t - p) + ah * bl + al * bh) + al * bl;',
      '}'
    ].join('\n');
  }

  // --- the distillation (renormalisation) ------------------------------------
  // Priest's distillation: for a list of floats t[0..n-1], applying TwoSum to
  // every pair (i<j) in order leaves t[0] the leading term and t[1..n-1] a
  // nonoverlapping expansion, with the EXACT sum of the input preserved (each
  // TwoSum is exact). Keeping the first K components is therefore "the exact
  // sum, truncated to K components" and the discarded tail is at the 2^-24K
  // relative level. Measured in the pins: the components stay ordered by
  // magnitude, which is what lets `slice(0, k)` be the truncation.
  function distillLines(names) {
    var out = [];
    for (var i = 0; i < names.length - 1; i++) {
      for (var j = i + 1; j < names.length; j++) {
        out.push('  TwoSum(' + names[i] + ', ' + names[j] + ', _s, _e); ' + names[i] + ' = _s; ' + names[j] + ' = _e;');
      }
    }
    return out;
  }

  // --- the generated ops -----------------------------------------------------

  function emitStruct(k, name) {
    var out = ['struct ' + name + ' {'];
    for (var i = 0; i < k; i++) out.push('  float c' + i + ';');
    out.push('};');
    return out.join('\n');
  }

  function emitConstructors(k, name) {
    var zeros = fields(k, function (i) { return i === 0 ? 'x' : '0.0'; }).join(', ');
    var allZero = fields(k, function () { return '0.0'; }).join(', ');
    return [
      name + ' EX_ZERO() { return ' + name + '(' + allZero + '); }',
      name + ' EX_FROM_FLOAT(float x) { return ' + name + '(' + zeros + '); }',
      'float EX_TO_FLOAT(' + name + ' a) { return ' + collapse('a', k) + '; }'
    ].join('\n');
  }

  function emitAdd(k, name) {
    if (k === 1) {
      return name + ' EX_ADD(' + name + ' a, ' + name + ' b) { return ' + name + '(a.c0 + b.c0); }';
    }
    var L = 2 * k;
    var names = fields(L, function (i) { return 't' + i; });
    var out = [name + ' EX_ADD(' + name + ' a, ' + name + ' b) {'];
    for (var i = 0; i < k; i++) out.push('  float t' + i + ' = a.c' + i + ';');
    for (var j = 0; j < k; j++) out.push('  float t' + (k + j) + ' = b.c' + j + ';');
    out.push('  float _s, _e;');
    out = out.concat(distillLines(names));
    out.push('  return ' + name + '(' + fields(k, function (m) { return 't' + m; }).join(', ') + ');');
    out.push('}');
    return out.join('\n');
  }

  function emitSub(k, name) {
    if (k === 1) {
      return name + ' EX_SUB(' + name + ' a, ' + name + ' b) { return ' + name + '(a.c0 - b.c0); }';
    }
    var L = 2 * k;
    var names = fields(L, function (i) { return 't' + i; });
    var out = [name + ' EX_SUB(' + name + ' a, ' + name + ' b) {'];
    for (var i = 0; i < k; i++) out.push('  float t' + i + ' = a.c' + i + ';');
    for (var j = 0; j < k; j++) out.push('  float t' + (k + j) + ' = -b.c' + j + ';');
    out.push('  float _s, _e;');
    out = out.concat(distillLines(names));
    out.push('  return ' + name + '(' + fields(k, function (m) { return 't' + m; }).join(', ') + ');');
    out.push('}');
    return out.join('\n');
  }

  function emitScale(k, name) {
    if (k === 1) {
      return name + ' EX_SCALE(' + name + ' a, float s) { return ' + name + '(a.c0 * s); }';
    }
    var L = 2 * k;
    var names = fields(L, function (i) { return 't' + i; });
    var out = [name + ' EX_SCALE(' + name + ' a, float s) {'];
    for (var i = 0; i < k; i++) {
      out.push('  float t' + (2 * i) + ', t' + (2 * i + 1) + ';');
      out.push('  TwoProd(a.c' + i + ', s, t' + (2 * i) + ', t' + (2 * i + 1) + ');');
    }
    out.push('  float _s, _e;');
    out = out.concat(distillLines(names));
    out.push('  return ' + name + '(' + fields(k, function (m) { return 't' + m; }).join(', ') + ');');
    out.push('}');
    return out.join('\n');
  }

  // Multiplying every component by a POWER OF TWO is exact in float32 (no
  // significand change), so no TwoProd/distillation is needed. The delta
  // recurrence's `S` is `exp2(-u_scaleShift)` — a power of two by construction —
  // so this is the cheap, exact scale the recurrence uses for `S * w^2`.
  function emitScalePow2(k, name) {
    return [
      name + ' EX_SCALE_POW2(' + name + ' a, float s) { // s MUST be a power of two (or 0)',
      '  return ' + name + '(' + fields(k, function (i) { return 'a.c' + i + ' * s'; }).join(', ') + ');',
      '}',
      '',
      name + ' EX_DOUBLE(' + name + ' a) {',
      '  return ' + name + '(' + fields(k, function (i) { return 'a.c' + i + ' * 2.0'; }).join(', ') + ');',
      '}'
    ].join('\n');
  }

  function emitMul(k, name) {
    if (k === 1) {
      return name + ' EX_MUL(' + name + ' a, ' + name + ' b) { return ' + name + '(a.c0 * b.c0); }';
    }
    var P = k * k;
    var L = 2 * P;
    var names = fields(L, function (i) { return 't' + i; });
    var out = [name + ' EX_MUL(' + name + ' a, ' + name + ' b) {'];
    var idx = 0;
    for (var i = 0; i < k; i++) {
      for (var j = 0; j < k; j++) {
        out.push('  float t' + idx + ', t' + (idx + 1) + ';');
        out.push('  TwoProd(a.c' + i + ', b.c' + j + ', t' + idx + ', t' + (idx + 1) + ');');
        idx += 2;
      }
    }
    out.push('  float _s, _e;');
    out = out.concat(distillLines(names));
    out.push('  return ' + name + '(' + fields(k, function (m) { return 't' + m; }).join(', ') + ');');
    out.push('}');
    return out.join('\n');
  }

  function emitSqr(k, name) {
    if (k === 1) {
      return name + ' EX_SQR(' + name + ' a) { return ' + name + '(a.c0 * a.c0); }';
    }
    return name + ' EX_SQR(' + name + ' a) { return EX_MUL(a, a); }';
  }

  // --- the delta recurrence step ---------------------------------------------
  // ONE step of the Mandelbrot perturbation recurrence the renderer already runs
  // (public/webglFractal.js, the `perturbBranch`):
  //
  //     w -> 2 Z w + S w^2 + d
  //
  // with w = (wx, wy) and d = (dx, dy) carried as EXPANSIONS and Z = (Zx, Zy)
  // the reference orbit value as a float32 (the shipped one-float32-per-component
  // transport; a multi-component ORBIT transport is a separate slice, DECISIONS
  // row 67). `S` is the rescaling factor, a power of two.
  //
  // WITH k == 1 EVERY OP REDUCES TO THE PLAIN EXPRESSION the shipped shader
  // computes, in the same association order:
  //     nwx = 2.0 * (Zx*wx - Zy*wy) + S * (wx*wx - wy*wy) + dx
  //     nwy = 2.0 * (Zx*wy + Zy*wx) + S * (2.0*wx*wy)      + dy
  // That identity is the property that lets the existing byte-identical shallow
  // pins keep passing after integration, and it is pinned in
  // tests/expansions.spec.js (pin 1).
  function emitDeltaStep(k, name) {
    return [
      '// ' + 'EX_DELTA_STEP: one perturbation step, all delta arithmetic in ' + k + '-component expansions.',
      'void EX_DELTA_STEP(' + name + ' wx, ' + name + ' wy, ' + name + ' dx, ' + name + ' dy,',
      '                  float Zx, float Zy, float S,',
      '                  out ' + name + ' nx, out ' + name + ' ny) {',
      '  ' + name + ' ax = EX_SCALE(wx, Zx);',
      '  ' + name + ' ay = EX_SCALE(wy, Zy);',
      '  ' + name + ' lx = EX_DOUBLE(EX_SUB(ax, ay));',
      '  ' + name + ' bx = EX_SCALE(wy, Zx);',
      '  ' + name + ' by = EX_SCALE(wx, Zy);',
      '  ' + name + ' ly = EX_DOUBLE(EX_ADD(bx, by));',
      '  ' + name + ' wx2 = EX_SQR(wx);',
      '  ' + name + ' wy2 = EX_SQR(wy);',
      '  ' + name + ' sqx = EX_SCALE_POW2(EX_SUB(wx2, wy2), S);',
      '  ' + name + ' sqy = EX_SCALE_POW2(EX_DOUBLE(EX_MUL(wx, wy)), S);',
      '  nx = EX_ADD(EX_ADD(lx, sqx), dx);',
      '  ny = EX_ADD(EX_ADD(ly, sqy), dy);',
      '}'
    ].join('\n');
  }

  // --- the public emitter ----------------------------------------------------

  function emitGLSL(k, opts) {
    checkK(k);
    opts = opts || {};
    var name = opts.name || 'Exp';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('FractalExpansionsGLSL: bad struct name ' + name);
    var parts = [
      '// ===== FracVibe expansion arithmetic, k = ' + k + ' (generated; do not edit) =====',
      '// Components are most-significant first: the value is c0 + c1 + ... + c' + (k - 1) + '.',
      emitStruct(k, name),
      '',
      emitConstructors(k, name),
      '',
      opts.primitives === false ? '// (primitives supplied by the caller)' : primitiveSource(),
      '',
      emitAdd(k, name),
      '',
      emitSub(k, name),
      '',
      emitScale(k, name),
      '',
      emitScalePow2(k, name),
      '',
      emitMul(k, name),
      '',
      emitSqr(k, name),
      '',
      emitDeltaStep(k, name)
    ];
    if (opts.includeRecurrence) parts.push('', opts.includeRecurrence(k, name));
    return parts.join('\n');
  }

  // Deterministic operation counts for one call of each op. THIS is the cost
  // model (measured against wall time in the spec); it is exact arithmetic on the
  // emitter's own structure, so a pin can hold it while a timing cannot.
  function opCounts(k) {
    checkK(k);
    // k == 1 is the plain-float32 rung: every op is ONE float32 operation and no
    // error-free transform runs at all. That is what makes k=1 byte-identical to
    // the pre-ladder expressions rather than merely equal to them.
    function add() {
      return k === 1
        ? { twoSum: 0, twoProd: 0, scale: 0, add: 1, sub: 0, mul: 0, sqr: 0 }
        : { twoSum: k * (2 * k - 1), twoProd: 0, scale: 0, add: 1, sub: 0, mul: 0, sqr: 0 };
    }
    function mul() {
      var p = k * k;
      return k === 1
        ? { twoSum: 0, twoProd: 0, scale: 0, add: 0, sub: 0, mul: 1, sqr: 0 }
        : { twoSum: p * (2 * p - 1), twoProd: p, scale: 0, add: 0, sub: 0, mul: 1, sqr: 0 };
    }
    function scale() {
      return k === 1
        ? { twoSum: 0, twoProd: 0, scale: 1, add: 0, sub: 0, mul: 1, sqr: 0 }
        : { twoSum: k * (2 * k - 1), twoProd: k, scale: 1, add: 0, sub: 0, mul: 0, sqr: 0 };
    }
    var step = { twoSum: 0, twoProd: 0, scale: 0, add: 0, sub: 0, mul: 0, sqr: 0 };
    function acc(o, n) {
      for (var key in o) { if (Object.prototype.hasOwnProperty.call(o, key)) step[key] += o[key] * n; }
    }
    acc(scale(), 4);   // ax, ay, bx, by
    acc(add(), 5);     // ly inner, nx inner+outer, ny inner+outer
    acc(mul(), 1);     // wx * wy
    acc(mul(), 2);     // wx^2, wy^2 (EX_SQR == EX_MUL for k > 1)
    // EX_SUB / EX_DOUBLE / EX_SCALE_POW2 contribute no twoSum/twoProd, so they are
    // not in this count. EX_SUB is counted as one `sub`, but the delta-step total
    // below is reported as its own row rather than folded into `add`/`sub`.
    var subCount = k === 1 ? 2 : 2; // EX_SUB(ax,ay), EX_SUB(wx2,wy2)
    return {
      k: k,
      bits: 24 * k,
      add: add(),
      mul: mul(),
      scale: scale(),
      deltaStep: step,
      deltaStepSubOps: subCount
    };
  }

  global.FractalExpansionsGLSL = Object.freeze({
    SPLITTER: SPLITTER,
    SPLITTER_BITS: SPLITTER_BITS,
    SPLITTER_MAX: SPLITTER_MAX,
    MAX_K: MAX_K,
    emitGLSL: emitGLSL,
    opCounts: opCounts,
    // The exact source fragment for the shared primitives, so a caller can build
    // its own shader around them without re-emitting the whole struct.
    primitiveSource: primitiveSource
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
