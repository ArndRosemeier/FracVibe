// public/gpuDiagnostic.js — the HARDWARE-CERTIFICATION INSTRUMENT.
//
// WHY THIS EXISTS (docs/DECISIONS.md rows 65-67). This host runs SwiftShader for
// both WebGL and WebGPU, so we can BUILD and MEASURE the k-component expansion
// ladder here but cannot certify that a residual term survives a real vendor
// compiler and driver. The owner has offered to press a button on a real GPU and
// report the console. This module is that button.
//
// WHAT IT MEASURES, and why each item is load-bearing:
//   * IDENTITY   — which driver we are actually talking to. A "GPU" report that
//                  is really SwiftShader/llvmpipe is the first thing to rule out.
//   * FEATURES   — the capabilities that gate our lanes. The load-bearing one is
//                  whether a float texture is actually SAMPLEABLE: the deep lane
//                  samples the reference orbit from one. A driver that accepts
//                  OES_texture_float but returns zeros makes every deep number a
//                  lie, so the test uploads a known texture, samples it in a real
//                  draw and compares the readback against what was written.
//   * DOUBLE-SINGLE RESIDUAL (the most important item) — our planned extra
//                  precision is an EXPANSION (two or more f32 terms whose sum is
//                  the value). The research (docs/RESEARCH-2026-09-21-arbitrary-
//                  depth.md §7) warns that a reassociating/fusing compiler can
//                  erase the low term, because TwoSum's low term is algebraically
//                  ZERO over the reals. So we run a standalone test shader (NOT the
//                  shipped shader) that computes a known residual and reports BOTH
//                  whether the low component is non-zero AND whether it changes
//                  the result. A plausible high term with an erased low term is
//                  exactly the failure the owner's machine can settle.
//   * DEEP LANE  — the real perturbation path, end to end, against an independent
//                  reference computed IN THE PAGE: the CPU kernel's own float64
//                  recurrence at 1e-6, and a direct BigInt iteration at 1e-20 that
//                  shares nothing with the GPU path. Reports % misclassified and
//                  mean |Δ iteration|, plus orbitSource so we know the deep lane
//                  actually engaged.
//   * READBACK   — gl.getError() and whether readPixels returns plausible data. A
//                  driver that silently fails readback makes every other number a
//                  lie.
//   * COST       — renderTimeMs() at three depths, the first real-hardware timings.
//                  The reading is taken AFTER the app's own completion signal
//                  (`__fv.whenRenderIdle()`), i.e. after the full-resolution pass
//                  of the refinement chain; a step whose full-image render does not
//                  complete is an explicit SKIP, never a number (see the cost loop).
//
// DESIGN CONSTRAINTS.
//   * It integrates with the app ONLY through the frozen `window.__fv` observables
//     and never imports or edits app.js / webglFractal.js / fractalKernel.js.
//   * Every item reports its own SKIP/FAIL; no item can abort another, and every
//     expected item is emitted exactly once on every path (a guard fails an item,
//     it never drops it). A battery-level error still prints a report.
//   * It restores the view it changed before it returns.
//   * A second press is safe: while running it refuses; after it completes it reruns.
//
// The console output is one block: a `===== GPU DIAGNOSTIC (FracVibe) =====` header,
// a one-line SUMMARY, one section per group, and one line per item. Every item line
// is either `<id>: <value>` (OK) or `<id>: SKIP (reason)` / `<id>: FAIL (reason)`.

const HEADER = '===== GPU DIAGNOSTIC (FracVibe) =====';
const REPORT_ID = 'gpuDiagnostic/1';

// The deep views. The float64-lane probe is a real deep view (it engages the
// perturbation lane, which starts below `__fv.minScale` = 1e-4) whose absolute
// float64 reference is still valid, so the app's own CPU recurrence can be the
// independent reference. The BigInt-lane probe is past the float64 wall: its
// centre is C0 + 2^-70, the bounded Misiurewicz point the P2 pins use, and the
// reference is a direct BigInt iteration that shares nothing with the GPU path.
const FLOAT_DEEP_SCALE = 1e-6;
const FLOAT_DEEP_X = -0.743643887037151;
const FLOAT_DEEP_Y = 0.13182590420533;
const BIGINT_SCALE = 1e-20;
const BIGINT_X = -1.4303576324512;
const BIGINT_Y = 0;
const BIGINT_X_EXACT = '-1.4303576324511999562352627230442381200958834597258828580379486083984375';
const BIGINT_Y_EXACT = '0';

const COST_STEPS = [
  { id: 'cost_1e-4', scale: 1e-4 },
  { id: 'cost_1e-6', scale: 1e-6 },
  { id: 'cost_1e-8', scale: 1e-8 },
];

// How long ONE cost step may spend waiting for its full-resolution pass. A deep
// full-image pass on a software rasteriser can run to tens of seconds; past this
// budget the step is reported as an explicit SKIP rather than as a stale number.
const COST_SETTLE_TIMEOUT_MS = 60000;

// The known double-single values. 1 + 2^-25 rounds to 1.0 in f32, so its exact
// TwoSum residual is 2^-25 (representable). 1 + 2^-12 squared is a Dekker classic:
// the exact product 1 + 2^-11 + 2^-24 ties to even, so `p = 1 + 2^-11` and the
// residual is exactly -2^-24.
const DS_SMALL = Math.pow(2, -25);
const DS_SPLIT = 1 + Math.pow(2, -12);

let running = false;
let lastReport = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

async function waitFor(predicate, timeoutMs, intervalMs) {
  const t0 = now();
  for (;;) {
    let v = false;
    try { v = predicate(); } catch (_) { v = false; }
    if (v) return true;
    if (now() - t0 > timeoutMs) return false;
    await sleep(intervalMs || 120);
  }
}

function errText(err) {
  if (!err) return 'unknown error';
  return (err && err.message) ? String(err.message) : String(err);
}

// One report line must never wrap or contain 'undefined'/'[object Object]'.
function clean(value) {
  const s = (value === undefined) ? 'undefined' : String(value);
  return s.replace(/[\r\n]+/g, ' ').replace(/\s+$/, '');
}

function fmtExp(x) {
  if (!isFinite(x)) return String(x);
  if (x === 0) return '0';
  return x.toExponential(3);
}

// ---------------------------------------------------------------------------
// GL helpers. The probe context is OURS: it never touches the app's renderer.
// ---------------------------------------------------------------------------

function createGL(type, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  let gl = null;
  try {
    gl = canvas.getContext(type, {
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
  } catch (_) {
    gl = null;
  }
  return { canvas: canvas, gl: gl };
}

const VERT_SRC = 'attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }';
// GLSL ES 3.00 (WebGL2) needs a matching vertex shader version; mixing a 1.00
// vertex shader with a 3.00 fragment shader is not portable.
const VERT_SRC_300 = '#version 300 es\nin vec2 a_pos;\nvoid main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n';

function compileProgram(gl, fragSrc, vertSrc) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vertSrc || VERT_SRC);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    throw new Error('vertex compile: ' + clean(gl.getShaderInfoLog(vs)));
  }
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fragSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    throw new Error('fragment compile: ' + clean(gl.getShaderInfoLog(fs)));
  }
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + clean(gl.getProgramInfoLog(p)));
  }
  return p;
}

function fullscreenQuad(gl, program) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return buf;
}

const FLOAT_TEX_FRAG = [
  '#ifdef GL_FRAGMENT_PRECISION_HIGH',
  'precision highp float;',
  '#else',
  'precision mediump float;',
  '#endif',
  'uniform sampler2D u_tex;',
  'void main() { gl_FragColor = vec4(texture2D(u_tex, vec2(0.5, 0.5)).rgb, 1.0); }',
].join('\n');

// The double-single probe. `probe` 0: TwoSum low component of (1, 2^-25), scaled
// by 2^25. `probe` 1: compensated accumulation of 64 x 2^-25 into 1.0 against the
// naive sum — the "does the low term change the result" arm. `probe` 2: Dekker
// TwoProd residual of (1+2^-12)^2, scaled by 2^24. `probe` 3: a fixed sentinel, so
// a broken readback mapping is distinguishable from an erased residual.
const DS_FRAG = [
  '#ifdef GL_FRAGMENT_PRECISION_HIGH',
  'precision highp float;',
  '#else',
  'precision mediump float;',
  '#endif',
  'uniform float u_b;',
  'uniform float u_c;',
  'uniform float u_d;',
  'void twoSum(float a, float b, out float s, out float e) {',
  '  s = a + b;',
  '  float bb = s - a;',
  '  e = (a - (s - bb)) + (b - bb);',
  '}',
  'void split(float a, out float hi, out float lo) {',
  '  float t = 4097.0 * a;', // 2^12 + 1
  '  hi = t - (t - a);',
  '  lo = a - hi;',
  '}',
  'void twoProd(float a, float b, out float p, out float e) {',
  '  p = a * b;',
  '  float ah, al, bh, bl;',
  '  split(a, ah, al);',
  '  split(b, bh, bl);',
  '  e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;',
  '}',
  'void main() {',
  '  int probe = int(gl_FragCoord.x);',
  '  float r = 0.0, g = 0.0, b = 0.0;',
  '  if (probe == 0) {',
  '    float s, e; twoSum(1.0, u_b, s, e);',
  '    r = e * 33554432.0;', // 2^25
  '    g = s;',
  '  } else if (probe == 1) {',
  '    float naive = 1.0;',
  '    float s = 1.0;',
  '    float c = 0.0;',
  '    for (int i = 0; i < 64; i++) {',
  '      naive += u_b;',
  '      float hi, lo; twoSum(s, u_b, hi, lo);',
  '      s = hi; c += lo;',
  '    }',
  '    float comp = s + c;',
  '    r = (comp - 1.0) * 524288.0;', // 2^19
  '    g = naive;',
  '    b = (comp != naive) ? 1.0 : 0.0;',
  '  } else if (probe == 2) {',
  '    float p, e; twoProd(u_c, u_d, p, e);',
  '    r = min(1.0, abs(e) * 16777216.0);', // 2^24
  '    g = p;',
  '    b = (e != 0.0) ? 1.0 : 0.0;',
  '  } else {',
  '    r = 1.0; g = 1.0; b = 1.0;',
  '  }',
  '  gl_FragColor = vec4(r, g, b, 1.0);',
  '}',
].join('\n');

// ---------------------------------------------------------------------------
// INTEGER-CONTROLLED DOUBLE-SINGLE — the D3D11 answer (DECISIONS 101).
//
// WHY THIS EXISTS. The owner's RTX 5070 report measured the CLASSIC error-free
// transforms being erased: with operands supplied as uniforms (so they cannot be
// constant-folded) ANGLE/D3D11 still gave ds_low_component ZERO,
// ds_low_changes_result NO and ds_twoprod_low ZERO. The low term of a TwoSum is
// algebraically zero over the reals, so a compiler that reassociates or fuses can
// delete the rounding event that recovered it. RESEARCH §7 warning 1 names the
// robust alternative: do not derive the residual from a float rounding event at
// all — DECODE the float32 operands into sign/exponent/significand integers and
// compute the exact product/sum in INTEGER arithmetic, where no reassociation can
// erase a bit. This probe measures that alternative on the SAME shader stack.
//
// WHAT IS BEING TESTED, at the level of the recurrence's own operations
// (`w -> 2 Z w + S w^2 + d`, DECISIONS 66):
//   * T0 twoprod    — the exact 24x24-bit product, the operation the float probe lost.
//   * T1 sum        — an exact accumulation with explicit renormalisation.
//   * T2 recurrence — one step of the recurrence form, expansion throughout.
// For each, the report gives the RUNTIME-OPERAND arm (uniforms — the case that
// failed on the owner's driver) AND the LITERAL-OPERAND arm (the case that folds
// even on SwiftShader), so the two failure modes are distinguishable. The
// acceptance criterion is RESEARCH §7's, verbatim: a REQUIRED-NONZERO low
// component AND that it changes the result versus a naive float32 computation on
// the same operands. A value that "looks plausible" after the expansion collapsed
// fails that test.
//
// IMPLEMENTATION. A value is carried EXACTLY as a sign-magnitude 128-bit
// fixed-point integer M with value = sign * M * 2^-96, 96 fractional bits. A
// float32 is decoded with `floatBitsToUint` into a 24-bit significand and an
// exponent (mant * 2^(ex-24)); a 24x24 product is taken by 12-bit schoolbook
// integer multiplication (48 bits, no loss) and placed at its exponent; addition
// is a plain 128-bit integer add; the result is renormalised back to a `(hi, lo)`
// float32 pair by truncation to the top 24 bits and the next 24 bits. Nothing in
// that path is a float rounding event, so nothing can be reassociated away. This
// is a STANDALONE proof of the mechanism: it is not the shipped renderer and not
// wired into the ladder.
//
// LIMITS, stated rather than discovered: 128 fixed-point bits give 96 fractional
// bits and ~32 integer bits, so operands must be O(1) — ours are. No subnormal or
// exponent-range handling beyond that, and no third component, because a 48-bit
// significand is what double-single means. The classic float transforms stay in
// the report above; this section does not replace them.
// ---------------------------------------------------------------------------

// The operands. All are exactly representable in float32, so the literal arm and
// the uniform arm carry the SAME numbers and any difference is codegen, not input.
const IC_B = Math.pow(2, -25);
const IC_B2 = Math.pow(2, -45);
const IC_C = 1 + Math.pow(2, -12);
const IC_Z = -0.75;
const IC_S = 1.0;
const IC_D = 0.25;
const IC_WIDTH = 16;
// Expected |low| magnitudes, used only to scale the informational readout byte to
// roughly mid-range. They are not thresholds: the nonzero/change flags come from
// the shader's own exact comparisons, never from a decoded byte.
const IC_LO_SCALE = [23, 38, 25]; // T0 ~2^-24, T1 ~2^-39, T2 ~2^-26
const IC_LITERALS = {
  u_b: '2.98023223876953125e-8', // 2^-25
  u_b2: '2.842170943040401e-14', // 2^-45
  u_c: '1.000244140625', // 1 + 2^-12
  u_z: '-0.75',
  u_s: '1.0',
  u_d: '0.25',
};

function icFrag(runtime) {
  const B = runtime ? 'u_b' : IC_LITERALS.u_b;
  const B2 = runtime ? 'u_b2' : IC_LITERALS.u_b2;
  const C = runtime ? 'u_c' : IC_LITERALS.u_c;
  const Z = runtime ? 'u_z' : IC_LITERALS.u_z;
  const S = runtime ? 'u_s' : IC_LITERALS.u_s;
  const D = runtime ? 'u_d' : IC_LITERALS.u_d;
  // Probe layout (viewport IC_WIDTH x 1), one pixel pair per transform:
  //   p=2t   flags: (lowNonZero?255:0, changesResult?255:0, 255 marker)
  //   p=2t+1 values: (scaled |lo|, scaled |hi-naive|)
  //   p=15   sentinel (255,255,255) so a broken readback is distinguishable.
  return `#version 300 es
precision highp float;
precision highp int;
uniform float u_b;
uniform float u_b2;
uniform float u_c;
uniform float u_z;
uniform float u_s;
uniform float u_d;
out vec4 fragColor;

struct Big { uvec4 m; int s; };

uint pick4(uvec4 v, int i) {
  if (i == 0) return v.x;
  if (i == 1) return v.y;
  if (i == 2) return v.z;
  return v.w;
}

uvec4 add128(uvec4 a, uvec4 b) {
  uint r0 = a.x + b.x;
  uint c = (r0 < a.x) ? 1u : 0u;
  uint t1 = a.y + b.y;
  uint c1 = (t1 < a.y) ? 1u : 0u;
  uint r1 = t1 + c;
  uint c1b = (r1 < t1) ? 1u : 0u;
  uint t2 = a.z + b.z;
  uint c2 = (t2 < a.z) ? 1u : 0u;
  uint r2 = t2 + c1 + c1b;
  uint c2b = (r2 < t2) ? 1u : 0u;
  uint t3 = a.w + b.w;
  uint c3 = (t3 < a.w) ? 1u : 0u;
  uint r3 = t3 + c2 + c2b;
  return uvec4(r0, r1, r2, r3);
}

uvec4 sub128(uvec4 a, uvec4 b) {
  uint r0 = a.x - b.x;
  uint bw = (a.x < b.x) ? 1u : 0u;
  uint t1 = a.y - b.y;
  uint b1 = (a.y < b.y) ? 1u : 0u;
  uint r1 = t1 - bw;
  uint b1b = (t1 < bw) ? 1u : 0u;
  uint t2 = a.z - b.z;
  uint b2 = (a.z < b.z) ? 1u : 0u;
  uint r2 = t2 - b1 - b1b;
  uint b2b = (t2 < b1 + b1b) ? 1u : 0u;
  uint t3 = a.w - b.w;
  uint b3 = (a.w < b.w) ? 1u : 0u;
  uint r3 = t3 - b2 - b2b;
  return uvec4(r0, r1, r2, r3);
}

int cmp128(uvec4 a, uvec4 b) {
  if (a.w != b.w) return (a.w > b.w) ? 1 : -1;
  if (a.z != b.z) return (a.z > b.z) ? 1 : -1;
  if (a.y != b.y) return (a.y > b.y) ? 1 : -1;
  if (a.x != b.x) return (a.x > b.x) ? 1 : -1;
  return 0;
}

uvec4 shl128(uvec4 v, int s) {
  if (s <= 0) return v;
  if (s >= 128) return uvec4(0u);
  int w = s >> 5;
  int b = s & 31;
  int shb = (32 - b) & 31;
  uvec4 o = uvec4(0u);
  for (int i = 0; i < 4; i++) {
    int j = i - w;
    uint lo = 0u;
    if (j >= 0 && j <= 3) lo = pick4(v, j) << b;
    int jm = j - 1;
    uint hi = 0u;
    if (b != 0 && jm >= 0 && jm <= 3) hi = pick4(v, jm) >> shb;
    uint r = lo | hi;
    if (i == 0) o.x = r; else if (i == 1) o.y = r; else if (i == 2) o.z = r; else o.w = r;
  }
  return o;
}

uvec4 shr128(uvec4 v, int s) {
  if (s <= 0) return v;
  if (s >= 128) return uvec4(0u);
  int w = s >> 5;
  int b = s & 31;
  int shb = (32 - b) & 31;
  uvec4 o = uvec4(0u);
  for (int i = 0; i < 4; i++) {
    int j = i + w;
    uint lo = 0u;
    if (j <= 3) lo = pick4(v, j) >> b;
    int jm = j + 1;
    uint hi = 0u;
    if (b != 0 && jm <= 3) hi = pick4(v, jm) << shb;
    uint r = lo | hi;
    if (i == 0) o.x = r; else if (i == 1) o.y = r; else if (i == 2) o.z = r; else o.w = r;
  }
  return o;
}

int topBit_impl(uint v) {
  if (v == 0u) return -1;
  int r = 0;
  if (v > 0xFFFFu) { r += 16; v >>= 16; }
  if (v > 0xFFu)   { r += 8;  v >>= 8; }
  if (v > 0xFu)    { r += 4;  v >>= 4; }
  if (v > 0x3u)    { r += 2;  v >>= 2; }
  if (v > 0x1u)    { r += 1; }
  return r;
}

int topBit(uvec4 v) {
  if (v.w != 0u) return 96 + topBit_impl(v.w);
  if (v.z != 0u) return 64 + topBit_impl(v.z);
  if (v.y != 0u) return 32 + topBit_impl(v.y);
  if (v.x != 0u) return topBit_impl(v.x);
  return -1;
}

// GLSL ES 3.00 as ANGLE exposes it has NO findMSB/frexp/ldexp/umulExtended
// (measured on this host; CLASSIC vendors may differ), so every one of those is
// built here from bitwise operators and floatBitsToUint, which ARE core.
float pow2i(int e) {
  return uintBitsToFloat(uint(e + 127) << 23);
}

void unpack(float a, out uint mant, out int ex, out int sgn) {
  uint bits = floatBitsToUint(a);
  uint be = (bits >> 23) & 0xFFu;
  if (be == 0u) { mant = 0u; ex = 0; sgn = 0; return; } // zero or subnormal: not used
  sgn = ((bits >> 31) != 0u) ? -1 : 1;
  mant = (bits & 0x7FFFFFu) | 0x800000u; // 24-bit significand, implicit leading 1
  ex = int(be) - 126;                    // value = mant * 2^(ex - 24)
}

// Exact 32x24 -> 56-bit product via 12-bit schoolbook limbs. Every multiplicand
// here is a 24-bit significand or a 32-bit fixed-point limb, and every partial
// product is < 2^24, so no intermediate can lose a bit or overflow a uint.
void mul32x24(uint a, uint b, out uint hi, out uint lo) {
  uint a0 = a & 0xFFFu; uint a1 = (a >> 12) & 0xFFFu; uint a2 = (a >> 24) & 0xFFu;
  uint b0 = b & 0xFFFu; uint b1 = b >> 12;
  uint c0 = a0 * b0;
  uint c1 = a0 * b1 + a1 * b0;
  uint c2 = a1 * b1 + a2 * b0;
  uint c3 = a2 * b1;
  uint c4 = 0u;
  c1 += c0 >> 12; c0 &= 0xFFFu;
  c2 += c1 >> 12; c1 &= 0xFFFu;
  c3 += c2 >> 12; c2 &= 0xFFFu;
  c4 += c3 >> 12; c3 &= 0xFFFu;
  lo = c0 | (c1 << 12) | ((c2 & 0xFFu) << 24);
  hi = (c2 >> 8) | (c3 << 4) | (c4 << 16);
}

Big fromF32(float a) {
  uint mant; int ex; int sgn;
  unpack(a, mant, ex, sgn);
  if (mant == 0u) return Big(uvec4(0u), 0);
  return Big(shl128(uvec4(mant, 0u, 0u, 0u), ex + 72), sgn);
}

Big sAdd(Big a, Big b) {
  if (a.s == 0) return b;
  if (b.s == 0) return a;
  if (a.s == b.s) return Big(add128(a.m, b.m), a.s);
  int c = cmp128(a.m, b.m);
  if (c == 0) return Big(uvec4(0u), 0);
  if (c > 0) return Big(sub128(a.m, b.m), a.s);
  return Big(sub128(b.m, a.m), b.s);
}

Big putProduct(Big acc, uint ma, int exa, int sa, uint mb, int exb, int sb, int extra) {
  if (ma == 0u || mb == 0u) return acc;
  uint l; uint h;
  mul32x24(ma, mb, h, l);
  uvec4 term = uvec4(l, h, 0u, 0u);
  int sh = exa + exb + 48 + extra;
  uvec4 placed = (sh >= 0) ? shl128(term, sh) : shr128(term, -sh);
  return sAdd(acc, Big(placed, sa * sb));
}

Big mulBigF32(Big v, float f) {
  if (v.s == 0) return Big(uvec4(0u), 0);
  uint mant; int ex; int sgn;
  unpack(f, mant, ex, sgn);
  if (mant == 0u) return Big(uvec4(0u), 0);
  uint l0, h0, l1, h1, l2, h2, l3, h3;
  mul32x24(v.m.x, mant, h0, l0);
  mul32x24(v.m.y, mant, h1, l1);
  mul32x24(v.m.z, mant, h2, l2);
  mul32x24(v.m.w, mant, h3, l3);
  uint P0 = l0;
  uint P1 = h0 + l1;
  uint k1 = (P1 < h0) ? 1u : 0u;
  uint P2t = h1 + l2;
  uint k2 = (P2t < h1) ? 1u : 0u;
  uint P2 = P2t + k1;
  uint k2b = (P2 < P2t) ? 1u : 0u;
  uint k2c = k2 + k2b;
  uint P3t = h2 + l3;
  uint k3 = (P3t < h2) ? 1u : 0u;
  uint P3 = P3t + k2c;
  uint k3b = (P3 < P3t) ? 1u : 0u;
  uint P4 = h3 + k3 + k3b;
  int s = 24 - ex;
  uvec4 m;
  if (s <= 0) {
    m = shl128(uvec4(P0, P1, P2, P3), -s);
  } else {
    int w = s >> 5;
    int b = s & 31;
    int shb = (32 - b) & 31;
    uvec4 o = uvec4(0u);
    for (int i = 0; i < 4; i++) {
      int j = i + w;
      uint a = 0u;
      if (j == 0) a = P0; else if (j == 1) a = P1; else if (j == 2) a = P2; else if (j == 3) a = P3; else if (j == 4) a = P4;
      uint lo = a >> b;
      int jm = j + 1;
      uint an = 0u;
      if (jm == 0) an = P0; else if (jm == 1) an = P1; else if (jm == 2) an = P2; else if (jm == 3) an = P3; else if (jm == 4) an = P4;
      uint hi = 0u;
      if (b != 0 && jm <= 4) hi = an << shb;
      uint r = lo | hi;
      if (i == 0) o.x = r; else if (i == 1) o.y = r; else if (i == 2) o.z = r; else o.w = r;
    }
    m = o;
  }
  return Big(m, v.s * sgn);
}

void toDS(Big v, out float hi, out float lo) {
  if (v.s == 0) { hi = 0.0; lo = 0.0; return; }
  int L = topBit(v.m);
  if (L < 48) {
    hi = float(v.m.x) * pow2i(-96) * float(v.s);
    lo = 0.0;
    return;
  }
  uint H = shr128(v.m, L - 23).x & 0xFFFFFFu;
  uint Lo = shr128(v.m, L - 47).x & 0xFFFFFFu;
  hi = float(H) * pow2i(L - 23 - 96) * float(v.s);
  lo = float(Lo) * pow2i(L - 47 - 96) * float(v.s);
}

Big exactSum() {
  Big acc = fromF32(1.0);
  for (int i = 0; i < 64; i++) acc = sAdd(acc, fromF32(${B}));
  for (int i = 0; i < 64; i++) acc = sAdd(acc, fromF32(${B2}));
  return acc;
}

void main() {
  int p = int(gl_FragCoord.x);
  float r = 0.0, g = 0.0, b = 0.0;
  if (p == 0 || p == 1) {
    uint mc; int ec; int sc;
    unpack(${C}, mc, ec, sc);
    Big acc = putProduct(Big(uvec4(0u), 0), mc, ec, sc, mc, ec, sc, 0);
    float hi, lo; toDS(acc, hi, lo);
    float naive = ${C} * ${C};
    if (p == 0) {
      r = (lo != 0.0) ? 1.0 : 0.0;
      g = ((hi != naive) || (lo != 0.0)) ? 1.0 : 0.0;
      b = 1.0;
    } else {
      r = min(1.0, abs(lo) * 8388608.0);
      g = min(1.0, abs(hi - naive) * 8388608.0);
    }
  } else if (p == 2 || p == 3) {
    Big acc = exactSum();
    float hi, lo; toDS(acc, hi, lo);
    float naive = 1.0;
    for (int i = 0; i < 64; i++) naive += ${B};
    for (int i = 0; i < 64; i++) naive += ${B2};
    if (p == 2) {
      r = (lo != 0.0) ? 1.0 : 0.0;
      g = ((hi != naive) || (lo != 0.0)) ? 1.0 : 0.0;
      b = 1.0;
    } else {
      r = min(1.0, abs(lo) * 274877906944.0);
      g = min(1.0, abs(hi - naive) * 274877906944.0);
    }
  } else if (p == 4 || p == 5) {
    Big accW = exactSum();
    float whi, wlo; toDS(accW, whi, wlo);
    uint mwh; int ewh; int swh;
    uint mwl; int ewl; int swl;
    unpack(whi, mwh, ewh, swh);
    unpack(wlo, mwl, ewl, swl);
    float twoZ = 2.0 * ${Z};
    Big acc = Big(uvec4(0u), 0);
    acc = sAdd(acc, mulBigF32(fromF32(whi), twoZ));
    acc = sAdd(acc, mulBigF32(fromF32(wlo), twoZ));
    Big w2 = Big(uvec4(0u), 0);
    w2 = putProduct(w2, mwh, ewh, swh, mwh, ewh, swh, 0);
    w2 = putProduct(w2, mwh, ewh, swh, mwl, ewl, swl, 1);
    w2 = putProduct(w2, mwl, ewl, swl, mwl, ewl, swl, 0);
    acc = sAdd(acc, mulBigF32(w2, ${S}));
    acc = sAdd(acc, fromF32(${D}));
    float hi, lo; toDS(acc, hi, lo);
    float wN = whi + wlo;
    float naive = 2.0 * ${Z} * wN + ${S} * wN * wN + ${D};
    if (p == 4) {
      r = (lo != 0.0) ? 1.0 : 0.0;
      g = ((hi != naive) || (lo != 0.0)) ? 1.0 : 0.0;
      b = 1.0;
    } else {
      r = min(1.0, abs(lo) * 33554432.0);
      g = min(1.0, abs(hi - naive) * 33554432.0);
    }
  } else if (p == 15) {
    r = 1.0; g = 1.0; b = 1.0;
  }
  fragColor = vec4(r, g, b, 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Identity and feature gates (our own context).
// ---------------------------------------------------------------------------

function glIdentity(probe) {
  const gl = probe.gl;
  if (!gl) return { ok: false, reason: 'no WebGL1 context on a detached canvas' };
  const out = { ok: true };
  out.webglVersion = gl.getParameter(gl.VERSION);
  out.webglVendor = gl.getParameter(gl.VENDOR);
  out.maskedRenderer = gl.getParameter(gl.RENDERER);
  let dbg = null;
  try { dbg = gl.getExtension('WEBGL_debug_renderer_info'); } catch (_) { dbg = null; }
  out.unmaskedVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
  out.unmaskedRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
  return out;
}

// A WebGL2 context, created only to prove the api exists and to read its version,
// then released. It is NOT used for any measurement (the app's lanes are WebGL1).
function webgl2Info() {
  const probe2 = createGL('webgl2', 8, 8);
  if (!probe2.gl) return { available: false, version: null };
  const version = probe2.gl.getParameter(probe2.gl.VERSION);
  try {
    const lose = probe2.gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  } catch (_) { /* best effort */ }
  return { available: true, version: version };
}

const SOFTWARE_HINTS = ['swiftshader', 'llvmpipe', 'softpipe', 'software', 'microsoft basic render', 'mesa offscreen'];
const HARDWARE_HINTS = ['nvidia', 'amd', 'radeon', 'intel', 'apple', 'adreno', 'mali', 'powervr', 'qualcomm', 'angle', 'arc '];

function classifyRenderer(name) {
  if (!name) return 'UNKNOWN';
  const lower = String(name).toLowerCase();
  for (const hint of SOFTWARE_HINTS) {
    if (lower.indexOf(hint) !== -1) return 'SOFTWARE';
  }
  for (const hint of HARDWARE_HINTS) {
    if (lower.indexOf(hint) !== -1) return 'HARDWARE';
  }
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Is a float texture actually sampleable? (the deep lane depends on it)
// ---------------------------------------------------------------------------

const FLOAT_TEX_VALUES = [0.25, 0.5, 0.75, 1.0];
const FLOAT_TEX_EXPECTED = FLOAT_TEX_VALUES.map((v) => Math.round(v * 255));

function floatTextureProbe(probe) {
  const gl = probe.gl;
  const ext = gl.getExtension('OES_texture_float');
  if (!ext) return { status: 'SKIP', reason: 'OES_texture_float is absent' };

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(FLOAT_TEX_VALUES));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const uploadError = gl.getError();
  if (uploadError !== gl.NO_ERROR) {
    return { status: 'FAIL', reason: 'texImage2D(FLOAT) raised gl error 0x' + uploadError.toString(16) };
  }

  const program = compileProgram(gl, FLOAT_TEX_FRAG);
  gl.useProgram(program);
  fullscreenQuad(gl, program);
  gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.viewport(0, 0, 1, 1);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const px = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const readError = gl.getError();
  if (readError !== gl.NO_ERROR) {
    return { status: 'FAIL', reason: 'readPixels raised gl error 0x' + readError.toString(16) };
  }

  const read = [px[0], px[1], px[2]];
  const maxDelta = Math.max(
    Math.abs(read[0] - FLOAT_TEX_EXPECTED[0]),
    Math.abs(read[1] - FLOAT_TEX_EXPECTED[1]),
    Math.abs(read[2] - FLOAT_TEX_EXPECTED[2]),
  );
  const allZero = read[0] === 0 && read[1] === 0 && read[2] === 0;
  const value = 'wrote=[' + FLOAT_TEX_VALUES.join(',') + '] read=[' + read.join(',')
    + '] expected=[' + FLOAT_TEX_EXPECTED.join(',') + '] maxDelta=' + maxDelta;
  if (allZero && FLOAT_TEX_EXPECTED[0] > 0) {
    return { status: 'FAIL', reason: 'sampled float texture read back ALL ZERO (' + value + ')', value: value };
  }
  if (maxDelta > 3) {
    return { status: 'FAIL', reason: 'sampled values differ from the written values (' + value + ')', value: value };
  }
  return { status: 'OK', value: value + ' -> SAMPLES' };
}

// ---------------------------------------------------------------------------
// The double-single residual (the load-bearing test).
// ---------------------------------------------------------------------------

function doubleSingleProbe(probe) {
  const gl = probe.gl;
  const high = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const medium = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
  const precision = {
    highp: high ? high.precision : -1,
    highpRange: high ? high.rangeMax : -1,
    mediump: medium ? medium.precision : -1,
  };

  const program = compileProgram(gl, DS_FRAG);
  gl.useProgram(program);
  fullscreenQuad(gl, program);
  gl.uniform1f(gl.getUniformLocation(program, 'u_b'), DS_SMALL);
  gl.uniform1f(gl.getUniformLocation(program, 'u_c'), DS_SPLIT);
  gl.uniform1f(gl.getUniformLocation(program, 'u_d'), DS_SPLIT);
  gl.viewport(0, 0, 4, 1);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const px = new Uint8Array(4 * 4);
  gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const readError = gl.getError();

  const at = (probeIndex, channel) => px[probeIndex * 4 + channel];
  const sentinelOk = at(3, 0) > 250 && at(3, 1) > 250 && at(3, 2) > 250;

  return {
    precision: precision,
    readError: readError,
    sentinelOk: sentinelOk,
    sentinelBytes: [at(3, 0), at(3, 1), at(3, 2)],
    // probe 0 — TwoSum low component of (1, 2^-25).
    lowByte: at(0, 0),
    lowNonZero: at(0, 0) > 5,
    lowValue: (at(0, 0) / 255) * Math.pow(2, -25),
    // probe 1 — does the accumulated low term change the final result?
    lowChangesResult: at(1, 2) > 127,
    naive: at(1, 1) / 255,
    compensated: 1 + (at(1, 0) / 255) * Math.pow(2, -19),
    // probe 2 — Dekker TwoProd residual of (1+2^-12)^2.
    prodByte: at(2, 0),
    prodNonZero: at(2, 0) > 5,
    prodLow: (at(2, 0) / 255) * Math.pow(2, -24),
  };
}

// ---------------------------------------------------------------------------
// The integer-controlled probe (runs on a WebGL2 / GLSL ES 3.00 context).
// ---------------------------------------------------------------------------

function icUnpackArm(gl, program) {
  gl.useProgram(program);
  const loc = (name) => gl.getUniformLocation(program, name);
  gl.uniform1f(loc('u_b'), IC_B);
  gl.uniform1f(loc('u_b2'), IC_B2);
  gl.uniform1f(loc('u_c'), IC_C);
  gl.uniform1f(loc('u_z'), IC_Z);
  gl.uniform1f(loc('u_s'), IC_S);
  gl.uniform1f(loc('u_d'), IC_D);
  fullscreenQuad(gl, program);
  gl.viewport(0, 0, IC_WIDTH, 1);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const px = new Uint8Array(IC_WIDTH * 4);
  gl.readPixels(0, 0, IC_WIDTH, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const readError = gl.getError();
  const arms = [];
  for (let t = 0; t < 3; t++) {
    const fb = (t * 2) * 4;
    const vb = (t * 2 + 1) * 4;
    arms.push({
      loNonZero: px[fb] > 127,
      changes: px[fb + 1] > 127,
      marker: px[fb + 2] > 127,
      loValue: (px[vb] / 255) * Math.pow(2, -IC_LO_SCALE[t]),
      diffValue: (px[vb + 1] / 255) * Math.pow(2, -IC_LO_SCALE[t]),
    });
  }
  const sb = 15 * 4;
  return {
    arms: arms,
    readError: readError,
    sentinel: [px[sb], px[sb + 1], px[sb + 2]],
  };
}

function integerControlledProbe(probe2) {
  const gl = probe2.gl;
  const highInt = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_INT);
  let renderer = gl.getParameter(gl.RENDERER);
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  } catch (_) { /* masked name is still a name */ }
  // `getSupportedExtensions` reports availability WITHOUT enabling the extension
  // (requesting WEBGL_debug_shader_precision would itself change codegen, so it is
  // never requested here).
  let supported = [];
  try { supported = gl.getSupportedExtensions() || []; } catch (_) { supported = []; }
  const variant = {
    glVersion: gl.getParameter(gl.VERSION),
    slVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    renderer: renderer,
    // Integer precision is reported by RANGE (the exponent bound), not by a bit
    // count: `precision` is 0 for integer formats, so quoting it would read as
    // "0 bits". rangeMax 31 means a signed 32-bit integer, which is what the
    // fixed-point path needs.
    intRange: highInt ? (highInt.rangeMin + '..' + highInt.rangeMax) : 'n/a',
    // In WebGL2 the derivative functions are core in GLSL ES 3.00.
    derivatives: 'core(ES3.00)',
    shaderPrecisionDebug: (supported.indexOf('WEBGL_debug_shader_precision') !== -1) ? 'available(not-requested)' : 'absent',
    // There is no WebGL API that reports a fast-math flag; say so rather than guess.
    fastMath: 'not-queryable(no WebGL API)',
  };

  const runtime = icUnpackArm(gl, compileProgram(gl, icFrag(true), VERT_SRC_300));
  const literal = icUnpackArm(gl, compileProgram(gl, icFrag(false), VERT_SRC_300));
  return { variant: variant, runtime: runtime, literal: literal };
}

// ---------------------------------------------------------------------------
// The deep lane, against an independent in-page reference.
// ---------------------------------------------------------------------------

// The float64 absolute recurrence, the same expression the CPU kernel iterates.
// `iter + 1` matches the shader's own diagnostic escape index (n = iter + 1;
// n = cap + 1 means inside).
function refIterFloat64(cx, cy, cap) {
  let x = 0, y = 0, iter = 0;
  while (iter < cap) {
    const nx = x * x - y * y + cx;
    y = 2 * x * y + cy;
    x = nx;
    if (x * x + y * y > 4) break;
    iter++;
  }
  return iter + 1;
}

function parseDec(str, F) {
  let s = String(str).trim();
  let sign = 1n;
  if (s[0] === '-') { sign = -1n; s = s.slice(1); }
  const p = s.split(/[eE]/);
  const exp = p[1] ? parseInt(p[1], 10) : 0;
  const dot = p[0].indexOf('.');
  const ip = dot < 0 ? p[0] : p[0].slice(0, dot);
  const fp = dot < 0 ? '' : p[0].slice(dot + 1);
  const D = BigInt((ip || '0') + fp);
  const e10 = exp - fp.length;
  let num = D * (1n << BigInt(F));
  let den = 1n;
  if (e10 >= 0) num *= 10n ** BigInt(e10); else den = 10n ** BigInt(-e10);
  return sign * ((num + den / 2n) / den);
}

function makeMul(F) {
  const half = 1n << BigInt(F - 1);
  return (a, b) => {
    const v = a * b;
    return v >= 0n ? (v + half) >> BigInt(F) : -(((-v) + half) >> BigInt(F));
  };
}

function sampleGrid(w, h, targetPoints) {
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / targetPoints)));
  const xs = [];
  const ys = [];
  for (let i = 0; i < w; i += step) xs.push(i);
  for (let j = 0; j < h; j += step) ys.push(j);
  return { xs: xs, ys: ys, step: step };
}

// A frame's readback is plausible if its escape indices vary and stay in range.
function framePlausibility(frame) {
  if (!frame || !frame.n || frame.n.length === 0) return { ok: false, reason: 'no frame' };
  let min = Infinity, max = -Infinity;
  const distinct = new Set();
  const limit = Math.min(frame.n.length, 200000);
  for (let k = 0; k < limit; k++) {
    const v = frame.n[k];
    if (v < min) min = v;
    if (v > max) max = v;
    if (distinct.size < 64) distinct.add(v);
  }
  return { ok: true, min: min, max: max, distinct: distinct.size, sampled: limit };
}

// ---------------------------------------------------------------------------
// Report building.
// ---------------------------------------------------------------------------

function buildReport(items, summary, errors) {
  const counts = { ok: 0, skip: 0, fail: 0 };
  for (const it of items) {
    if (it.status === 'SKIP') counts.skip++;
    else if (it.status === 'FAIL') counts.fail++;
    else counts.ok++;
  }
  const lines = [];
  lines.push(HEADER);
  lines.push('SUMMARY: ' + clean(summary));
  const sections = [];
  for (const it of items) {
    let section = sections[sections.length - 1];
    if (!section || section.title !== it.section) {
      section = { title: it.section, items: [] };
      sections.push(section);
    }
    section.items.push(it);
  }
  for (const section of sections) {
    lines.push('--- ' + section.title + ' ---');
    for (const it of section.items) {
      lines.push('  ' + it.id + ': ' + clean(it.value));
    }
  }
  lines.push('===== END: ' + counts.ok + ' OK, ' + counts.skip + ' SKIP, ' + counts.fail + ' FAIL =====');
  if (errors && errors.length) {
    for (const e of errors) lines.push('BATTERY-ERROR: ' + clean(e));
  }
  return {
    id: REPORT_ID,
    header: HEADER,
    summary: clean(summary),
    lines: lines,
    text: lines.join('\n'),
    items: items,
    counts: counts,
    errors: errors || [],
  };
}

// The battery emits a FIXED set of item ids on every path. A phase that cannot
// run marks its items SKIP/FAIL; it never drops them, because a missing item would
// silently cost the owner information.
const DEEP_IDS = ['deep_view', 'deep_ref_float64', 'deep_ref_bigint', 'app_readback', 'cost_1e-4', 'cost_1e-6', 'cost_1e-8'];

async function runBattery() {
  if (running) return null;
  running = true;
  try {
    const items = [];
    const errors = [];
    const push = (section, id, status, value) => items.push({ section: section, id: id, status: status, value: value });
    const ok = (section, id, value) => push(section, id, 'OK', value);
    const skip = (section, id, reason) => push(section, id, 'SKIP', 'SKIP (' + clean(reason) + ')');
    const fail = (section, id, reason) => push(section, id, 'FAIL', 'FAIL (' + clean(reason) + ')');

    // --- probe context -------------------------------------------------------
    const probe = createGL('webgl', 64, 64);
    const probeError = probe.gl ? probe.gl.getError() : null;

    let identity = null;
    try { identity = glIdentity(probe); } catch (err) { errors.push('identity: ' + errText(err)); }
    const rendererName = (identity && (identity.unmaskedRenderer || identity.maskedRenderer)) || null;
    const kind = classifyRenderer(rendererName);

    // --- IDENTITY ------------------------------------------------------------
    try {
      ok('IDENTITY', 'ua', (typeof navigator !== 'undefined' && navigator.userAgent) || 'unavailable');
    } catch (err) { fail('IDENTITY', 'ua', 'threw: ' + errText(err)); }

    if (!identity || !identity.ok) {
      const reason = identity ? identity.reason : 'no WebGL1 context';
      skip('IDENTITY', 'gl_vendor', reason);
      skip('IDENTITY', 'gl_renderer', reason);
      skip('IDENTITY', 'gl_version', reason);
    } else {
      if (identity.unmaskedVendor) ok('IDENTITY', 'gl_vendor', identity.unmaskedVendor + ' (UNMASKED_VENDOR_WEBGL)');
      else skip('IDENTITY', 'gl_vendor', 'WEBGL_debug_renderer_info absent; masked VENDOR=' + identity.webglVendor);
      if (identity.unmaskedRenderer) ok('IDENTITY', 'gl_renderer', identity.unmaskedRenderer + ' (UNMASKED_RENDERER_WEBGL) kind=' + kind);
      else skip('IDENTITY', 'gl_renderer', 'WEBGL_debug_renderer_info absent; masked RENDERER=' + identity.maskedRenderer);
      ok('IDENTITY', 'gl_version', identity.webglVersion);
    }
    try {
      const w2 = webgl2Info();
      if (w2.available) ok('IDENTITY', 'webgl2', 'available: ' + w2.version);
      else skip('IDENTITY', 'webgl2', 'no WebGL2 context');
    } catch (err) { fail('IDENTITY', 'webgl2', 'threw: ' + errText(err)); }

    // --- FEATURE GATES -------------------------------------------------------
    let floatTex = { status: 'SKIP', reason: 'no probe WebGL1 context' };
    if (probe.gl) {
      const gl = probe.gl;
      let ext = null;
      try { ext = gl.getExtension('OES_texture_float'); } catch (err) { errors.push('OES_texture_float: ' + errText(err)); }
      if (ext) ok('FEATURE GATES', 'oes_texture_float', 'present'); else skip('FEATURE GATES', 'oes_texture_float', 'absent');
      let linear = null;
      try { linear = gl.getExtension('OES_texture_float_linear'); } catch (err) { errors.push('OES_texture_float_linear: ' + errText(err)); }
      if (linear) ok('FEATURE GATES', 'oes_texture_float_linear', 'present'); else skip('FEATURE GATES', 'oes_texture_float_linear', 'absent (NEAREST only)');
      let maxTex = 0, maxVtu = 0;
      try { maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE); } catch (_) { maxTex = 0; }
      try { maxVtu = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS); } catch (_) { maxVtu = 0; }
      ok('FEATURE GATES', 'max_texture_size', maxTex + ' px (MAX_TEXTURE_SIZE)');
      ok('FEATURE GATES', 'max_vertex_texture_units', maxVtu + ' texture units (MAX_VERTEX_TEXTURE_IMAGE_UNITS)');
      try { floatTex = floatTextureProbe(probe); } catch (err) { floatTex = { status: 'FAIL', reason: 'threw: ' + errText(err) }; }
      if (floatTex.status === 'OK') ok('FEATURE GATES', 'float_texture_sampleable', floatTex.value);
      else if (floatTex.status === 'SKIP') skip('FEATURE GATES', 'float_texture_sampleable', floatTex.reason);
      else fail('FEATURE GATES', 'float_texture_sampleable', floatTex.reason);
    } else {
      for (const id of ['oes_texture_float', 'oes_texture_float_linear', 'max_texture_size', 'max_vertex_texture_units', 'float_texture_sampleable']) {
        skip('FEATURE GATES', id, 'no probe WebGL1 context');
      }
    }

    // --- DOUBLE-SINGLE RESIDUAL ----------------------------------------------
    let ds = null;
    if (probe.gl) {
      try { ds = doubleSingleProbe(probe); } catch (err) { ds = { status: 'FAIL', reason: 'threw: ' + errText(err) }; }
    }
    if (!ds) {
      for (const id of ['ds_precision', 'ds_readback', 'ds_low_component', 'ds_low_changes_result', 'ds_twoprod_low']) {
        skip('DOUBLE-SINGLE RESIDUAL', id, 'no probe WebGL1 context');
      }
    } else if (ds.status === 'FAIL') {
      fail('DOUBLE-SINGLE RESIDUAL', 'ds_precision', ds.reason);
      for (const id of ['ds_readback', 'ds_low_component', 'ds_low_changes_result', 'ds_twoprod_low']) {
        skip('DOUBLE-SINGLE RESIDUAL', id, 'the standalone test shader did not run');
      }
    } else {
      ok('DOUBLE-SINGLE RESIDUAL', 'ds_precision',
        'highp=' + ds.precision.highp + ' bits (rangeMax=' + ds.precision.highpRange + '), mediump=' + ds.precision.mediump + ' bits'
        + (ds.precision.highp >= 23 ? '' : ' -> WARNING: fragment highp is not 24-bit'));
      if (ds.readError !== 0) {
        fail('DOUBLE-SINGLE RESIDUAL', 'ds_readback', 'readPixels after the probe raised gl error 0x' + ds.readError.toString(16));
      } else if (!ds.sentinelOk) {
        fail('DOUBLE-SINGLE RESIDUAL', 'ds_readback', 'probe sentinel read [' + ds.sentinelBytes.join(',') + '] (expected ~[255,255,255]); the readback mapping is broken, so the residual items are not trustworthy');
      } else {
        ok('DOUBLE-SINGLE RESIDUAL', 'ds_readback', 'sentinel=[' + ds.sentinelBytes.join(',') + '] -> readback mapping OK');
      }
      if (!ds.sentinelOk) {
        skip('DOUBLE-SINGLE RESIDUAL', 'ds_low_component', 'readback mapping broken');
        skip('DOUBLE-SINGLE RESIDUAL', 'ds_low_changes_result', 'readback mapping broken');
        skip('DOUBLE-SINGLE RESIDUAL', 'ds_twoprod_low', 'readback mapping broken');
      } else {
        const lowText = 'TwoSum(1, 2^-25).lo=' + fmtExp(ds.lowValue) + ' (rawByte=' + ds.lowByte + ') -> ' + (ds.lowNonZero ? 'NONZERO' : 'ZERO');
        if (ds.lowNonZero) ok('DOUBLE-SINGLE RESIDUAL', 'ds_low_component', lowText);
        else fail('DOUBLE-SINGLE RESIDUAL', 'ds_low_component', 'the low component was erased or ignored: ' + lowText);

        const changesText = 'compensated=' + ds.compensated.toFixed(7) + ' naive=' + ds.naive.toFixed(7)
          + ' (64 x 2^-25 into 1.0) -> ' + (ds.lowChangesResult ? 'YES' : 'NO');
        if (ds.lowChangesResult) ok('DOUBLE-SINGLE RESIDUAL', 'ds_low_changes_result', changesText);
        else fail('DOUBLE-SINGLE RESIDUAL', 'ds_low_changes_result', 'the low term did NOT change the result: ' + changesText);

        const prodText = 'TwoProd(1+2^-12, 1+2^-12).lo=' + fmtExp(ds.prodLow) + ' (rawByte=' + ds.prodByte + ') -> ' + (ds.prodNonZero ? 'NONZERO' : 'ZERO');
        if (ds.prodNonZero) ok('DOUBLE-SINGLE RESIDUAL', 'ds_twoprod_low', prodText);
        else fail('DOUBLE-SINGLE RESIDUAL', 'ds_twoprod_low', 'the product residual was erased or ignored: ' + prodText);
      }
    }

    // --- INTEGER-CONTROLLED DOUBLE-SINGLE ------------------------------------
    // The D3D11 answer (DECISIONS 101). Runs on its own WebGL2 context; every
    // failure mode is an explicit item, never a dropped line.
    const IC_IDS = ['ic_variant', 'ic_readback', 'ic_twoprod_low', 'ic_sum_low', 'ic_recurrence_low', 'ic_required_nonzero', 'ic_arm_differential'];
    const IC_SECTION = 'INTEGER-CONTROLLED DS';
    let ic = null;
    let icError = null;
    let icUsable = false;
    const icProbe = createGL('webgl2', IC_WIDTH, 1);
    if (!icProbe.gl) {
      icError = 'no WebGL2 context (GLSL ES 3.00 integer operations unavailable)';
    } else {
      try { ic = integerControlledProbe(icProbe); } catch (err) { icError = errText(err); }
    }
    if (icProbe.gl) {
      try {
        const lose = icProbe.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (_) { /* best effort; the app's context is untouched */ }
    }
    if (!ic) {
      for (const id of IC_IDS) skip(IC_SECTION, id, icError || 'the integer-controlled probe did not run');
    } else {
      const TR_EXPECT = ['TwoProd(1+2^-12,1+2^-12)', '1+64*2^-25+64*2^-45', 'w->2Zw+S w^2+d'];
      const fmtArm = (a) => 'lo=' + (a.loNonZero ? 'NONZERO' : 'ZERO')
        + '(|lo|~' + fmtExp(a.loValue) + ') changesResult=' + (a.changes ? 'YES' : 'NO');
      const active = (a) => (a.loNonZero && a.changes);
      const armActive = (res) => res.arms.map(active);
      const runtimeActive = armActive(ic.runtime);
      const literalActive = armActive(ic.literal);

      const v = ic.variant;
      ok(IC_SECTION, 'ic_variant',
        'ctx=webgl2/GLSL-ES-3.00 gl_version="' + clean(v.glVersion) + '" sl_version="' + clean(v.slVersion)
        + '" renderer="' + clean(v.renderer) + '" highp_int_range=' + v.intRange
        + ' derivatives=' + v.derivatives + ' shader_precision_debug=' + v.shaderPrecisionDebug
        + ' fastmath=' + v.fastMath);

      const sentinelOk = ic.runtime.sentinel[0] > 250 && ic.runtime.sentinel[1] > 250 && ic.runtime.sentinel[2] > 250;
      icUsable = (ic.runtime.readError === 0) && sentinelOk;
      if (ic.runtime.readError !== 0) {
        fail(IC_SECTION, 'ic_readback', 'readPixels raised gl error 0x' + ic.runtime.readError.toString(16));
      } else if (!sentinelOk) {
        fail(IC_SECTION, 'ic_readback', 'probe sentinel read [' + ic.runtime.sentinel.join(',') + '] (expected ~[255,255,255]); the integer probe readback mapping is broken');
      } else {
        ok(IC_SECTION, 'ic_readback', 'viewport=' + IC_WIDTH + 'x1 sentinel=[' + ic.runtime.sentinel.join(',') + '] -> readback mapping OK');
      }

      for (let t = 0; t < 3; t++) {
        const rt = ic.runtime.arms[t];
        const lt = ic.literal.arms[t];
        const id = ['ic_twoprod_low', 'ic_sum_low', 'ic_recurrence_low'][t];
        const value = 'runtime[' + fmtArm(rt) + '] literal[' + fmtArm(lt) + '] expected=' + TR_EXPECT[t];
        if (!icUsable) skip(IC_SECTION, id, 'readback mapping broken');
        else if (rt.loNonZero && rt.changes) ok(IC_SECTION, id, value + ' -> REQUIRED-NONZERO-ACTIVE');
        else if (rt.loNonZero) fail(IC_SECTION, id, 'the low component is nonzero but does NOT change the result: ' + value);
        else fail(IC_SECTION, id, 'the integer-controlled low component was erased: ' + value);
      }

      const rtCount = runtimeActive.filter(Boolean).length;
      const ltCount = literalActive.filter(Boolean).length;
      const reqText = 'runtime ' + rtCount + '/3 (low!=0 AND changes result) literal ' + ltCount + '/3';
      if (!icUsable) {
        skip(IC_SECTION, 'ic_required_nonzero', 'readback mapping broken');
        skip(IC_SECTION, 'ic_arm_differential', 'readback mapping broken');
      } else if (rtCount === 3) {
        ok(IC_SECTION, 'ic_required_nonzero', reqText + ' -> REQUIRED-NONZERO SATISFIED');
      } else {
        fail(IC_SECTION, 'ic_required_nonzero', 'the integer-controlled path did not satisfy REQUIRED-NONZERO: ' + reqText);
      }

      const tag = (arr) => '[' + arr.map((a) => (a ? 'A' : '-')).join('') + ']';
      const armDiffText = 'runtime=' + tag(runtimeActive) + ' literal=' + tag(literalActive)
        + ' (T0/T1/T2; A=active)';
      if (icUsable && rtCount === 3) ok(IC_SECTION, 'ic_arm_differential', armDiffText + ' -> ' + (ltCount === 3 ? 'ARMS-AGREE' : 'LITERAL-ARM-DIFFERS'));
      else if (icUsable && ltCount === 3) fail(IC_SECTION, 'ic_arm_differential', 'the integer path is ACTIVE only with folded LITERAL operands, i.e. it does not survive runtime data: ' + armDiffText);
      else if (icUsable) fail(IC_SECTION, 'ic_arm_differential', 'both arms are inactive: ' + armDiffText);
    }

    // --- DEEP LANE (and COST) ------------------------------------------------
    // Results are collected in a map and emitted in a FIXED order below, so every
    // expected id is present exactly once whatever happens.
    const deep = {};
    const setDeep = (id, status, value) => { deep[id] = { status: status, value: value }; };
    const deepOk = (id, value) => setDeep(id, 'OK', value);
    const deepSkip = (id, reason) => setDeep(id, 'SKIP', 'SKIP (' + clean(reason) + ')');
    const deepFail = (id, reason) => setDeep(id, 'FAIL', 'FAIL (' + clean(reason) + ')');

    const fv = (typeof window !== 'undefined') ? window.__fv : null;
    let savedView = null;
    const deepSources = [];
    let floatFrame = null;
    let bigintFrame = null;

    try {
      if (!fv) {
        for (const id of DEEP_IDS) deepSkip(id, 'window.__fv is absent (the app is not loaded)');
      } else {
        const appReady = await waitFor(() => !!(fv.shaderSource && fv.shaderSource()), 15000, 150);
        if (!appReady) {
          for (const id of DEEP_IDS) deepSkip(id, 'no WebGL renderer after 15s (shaderSource() is still null)');
        } else {
          await waitFor(() => fv.animationSettled && fv.animationSettled(), 20000, 200);
          savedView = fv.getView();

          // (1) float64 deep lane at 1e-6, reference = the CPU's own float64 recurrence.
          try {
            fv.setDeepView({ centerX: FLOAT_DEEP_X, centerY: FLOAT_DEEP_Y, scale: FLOAT_DEEP_SCALE });
            floatFrame = fv.orbitFrame();
            const src = fv.orbitSource();
            deepSources.push(src);
            if (!floatFrame || !floatFrame.n || !floatFrame.n.length) {
              deepSkip('deep_view', 'orbitFrame() returned no frame');
              deepSkip('deep_ref_float64', 'orbitFrame() returned no frame');
            } else {
              const view = fv.getView();
              const cap = floatFrame.cap;
              const w = floatFrame.w, h = floatFrame.h;
              const aspect = w / h;
              const grid = sampleGrid(w, h, 3000);
              let mis = 0, sumAbs = 0, maxAbs = 0, refEscaped = 0, count = 0;
              for (const j of grid.ys) {
                const v = (j + 0.5) / h;
                const cy = view.centerY + ((1 - v) - 0.5) * view.scale;
                for (const i of grid.xs) {
                  const u = (i + 0.5) / w;
                  const cx = view.centerX + (u - 0.5) * view.scale * aspect;
                  const ref = refIterFloat64(cx, cy, cap);
                  const gpu = floatFrame.n[j * w + i];
                  if ((ref > cap) !== (gpu > cap)) mis++;
                  const d = Math.abs(ref - gpu);
                  sumAbs += d;
                  if (d > maxAbs) maxAbs = d;
                  if (ref <= cap) refEscaped++;
                  count++;
                }
              }
              const misPct = (mis / count) * 100;
              const meanAbs = sumAbs / count;
              const value = 'scale=' + FLOAT_DEEP_SCALE + ' src=' + src + ' capIter=' + cap
                + ' sampledPx=' + count + ' refEscaped=' + refEscaped
                + ' misclassified=' + misPct.toFixed(3) + '% mean|dn|=' + meanAbs.toFixed(3) + ' max|dn|=' + maxAbs;
              deepOk('deep_view', 'scale=' + FLOAT_DEEP_SCALE + ' centre=' + FLOAT_DEEP_X + ',' + FLOAT_DEEP_Y + ' lane=' + src);
              if (refEscaped === 0) deepFail('deep_ref_float64', 'the reference frame is degenerate (no escaped pixels): ' + value);
              else if (misPct > 5) deepFail('deep_ref_float64', 'the GPU disagrees with the CPU float64 reference: ' + value);
              else deepOk('deep_ref_float64', value);
            }
          } catch (err) {
            if (!deep.deep_view) deepFail('deep_view', 'threw: ' + errText(err));
            if (!deep.deep_ref_float64) deepFail('deep_ref_float64', 'threw: ' + errText(err));
          }

          // (2) BigInt deep lane at 1e-20, reference = a direct BigInt iteration.
          try {
            fv.setDeepView({
              centerX: BIGINT_X, centerY: BIGINT_Y, scale: BIGINT_SCALE,
              centerXExact: BIGINT_X_EXACT, centerYExact: BIGINT_Y_EXACT,
            });
            const ready = await waitFor(() => {
              const info = fv.bigOrbitInfo();
              return !!(info && info.bits > 0 && String(info.key).indexOf(BIGINT_X_EXACT + '|') === 0);
            }, 20000, 200);
            if (!ready) {
              const reqs = fv.bigOrbitRequests ? fv.bigOrbitRequests() : '?';
              const errs = fv.bigOrbitErrors ? fv.bigOrbitErrors() : '?';
              deepSkip('deep_ref_bigint', 'the BigInt orbit was not uploaded within 20s (src=' + fv.orbitSource() + ' req=' + reqs + ' err=' + errs + ')');
            } else {
              fv.renderWebGL();
              bigintFrame = fv.orbitFrame();
              const src = fv.orbitSource();
              deepSources.push(src);
              const info = fv.bigOrbitInfo();
              const bits = info ? info.bits : fv.bigOrbitBitsForScale(BIGINT_SCALE);
              if (!bigintFrame || !bigintFrame.n || !bigintFrame.n.length) {
                deepSkip('deep_ref_bigint', 'orbitFrame() returned no frame (src=' + src + ')');
              } else if (src !== 'bigint') {
                deepSkip('deep_ref_bigint', 'the deep lane did not engage the BigInt orbit (src=' + src + ')');
              } else {
                const cap = bigintFrame.cap;
                const w = bigintFrame.w, h = bigintFrame.h;
                const aspect = w / h;
                const F = bits + 256;
                const mul = makeMul(F);
                const cxBig = parseDec(BIGINT_X_EXACT, F);
                const cyBig = parseDec(BIGINT_Y_EXACT, F);
                const bail = 4n << BigInt(2 * F);
                const grid = sampleGrid(w, h, 160);
                let mis = 0, sumAbs = 0, maxAbs = 0, refEscaped = 0, count = 0;
                for (const j of grid.ys) {
                  const v = (j + 0.5) / h;
                  const dcyF = parseDec(String(((1 - v) - 0.5) * BIGINT_SCALE), F);
                  for (const i of grid.xs) {
                    const u = (i + 0.5) / w;
                    const dcxF = parseDec(String((u - 0.5) * BIGINT_SCALE * aspect), F);
                    let x = 0n, y = 0n, iter = 0;
                    while (iter < cap) {
                      const xt = mul(x, x) - mul(y, y) + cxBig + dcxF;
                      const yt = 2n * mul(x, y) + cyBig + dcyF;
                      x = xt;
                      y = yt;
                      if (x * x + y * y > bail) break;
                      iter++;
                    }
                    const ref = iter + 1;
                    const gpu = bigintFrame.n[j * w + i];
                    if ((ref > cap) !== (gpu > cap)) mis++;
                    const d = Math.abs(ref - gpu);
                    sumAbs += d;
                    if (d > maxAbs) maxAbs = d;
                    if (ref <= cap) refEscaped++;
                    count++;
                  }
                }
                const misPct = (mis / count) * 100;
                const meanAbs = sumAbs / count;
                const value = 'scale=' + BIGINT_SCALE + ' src=' + src + ' bits=' + bits + ' capIter=' + cap
                  + ' orbitTexels=' + (info ? info.width : '?')
                  + ' sampledPx=' + count + ' refEscaped=' + refEscaped
                  + ' misclassified=' + misPct.toFixed(3) + '% mean|dn|=' + meanAbs.toFixed(3) + ' max|dn|=' + maxAbs;
                if (refEscaped === 0) deepFail('deep_ref_bigint', 'the reference frame is degenerate (no escaped pixels): ' + value);
                else if (misPct > 5) deepFail('deep_ref_bigint', 'the GPU disagrees with the direct BigInt reference: ' + value);
                else deepOk('deep_ref_bigint', value);
              }
            }
          } catch (err) {
            if (!deep.deep_ref_bigint) deepFail('deep_ref_bigint', 'threw: ' + errText(err));
          }

          // (3) readback plausibility of the app's own frame.
          try {
            const p = framePlausibility(floatFrame || bigintFrame);
            if (!p.ok) deepFail('app_readback', 'no orbitFrame() readback (the GPU readback may be failing silently)');
            else if (p.distinct <= 1) deepFail('app_readback', 'orbitFrame() readback is degenerate: distinct=' + p.distinct + ' min=' + p.min + ' max=' + p.max);
            else deepOk('app_readback', 'orbitFrame() n range=' + p.min + '..' + p.max + ' distinct>=' + p.distinct + ' over ' + p.sampled + ' px');
          } catch (err) {
            deepFail('app_readback', 'threw: ' + errText(err));
          }

          // (4) cost at three depths, through the real render path, read AFTER the
          // full-image pass completes.
          //
          // THE DEFECT THIS REPLACES (DECISIONS 105; measured on the owner's D3D11
          // box AND on this SwiftShader host): the old loop called
          // `fv.renderWebGL()` and read `fv.renderTimeMs()` in the SAME synchronous
          // turn. `renderWebGL()` starts a coarse-to-fine refinement CHAIN: it
          // applies the coarsest (step-8) level synchronously and yields the rest as
          // macrotasks, and `lastRenderDuration` — the scalar behind
          // `renderTimeMs()` — is assigned only when the chain COMPLETES, in its
          // step-1 branch. Nothing yields inside the loop, so no chain ever
          // completed, and all three steps read the SAME stale scalar left by the
          // last render that finished before the loop: identical to the decimal on
          // two unrelated drivers, with `passes=0` because the full-resolution pass
          // had not run. A wrong number that looks right is worse than a missing
          // one — the owner diffed those two runs and believed them.
          //
          // MEASURED on this host before the change (1000x700, SwiftShader): right
          // after `renderWebGL()` the readout was 41.7 ms with passesDelta=0 and a
          // live `gpuJobToken()`; after the completion signal the same step measured
          // 69.8 ms with passesDelta=1.
          //
          // So each step DRIVES the real path (`setDeepView` + `renderWebGL`) and
          // then WAITS on the app's own completion signal (`__fv.whenRenderIdle()`,
          // the resolver the chain itself settles) — never a fixed sleep. A step
          // that does not complete inside the budget, or whose completion applied no
          // full-image pass, is an explicit SKIP with its reason: a full-image GPU
          // render was not measurable from here, and saying so beats inventing a
          // number.
          for (const step of COST_STEPS) {
            const id = step.id;
            try {
              fv.setDeepView({ centerX: FLOAT_DEEP_X, centerY: FLOAT_DEEP_Y, scale: step.scale });
              const passesBefore = fv.fullImagePasses ? fv.fullImagePasses() : null;
              fv.renderWebGL();
              // The signal is obtained AFTER the render request, so it cannot resolve
              // against a chain that was already idle.
              const settle = (typeof fv.whenRenderIdle === 'function') ? fv.whenRenderIdle() : null;
              const settled = settle
                ? await Promise.race([settle.then(() => true), sleep(COST_SETTLE_TIMEOUT_MS).then(() => false)])
                : false;
              const ms = fv.renderTimeMs();
              const passesAfter = fv.fullImagePasses ? fv.fullImagePasses() : null;
              const src = fv.orbitSource();
              deepSources.push(src);
              const passes = (passesBefore !== null && passesAfter !== null) ? (passesAfter - passesBefore) : '?';
              const ctx = 'scale=' + step.scale + ' capIter=' + fv.maxIter() + ' lane=' + src + ' passes=' + passes;
              if (!settle) {
                deepSkip(id, 'this build exposes no completion signal (__fv.whenRenderIdle), so a full-image render cannot be timed from here: ' + ctx);
              } else if (!settled) {
                deepSkip(id, 'the full-image render did not complete within ' + (COST_SETTLE_TIMEOUT_MS / 1000) + 's, so renderTimeMs() would report a stale value: ' + ctx);
              } else if (typeof passes !== 'number' || passes < 1) {
                deepSkip(id, 'the render completed without applying a full-image pass, so the reading would not be a full image: ' + ctx);
              } else if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
                deepFail(id, 'renderTimeMs() is not a finite number: ' + ms + ' ms (' + ctx + ')');
              } else {
                deepOk(id, ms.toFixed(1) + ' ms (' + ctx + ')');
              }
            } catch (err) {
              deepFail(id, 'threw: ' + errText(err));
            }
          }
        }
      }
    } catch (err) {
      errors.push('deep lane: ' + errText(err));
    } finally {
      try {
        if (savedView && fv && fv.setDeepView) {
          fv.setDeepView(savedView);
          fv.renderWebGL();
        }
      } catch (_) { /* restoring the view is best effort */ }
    }

    // Emit the deep items in a fixed order; anything not measured is an explicit SKIP.
    for (const id of DEEP_IDS) {
      const r = deep[id];
      if (!r) push('DEEP LANE', id, 'SKIP', 'SKIP (not measured)');
      else push('DEEP LANE', id, r.status, r.value);
    }

    // --- READBACK & ERRORS ---------------------------------------------------
    if (probe.gl) {
      let err = probeError;
      try { err = probe.gl.getError(); } catch (_) { err = -1; }
      if (err === 0) ok('READBACK & ERRORS', 'gl_error', 'NO_ERROR (0) on the probe context after all probe draws');
      else fail('READBACK & ERRORS', 'gl_error', 'gl.getError() = 0x' + (err >>> 0).toString(16) + ' on the probe context');
    } else {
      skip('READBACK & ERRORS', 'gl_error', 'no probe WebGL1 context');
    }

    try {
      const readbackOk = (floatTex.status === 'OK') || (ds && ds.sentinelOk);
      if (readbackOk) ok('READBACK & ERRORS', 'readpixels_plausible', 'a known written value round-tripped through a real draw (float texture and/or probe sentinel)');
      else if (floatTex.status === 'SKIP' && (!ds || ds.status === 'FAIL')) skip('READBACK & ERRORS', 'readpixels_plausible', 'no readback test could run');
      else fail('READBACK & ERRORS', 'readpixels_plausible', 'readPixels did not return the written data');
    } catch (err) {
      fail('READBACK & ERRORS', 'readpixels_plausible', 'threw: ' + errText(err));
    }

    // --- SUMMARY -------------------------------------------------------------
    const counts = { ok: 0, skip: 0, fail: 0 };
    for (const it of items) {
      if (it.status === 'SKIP') counts.skip++;
      else if (it.status === 'FAIL') counts.fail++;
      else counts.ok++;
    }
    const floatTexToken = (floatTex.status === 'OK') ? 'SAMPLES'
      : (floatTex.status === 'SKIP' ? 'UNSUPPORTED' : 'BROKEN');
    const dsLowToken = (!ds || ds.status === 'FAIL') ? 'UNAVAILABLE'
      : (ds.sentinelOk ? (ds.lowNonZero ? (ds.lowChangesResult ? 'NONZERO-ACTIVE' : 'NONZERO-INERT') : 'ZERO-IGNORED') : 'UNAVAILABLE');
    // The INTEGER-controlled residual, read from the runtime-operand arm (the case
    // that failed on the owner's D3D11 driver). UNAVAILABLE = the WebGL2 integer
    // probe could not run; ZERO-COLLAPSED = an integer low component was erased
    // (would mean the fixed-point path itself did not survive this compiler).
    let icToken = 'UNAVAILABLE';
    if (ic && icUsable) {
      const rt = ic.runtime.arms;
      const rtActive = rt.filter((a) => a.loNonZero && a.changes).length;
      const rtNonZero = rt.filter((a) => a.loNonZero).length;
      if (rtActive === 3) icToken = 'NONZERO-ACTIVE';
      else if (rtNonZero > 0) icToken = 'NONZERO-INERT';
      else icToken = 'ZERO-COLLAPSED';
    }
    const lanes = [];
    for (const s of deepSources) {
      if (s && s !== 'none' && lanes.indexOf(s) === -1) lanes.push(s);
    }
    const costParts = [];
    for (const step of COST_STEPS) {
      const item = items.find((it) => it.id === step.id);
      const m = item && /^([0-9.]+) ms/.exec(item.value);
      costParts.push(step.id.replace('cost_', '') + '=' + (m ? m[1] + 'ms' : 'n/a'));
    }
    const summary = 'renderer=' + (rendererName ? '"' + rendererName + '"' : 'unknown')
      + ' kind=' + kind
      + ' floatTex=' + floatTexToken
      + ' dsLow=' + dsLowToken
      + ' icDS=' + icToken
      + ' deepLane=' + (lanes.length ? lanes.join('+') : 'none')
      + ' cost: ' + costParts.join(' ')
      + ' | ' + counts.ok + 'OK/' + counts.skip + 'SKIP/' + counts.fail + 'FAIL';

    const report = buildReport(items, summary, errors);
    lastReport = report;

    // Release OUR context; the app's renderer is untouched.
    try {
      if (probe.gl) {
        const lose = probe.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (_) { /* best effort */ }

    return report;
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// UI wiring. The button and its status span are declared in index.html; nothing
// at import time touches the app's renderer.
// ---------------------------------------------------------------------------

function setStatus(text, state) {
  const el = document.getElementById('gpuDiagStatus');
  if (!el) return;
  el.textContent = text;
  el.dataset.state = state;
}

async function onTestClick() {
  const btn = document.getElementById('gpuDiagBtn');
  if (running) { setStatus('already running…', 'running'); return; }
  setStatus('Test running…', 'running');
  if (btn) btn.disabled = true;
  try {
    const report = await runBattery();
    if (report) {
      // ONE console entry, so the owner can copy the whole block in one action.
      console.log(report.text);
      setStatus('done — see console (F12)', 'done');
    } else {
      setStatus('already running…', 'running');
    }
  } catch (err) {
    setStatus('error — see console', 'error');
    console.error('[gpuDiagnostic] battery failed:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function wireButton() {
  const btn = document.getElementById('gpuDiagBtn');
  if (btn && !btn.dataset.gpuDiagWired) {
    btn.dataset.gpuDiagWired = '1';
    btn.addEventListener('click', onTestClick);
  }
}

if (typeof window !== 'undefined') {
  window.__gpuDiagnostic = Object.freeze({
    run: () => runBattery(),
    lastReport: () => lastReport,
    header: HEADER,
    reportId: REPORT_ID,
    onTestClick: onTestClick,
  });
  wireButton();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireButton);
  }
}
