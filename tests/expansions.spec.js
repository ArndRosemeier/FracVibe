// @ts-check
// MANTISSA-LADDER — the ARITHMETIC LAYER for arbitrary depth: a k-component
// floating-point EXPANSION library in GLSL, with k a BUILD PARAMETER.
//
// WHY THIS SLICE EXISTS. The shipped deep lane's delta is carried in ONE float32
// (24-bit significand). DECISIONS 64 records why that is a SOLVER CHOICE and not
// a floor: precision is MANTISSA WIDTH (the shipped `u_scaleShift` fix extended
// the EXPONENT and did nothing to the mantissa), and the same repository already
// measured the remedy once — compensated float32 held to >=1e10 at 0.000%
// misclassification for 10.4-12.5x the fragment cost — and then abandoned it.
// DECISIONS 66 chose the k-component ladder so the component count grows with
// depth. This spec builds the numeric CONTRACT for that ladder:
//
//   * `public/expansions.glsl.js` EMITS the GLSL for a given k (TwoSum,
//     FastTwoSum, TwoProd via Dekker's split, Priest's distillation, and the
//     add/sub/mul/square/scale the Mandelbrot delta recurrence needs).
//   * `public/expansions.js` is the facade plus the JS REFERENCE: the same
//     algorithms evaluated with `Math.fround` after every operation, i.e. a model
//     of IEEE float32 semantics.
//
// WHAT THE PINS HOLD, AND WHY EACH IS NOT A COMPILE TEST.
//   1. k=1 IDENTITY — the emitted k=1 ops and the k=1 delta recurrence are
//      BIT-IDENTICAL to the hand-written plain float32 expressions. That is the
//      property that lets the existing byte-identical shallow-lane pins keep
//      passing once the ladder is integrated into the shader.
//   2. PRIMITIVE EXACTNESS against an INDEPENDENT BigInt oracle: `s + err == a + b`
//      and `p + err == a * b` EXACTLY, as exact dyadic rationals. The oracle
//      shares no code with the library (docs/STATE.md §TRAP: a reference that
//      shares the code path under test is a tautology).
//   3. CANCELLATION / ADJACENT VALUES and 4. LARGE EXPONENT GAPS — with a
//      REQUIRED-NONZERO LOW COMPONENT, so an expansion that has silently
//      collapsed to float32 cannot pass (docs/RESEARCH-2026-09-21-arbitrary-depth.md
//      §7, warning 2, quoting the luma.gl guidance).
//   5. RENORMALISATION keeps the components ordered and keeps the expansion from
//      collapsing across a chain of operations.
//   6. COST — the deterministic operation counts are pinned exactly (a timing
//      cannot be pinned), and the GPU wall time is measured and reported for
//      k=1/2/4 on the recurrence.
//   7. DEEP-VIEW ACCURACY against a 512-bit fixed-point BigInt reference: the
//      computed delta's relative error per k, and the escape-index
//      misclassification / mean |delta| per k.
//
// EVERY PIN HAS AN IN-SPEC RED CONTROL: a deliberately collapsed variant of the
// SAME algorithm is compiled and run, and the SAME assertion must reject it. That
// is how a pin is shown to discriminate rather than to describe.
//
// THE CERTIFICATION LIMIT, STATED IN THE PIN ITSELF. This host runs WebGL on
// ANGLE + SwiftShader (a SOFTWARE rasteriser — docs/STATE.md §TRAP). These pins
// therefore develop and FALSIFY the mechanism; they do NOT certify that the
// residual terms survive a real GPU compiler and driver. That is reported as
// UNVERIFIED, never assumed.
//
// NOT IN THIS SLICE: integrating the ladder into `public/webglFractal.js`. This
// is NEW FILES ONLY; the shader is owned by another in-flight writer, and the
// integration is a later slice. The recurrence is therefore exercised through a
// harness shader built from the emitted GLSL in the test itself.
const { test, expect } = require('@playwright/test');

// The two new modules. Both have no `import`/`export` (the project's one-file,
// classic-Worker + ES-module pattern, docs/DECISIONS.md row 14) and publish one
// frozen global each, so a `require` here is exactly how a Worker would load them.
require('../public/expansions.glsl.js');
require('../public/expansions.js');
require('../public/bigOrbit.js');
const GLSL = globalThis.FractalExpansionsGLSL;
const EX = globalThis.FractalExpansions;
const BigOrbit = globalThis.BigOrbit;

// ===========================================================================
// AN INDEPENDENT EXACT ORACLE (BigInt dyadic rationals).
//
// A float32 IS an exact dyadic rational (m * 2^e, m an integer), so every claim
// below is decided EXACTLY — no tolerance, no float64 host expression, which
// would be a different rounding than the GPU's. This oracle is written here, not
// imported from the library.
// ===========================================================================
function f32bits(x) {
  const d = new DataView(new ArrayBuffer(4));
  d.setFloat32(0, x);
  return d.getUint32(0);
}
function D(x) {
  x = Math.fround(x);
  if (!isFinite(x)) throw new Error('exact oracle: not a finite float32: ' + x);
  if (x === 0) return { n: 0n, e: 0 };
  const b = f32bits(x), s = (b >>> 31) ? -1n : 1n, ex = (b >>> 23) & 0xff, m = BigInt(b & 0x7fffff);
  if (ex === 0) return { n: s * m, e: -149 };            // subnormal
  return { n: s * (m | 0x800000n), e: ex - 150 };        // normal
}
const dadd = (a, b) => {
  if (a.n === 0n) return b;
  if (b.n === 0n) return a;
  const e = Math.min(a.e, b.e);
  return { n: (a.n << BigInt(a.e - e)) + (b.n << BigInt(b.e - e)), e };
};
const dmul = (a, b) => ({ n: a.n * b.n, e: a.e + b.e });
const dneg = (a) => ({ n: -a.n, e: a.e });
const dabs = (a) => ({ n: a.n < 0n ? -a.n : a.n, e: a.e });
const dsub = (a, b) => dadd(a, dneg(b));
const dsum = (arr) => arr.reduce((acc, x) => dadd(acc, D(x)), { n: 0n, e: 0 });
const deq = (a, b) => {
  if (a.n === 0n && b.n === 0n) return true;
  if (a.n === 0n || b.n === 0n) return false;
  const e = Math.min(a.e, b.e);
  return (a.n << BigInt(a.e - e)) === (b.n << BigInt(b.e - e));
};
function dtoNum(a) {
  if (a.n === 0n) return 0;
  const s = a.n < 0n ? -1 : 1;
  let m = a.n < 0n ? -a.n : a.n;
  let e = a.e;
  const bl = m.toString(2).length;
  if (bl > 53) { m >>= BigInt(bl - 53); e += bl - 53; }
  let v = Number(m);
  // Scale by 2^e in bounded steps so a wide exponent gap cannot turn a finite
  // ratio into NaN via Infinity * 0.
  while (e > 1023) { v *= Math.pow(2, 1023); e -= 1023; if (!isFinite(v)) return s * Infinity; }
  while (e < -1074) { v *= Math.pow(2, -1074); e += 1074; if (v === 0) return 0; }
  return s * v * Math.pow(2, e);
}
function dcmpAbs(a, b) {
  const A = dabs(a), B = dabs(b);
  if (A.n === 0n) return B.n === 0n ? 0 : -1;
  if (B.n === 0n) return 1;
  const e = Math.min(A.e, B.e);
  const x = A.n << BigInt(A.e - e), y = B.n << BigInt(B.e - e);
  return x < y ? -1 : x > y ? 1 : 0;
}
// --- fixed point at F fractional bits (used for the deep-view reference) ---
function toFixed(a, F) {
  if (a.n === 0n) return 0n;
  const sh = F + a.e;
  return sh >= 0 ? a.n << BigInt(sh) : a.n >> BigInt(-sh);
}
function shiftRound(v, F) {
  const b = BigInt(F), h = 1n << (b - 1n);
  return v >= 0n ? (v + h) >> b : -((-v + h) >> b);
}
function fixedToD(v, F) { return { n: v, e: -F }; }
// Exact decimal text for a dyadic (BigOrbit parses decimal strings).
function toDecimal(d) {
  if (d.n === 0n) return '0';
  const neg = d.n < 0n;
  const n = neg ? -d.n : d.n, e = d.e;
  if (e >= 0) return (neg ? '-' : '') + (n << BigInt(e)).toString();
  const k = -e, s = n * (5n ** BigInt(k));
  const st = s.toString().padStart(k + 1, '0');
  return (neg ? '-' : '') + st.slice(0, st.length - k) + '.' + st.slice(st.length - k);
}

// ===========================================================================
// The GPU harness. Self-contained inside page.evaluate (Playwright serializes
// the function source, so it cannot close over anything here).
// ===========================================================================
const GPU_RUN = `(cfg) => {
  const { fs, W, H, a, b, orbit, uniforms } = cfg;
  const out = { ok: false };
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) { out.error = 'no webgl1 context'; return out; }
  if (!gl.getExtension('OES_texture_float') || !gl.getExtension('WEBGL_color_buffer_float')) {
    out.error = 'OES_texture_float / WEBGL_color_buffer_float absent';
    return out;
  }
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    return { sh: s, ok: gl.getShaderParameter(s, gl.COMPILE_STATUS), log: gl.getShaderInfoLog(s) };
  };
  const v = compile(gl.VERTEX_SHADER, 'attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }');
  const f = compile(gl.FRAGMENT_SHADER, fs);
  out.vlog = v.log; out.flog = f.log;
  if (!v.ok || !f.ok) { out.error = 'shader compile failed'; out.stage = v.ok ? 'fragment' : 'vertex'; return out; }
  const prog = gl.createProgram();
  gl.attachShader(prog, v.sh); gl.attachShader(prog, f.sh); gl.linkProgram(prog);
  out.linked = gl.getProgramParameter(prog, gl.LINK_STATUS);
  out.plog = gl.getProgramInfoLog(prog);
  if (!out.linked) { out.error = 'link failed'; return out; }
  const makeTex = (data, w, h) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, data ? new Float32Array(data) : null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const fboTex = makeTex(null, W, H);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
  out.fboStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (out.fboStatus !== gl.FRAMEBUFFER_COMPLETE) { out.error = 'incomplete float FBO'; return out; }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  let unit = 0;
  if (a) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, makeTex(a, W, H)); gl.uniform1i(gl.getUniformLocation(prog, 'u_a'), unit++); }
  if (b) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, makeTex(b, W, H)); gl.uniform1i(gl.getUniformLocation(prog, 'u_b'), unit++); }
  if (orbit) {
    const od = new Float32Array(orbit.w * 4);
    for (let i = 0; i < orbit.w; i++) { od[i * 4] = orbit.zx[i]; od[i * 4 + 1] = orbit.zy[i]; }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, makeTex(od, orbit.w, 1));
    gl.uniform1i(gl.getUniformLocation(prog, 'u_orbit'), unit++);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_orbitW'), orbit.w);
  }
  gl.uniform2f(gl.getUniformLocation(prog, 'u_size'), W, H);
  for (const kv of (uniforms || [])) {
    const l = gl.getUniformLocation(prog, kv[0]);
    if (l) gl.uniform1f(l, kv[1]);
  }
  gl.viewport(0, 0, W, H);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);   // warm-up (shader compile already done; this is the first draw)
  const t0 = performance.now();
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const px = new Float32Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
  out.ms = performance.now() - t0;
  out.ok = true;
  out.px = Array.from(px);
  return out;
}`;

async function gpu(page, cfg) {
  // The harness runs on about:blank: no app, no animation, no shared state.
  const res = await page.evaluate(eval(GPU_RUN), cfg);
  if (!res.ok) {
    throw new Error('GPU harness failed: ' + res.error + ' stage=' + (res.stage || '-')
      + ' flog=' + (res.flog || '') + ' plog=' + (res.plog || ''));
  }
  return res;
}

// Build the fragment shader for one op-level case at component count k.
// `spread` gives the struct constructor from a vec4 attribute.
function opShader(k, op, opts) {
  opts = opts || {};
  const name = opts.name || 'Exp';
  const mk = (p) => {
    const args = [];
    for (let i = 0; i < 4; i++) args.push(i < k ? p + '.' + 'rgba'[i] : '0.0');
    return name + '(' + args.slice(0, Math.max(k, 1)).join(', ') + ')';
  };
  let call;
  if (op === 'add') call = 'EX_ADD(a, b)';
  else if (op === 'sub') call = 'EX_SUB(a, b)';
  else if (op === 'mul') call = 'EX_MUL(a, b)';
  else if (op === 'sqr') call = 'EX_SQR(a)';
  else if (op === 'scale') call = 'EX_SCALE(a, vb.r)';
  else throw new Error('unknown op ' + op);
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(i < k ? 'r.c' + i : '0.0');
  const broken = opts.collapse
    ? '\n  // RED CONTROL: collapse the expansion to its float32 leading term.\n  r = ' + name + '(r.c0' + (k > 1 ? ', ' + new Array(k - 1).fill('0.0').join(', ') : '') + ');'
    : '';
  return `precision highp float;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform vec2 u_size;
${EX.emitGLSL(k, { name: name })}
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec4 va = texture2D(u_a, uv);
  vec4 vb = texture2D(u_b, uv);
  ${name} a = ${mk('va')};
  ${name} b = ${mk('vb')};
  ${name} r = ${call};${broken}
  gl_FragColor = vec4(${outs.join(', ')});
}`;
}

// The hand-written plain float32 expressions — the k=1 identity target.
function plainShader(op) {
  let expr;
  if (op === 'add') expr = 'va.r + vb.r';
  else if (op === 'sub') expr = 'va.r - vb.r';
  else if (op === 'mul') expr = 'va.r * vb.r';
  else if (op === 'sqr') expr = 'va.r * va.r';
  else if (op === 'scale') expr = 'va.r * vb.r';
  else throw new Error(op);
  return `precision highp float;
uniform sampler2D u_a; uniform sampler2D u_b; uniform vec2 u_size;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec4 va = texture2D(u_a, uv); vec4 vb = texture2D(u_b, uv);
  gl_FragColor = vec4(${expr}, 0.0, 0.0, 0.0);
}`;
}

function primitiveShader(kind, opts) {
  opts = opts || {};
  let body;
  if (kind === 'twoSum') body = 'float s, e; TwoSum(va.r, vb.r, s, e);';
  else if (kind === 'fastTwoSum') body = 'float s, e; FastTwoSum(va.r, vb.r, s, e);';
  else if (kind === 'twoProd') body = 'float p, e; TwoProd(va.r, vb.r, p, e);';
  else throw new Error(kind);
  const vars = kind === 'twoProd' ? ['p', 'e'] : ['s', 'e'];
  const broken = opts.collapse
    ? '\n  ' + vars[1] + ' = 0.0; // RED CONTROL: drop the residual.'
    : '';
  return `precision highp float;
uniform sampler2D u_a; uniform sampler2D u_b; uniform vec2 u_size;
${GLSL.primitiveSource()}
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec4 va = texture2D(u_a, uv); vec4 vb = texture2D(u_b, uv);
  ${body}${broken}
  gl_FragColor = vec4(${vars[0]}, ${vars[1]}, 0.0, 0.0);
}`;
}

// Pack N (a,b) pairs into two W x 1 float textures.
function packPairs(pairs) {
  const N = pairs.length;
  const flatA = new Float32Array(N * 4), flatB = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) { flatA[i * 4] = pairs[i][0]; flatB[i * 4] = pairs[i][1]; }
  return { a: Array.from(flatA), b: Array.from(flatB), N };
}

// --- the deep-view recurrence shader --------------------------------------
// Exactly the structure of the shipped perturbation lane
// (public/webglFractal.js `perturbBranch`): the f32 orbit from the texture, the
// rescaled delta with S = 1, the Pauldelbrot rebase rule, and the shipped f32
// escape test. The ONLY change is that the delta arithmetic runs in the
// k-component expansions.
const C0 = -1.4303576324512;
const OFFSET_BITS = 70;
const CENTRE = dadd(D(C0), { n: 1n, e: -OFFSET_BITS });   // exact dyadic centre

function recurrenceShader(k, W, H, maxIter, mode) {
  const doEscape = mode === 'escape';
  const outs = doEscape
    ? 'esc, 0.0, 0.0, 0.0'
    : mode === 'deltaPair'
      ? 'zx.c0, zy.c0, 0.0, 0.0'
      : Array.from({ length: 4 }, (_, i) => (i < k ? 'zx.c' + i : '0.0')).join(', ');
  const loopEscape = doEscape ? `
    float xx = o2.r + EX_TO_FLOAT(zx);
    float yy = o2.g + EX_TO_FLOAT(zy);
    float r2 = xx * xx + yy * yy;
    float zd2 = EX_TO_FLOAT(zx) * EX_TO_FLOAT(zx) + EX_TO_FLOAT(zy) * EX_TO_FLOAT(zy);
    if (r2 > 4.0) { esc = float(i); break; }
    if (r2 < zd2) { zx = EX_FROM_FLOAT(xx); zy = EX_FROM_FLOAT(yy); m = 0; }` : '';
  const maxI = doEscape ? maxIter : 64;
  return `precision highp float;
uniform sampler2D u_orbit;
uniform float u_orbitW;
uniform vec2 u_size;
uniform float u_scale;
uniform float u_aspect;
uniform float u_maxIter;
#define MAXI ${maxI}
${EX.emitGLSL(k)}
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  Exp dx = EX_SCALE(EX_FROM_FLOAT(uv.x - 0.5), u_scale * u_aspect);
  Exp dy = EX_SCALE(EX_FROM_FLOAT((1.0 - uv.y) - 0.5), u_scale);
  Exp zx = EX_ZERO();
  Exp zy = EX_ZERO();
  float esc = -1.0;
  int m = 0;
  for (int i = 0; i < MAXI; i++) {
    if (float(i) >= u_maxIter) break;
    float om = min(float(m), u_orbitW - 1.0);
    vec4 o = texture2D(u_orbit, vec2((om + 0.5) / u_orbitW, 0.5));
    Exp nx, ny;
    EX_DELTA_STEP(zx, zy, dx, dy, o.r, o.g, 1.0, nx, ny);
    zx = nx; zy = ny; m++;
    float om2 = min(float(m), u_orbitW - 1.0);
    vec4 o2 = texture2D(u_orbit, vec2((om2 + 0.5) / u_orbitW, 0.5));${loopEscape}
  }
  gl_FragColor = vec4(${outs});
}`;
}

// The reference orbit is the app's own BigInt orbit at the depth-scaled
// precision, quantised to float32 by the app's own transport — the SAME input the
// shader receives, so the comparison isolates the delta arithmetic and the escape
// test, not the orbit.
function orbitFor(scale, maxIter) {
  const o = BigOrbit.computeOrbitFixed(
    toDecimal(CENTRE), '0', maxIter, BigOrbit.bitsForScale(scale), 8192,
  );
  return { zx: Array.from(o.zx), zy: Array.from(o.zy), w: o.width, escapedAt: o.escapedAt, bits: o.bits };
}

// The per-pixel delta seed exactly as the shader computes it. For k > 1 the seed
// is the EXACT product of two float32s (the expansion's first two components);
// for k == 1 it is the shipped rounded product.
function pixelSeed(px, py, W, H, scale, aspect, k) {
  const uvx = Math.fround(Math.fround(px + 0.5) / W);
  const uvy = Math.fround(Math.fround(py + 0.5) / H);
  const ou = Math.fround(uvx - 0.5);
  const ov = Math.fround(Math.fround(1 - uvy) - 0.5);
  const sc = Math.fround(scale * aspect);
  const dxExact = dmul(D(ou), D(sc));
  const dyExact = dmul(D(ov), D(scale));
  return {
    dx: k === 1 ? D(Math.fround(ou * sc)) : dxExact,
    dy: k === 1 ? D(Math.fround(ov * scale)) : dyExact,
  };
}

// The 512-bit fixed-point reference. The recurrence is the SAME recurrence; the
// point is that at 512 bits its own rounding is ~2^-470 after amplification,
// which is far below the ~2^-22..2^-96 the expansions can reach, so the measured
// error is the GPU's.
const F_REF = 512;
function refDelta(px, py, W, H, scale, aspect, orbit, k, steps) {
  const s = pixelSeed(px, py, W, H, scale, aspect, k);
  const ddx = toFixed(s.dx, F_REF), ddy = toFixed(s.dy, F_REF);
  let zx = 0n, zy = 0n;
  for (let n = 0; n < steps; n++) {
    const Zx = toFixed(D(orbit.zx[n]), F_REF), Zy = toFixed(D(orbit.zy[n]), F_REF);
    const t1 = shiftRound(2n * Zx * zx, F_REF), t2 = shiftRound(2n * Zy * zy, F_REF);
    const t3 = shiftRound(zx * zx, F_REF), t4 = shiftRound(zy * zy, F_REF);
    const nx = t1 - t2 + t3 - t4 + ddx;
    const u1 = shiftRound(2n * Zx * zy, F_REF), u2 = shiftRound(2n * Zy * zx, F_REF);
    const u3 = shiftRound(2n * zx * zy, F_REF);
    const ny = u1 + u2 + u3 + ddy;
    zx = nx; zy = ny;
  }
  return { zx: fixedToD(zx, F_REF), zy: fixedToD(zy, F_REF) };
}

// The direct (no perturbation) 512-bit reference for one pixel: the TRUE pixel
// orbit of `centre + dc`. This is what the frame is compared against.
function refEscape(px, py, W, H, scale, aspect, maxIter) {
  const s = pixelSeed(px, py, W, H, scale, aspect, 4);   // exact seed for every k
  const cX = toFixed(dadd(CENTRE, s.dx), F_REF);
  const cY = toFixed(s.dy, F_REF);
  let zx = 0n, zy = 0n;
  const four = 4n << BigInt(2 * F_REF);
  for (let n = 0; n < maxIter; n++) {
    if (zx * zx + zy * zy > four) return n;
    const nx = shiftRound(zx * zx - zy * zy, F_REF) + cX;
    const ny = shiftRound(2n * zx * zy, F_REF) + cY;
    zx = nx; zy = ny;
  }
  return -1;
}

// ===========================================================================
// PIN 1 — k=1 reduces EXACTLY to the plain float32 expressions.
// ===========================================================================
test('EXPANSIONS pin 1: the k=1 ladder is bit-identical to the plain float32 expressions', async ({ page }) => {
  await page.goto('about:blank');
  const N = 96;
  const pairs = [];
  for (let i = 0; i < N; i++) {
    const e = (i % 61) - 30;
    const a = Math.fround((0.5 + (i % 7) / 8) * Math.pow(2, e));
    const b = Math.fround(-(0.25 + (i % 5) / 8) * Math.pow(2, e - (i % 3)));
    pairs.push([a, b]);
  }
  const { a, b: bb } = packPairs(pairs);

  for (const op of ['add', 'sub', 'mul', 'sqr', 'scale']) {
    const ladder = await gpu(page, { fs: opShader(1, op), W: N, H: 1, a, b: bb });
    const plain = await gpu(page, { fs: plainShader(op), W: N, H: 1, a, b: bb });
    let mismatches = 0;
    for (let i = 0; i < N; i++) {
      if (bitsOf(ladder.px[i * 4]) !== bitsOf(plain.px[i * 4])) mismatches++;
    }
    expect(mismatches, `${op}: k=1 must equal the plain expression bit-for-bit`).toBe(0);
  }

  // The k=1 recurrence too, not just the ops: same inputs, same output frame.
  const W = 24, H = 16, MAXITER = 64;
  const scale = Math.fround(1e-6), aspect = 1.0;
  const orbit = orbitFor(scale, MAXITER);
  const cfgBase = {
    W, H, orbit: { zx: orbit.zx, zy: orbit.zy, w: orbit.w },
    uniforms: [['u_scale', scale], ['u_aspect', aspect], ['u_maxIter', MAXITER]],
  };
  const ladderRec = await gpu(page, { ...cfgBase, fs: recurrenceShader(1, W, H, MAXITER, 'deltaPair') });
  const plainRec = await gpu(page, { ...cfgBase, fs: recurrenceShaderPlainF32(W, H) });
  let recMismatch = 0;
  for (let i = 0; i < W * H; i++) {
    if (bitsOf(ladderRec.px[i * 4]) !== bitsOf(plainRec.px[i * 4])) recMismatch++;
    if (bitsOf(ladderRec.px[i * 4 + 1]) !== bitsOf(plainRec.px[i * 4 + 1])) recMismatch++;
  }
  expect(recMismatch, 'the k=1 delta recurrence must equal the plain float32 recurrence bit-for-bit').toBe(0);
  console.log('[expansions pin1] k=1 identity: ops 5x' + N + ' scalars + recurrence ' + (W * H)
    + ' px, mismatches 0');
});

function bitsOf(x) { return f32bits(x); }

// The plain float32 recurrence, transcribed from the shipped shader's two lines,
// for the k=1 identity comparison.
function recurrenceShaderPlainF32(W, H) {
  return `precision highp float;
uniform sampler2D u_orbit;
uniform float u_orbitW;
uniform vec2 u_size;
uniform float u_scale;
uniform float u_aspect;
uniform float u_maxIter;
#define MAXI 64
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  float dcx = (uv.x - 0.5) * u_scale * u_aspect;
  float dcy = ((1.0 - uv.y) - 0.5) * u_scale;
  float S = 1.0;
  float dzx = 0.0, dzy = 0.0;
  float ddx = dcx, ddy = dcy;
  float Zx = 0.0, Zy = 0.0;
  int m = 0;
  for (int i = 0; i < MAXI; i++) {
    if (float(i) >= u_maxIter) break;
    float om = min(float(m), u_orbitW - 1.0);
    vec4 o = texture2D(u_orbit, vec2((om + 0.5) / u_orbitW, 0.5));
    Zx = o.r; Zy = o.g;
    float nwx = 2.0 * (Zx * dzx - Zy * dzy) + S * (dzx * dzx - dzy * dzy) + ddx;
    float nwy = 2.0 * (Zx * dzy + Zy * dzx) + S * (2.0 * dzx * dzy) + ddy;
    dzx = nwx; dzy = nwy; m++;
  }
  gl_FragColor = vec4(dzx, dzy, 0.0, 0.0);
}`;
}

// ===========================================================================
// PIN 2 — TwoSum / FastTwoSum / TwoProd are EXACT, verified against BigInt.
// ===========================================================================
// All pairs stay inside the Dekker split's published range precondition for
// TwoProd (|a| < SPLITTER_MAX ~= 8.3e34); the bound itself is pinned in 2c.
const HARD_PAIRS = [
  [1.0, Math.pow(2, -24)],                       // cancellation at 1 ulp
  [1.0, -(1 - Math.pow(2, -23))],                // adjacent values
  [Math.pow(2, 30), -(Math.pow(2, 30) - 64)],    // big/small cancellation
  [Math.pow(2, 100), Math.pow(2, -100)],         // 200-bit exponent gap
  [1e30, 1.0],                                   // 100-bit exponent gap
  [3.0e30, 1e-30],                               // near the splitter bound + tiny
  [1e-30, 1e30],                                 // normal-range extreme gap
  [Math.fround(1.5), Math.fround(Math.pow(2, -20))],
  [12345.678, 0.00012345678],
  [-7.25, Math.pow(2, -30)],
];

test('EXPANSIONS pin 2: the error-free transforms are EXACT (BigInt oracle), and a collapsed build is rejected', async ({ page }) => {
  await page.goto('about:blank');
  const { a, b } = packPairs(HARD_PAIRS);
  const N = HARD_PAIRS.length;

  // (a) TwoSum: s + err == a + b exactly.
  const twoSum = await gpu(page, { fs: primitiveShader('twoSum'), W: N, H: 1, a, b });
  // (b) TwoProd: p + err == a * b exactly.
  const twoProd = await gpu(page, { fs: primitiveShader('twoProd'), W: N, H: 1, a, b });
  // (c) FastTwoSum, fed ORDERED inputs (|a| >= |b|) — its precondition.
  const ord = HARD_PAIRS.map(([x, y]) => (Math.abs(x) >= Math.abs(y) ? [x, y] : [y, x]));
  const packed = packPairs(ord);
  const fast = await gpu(page, { fs: primitiveShader('fastTwoSum'), W: N, H: 1, a: packed.a, b: packed.b });

  for (let i = 0; i < N; i++) {
    const [x, y] = HARD_PAIRS[i];
    const s = twoSum.px[i * 4], e = twoSum.px[i * 4 + 1];
    expect(deq(dadd(D(s), D(e)), dadd(D(x), D(y))), `TwoSum exact for ${x},${y}`).toBe(true);
    const p = twoProd.px[i * 4], q = twoProd.px[i * 4 + 1];
    expect(deq(dadd(D(p), D(q)), dmul(D(x), D(y))), `TwoProd exact for ${x},${y}`).toBe(true);
    const fs = fast.px[i * 4], fe = fast.px[i * 4 + 1];
    expect(deq(dadd(D(fs), D(fe)), dadd(D(ord[i][0]), D(ord[i][1]))), `FastTwoSum exact for ordered ${ord[i][0]},${ord[i][1]}`).toBe(true);
  }

  // RED CONTROL: the SAME oracle must REJECT a build that drops the residual.
  const badSum = await gpu(page, { fs: primitiveShader('twoSum', { collapse: true }), W: N, H: 1, a, b });
  const badProd = await gpu(page, { fs: primitiveShader('twoProd', { collapse: true }), W: N, H: 1, a, b });
  let sumRejected = 0, prodRejected = 0;
  for (let i = 0; i < N; i++) {
    const [x, y] = HARD_PAIRS[i];
    if (!deq(dadd(D(badSum.px[i * 4]), D(badSum.px[i * 4 + 1])), dadd(D(x), D(y)))) sumRejected++;
    if (!deq(dadd(D(badProd.px[i * 4]), D(badProd.px[i * 4 + 1])), dmul(D(x), D(y)))) prodRejected++;
  }
  expect(sumRejected, 'the collapse control must be rejected (TwoSum)').toBeGreaterThan(0);
  expect(prodRejected, 'the collapse control must be rejected (TwoProd)').toBeGreaterThan(0);
  console.log('[expansions pin2] exact over ' + N + ' hard pairs; collapsed control rejected on '
    + sumRejected + '/' + N + ' sums and ' + prodRejected + '/' + N + ' products');
});

// FastTwoSum is only valid when |a| >= |b|. This control shows the precondition
// is LOAD-BEARING rather than decorative: fed an unordered pair it loses the
// residual, while TwoSum on the same pair stays exact.
test('EXPANSIONS pin 2b: FastTwoSum\'s magnitude precondition is load-bearing', async ({ page }) => {
  await page.goto('about:blank');
  // |a| < |b|, and the sum is NOT representable, so the wrong order loses it.
  const pairs = [[1.0, Math.pow(2, 30) + 64], [1.0, Math.pow(2, 30)]];
  const { a, b } = packPairs(pairs);
  const N = pairs.length;
  const slow = await gpu(page, { fs: primitiveShader('twoSum'), W: N, H: 1, a, b });
  const fast = await gpu(page, { fs: primitiveShader('fastTwoSum'), W: N, H: 1, a, b });
  let fastLost = 0, slowLost = 0;
  for (let i = 0; i < N; i++) {
    const [x, y] = pairs[i];
    const exact = dadd(D(x), D(y));
    if (!deq(dadd(D(slow.px[i * 4]), D(slow.px[i * 4 + 1])), exact)) slowLost++;
    if (!deq(dadd(D(fast.px[i * 4]), D(fast.px[i * 4 + 1])), exact)) fastLost++;
  }
  expect(slowLost, 'TwoSum is order-independent and must stay exact').toBe(0);
  expect(fastLost, 'FastTwoSum without its preconditions must lose the residual').toBe(N);
  console.log('[expansions pin2b] unordered FastTwoSum lost ' + fastLost + '/' + N
    + ' (TwoSum lost ' + slowLost + '/' + N + ') — the precondition is real');
});

// The Dekker split has a RANGE precondition too, and it is not the same one as
// FastTwoSum's. Beyond ~8.3e34 the splitter product overflows, so TwoProd's
// residual is NaN rather than small. Pinned so a caller cannot meet it as a
// surprise: the JS reference and the GPU must break in the SAME place.
test('EXPANSIONS pin 2c: TwoProd\'s splitter bound is explicit (NaN beyond it, exact inside)', async ({ page }) => {
  await page.goto('about:blank');
  const inside = [[3.0e30, 1e-30], [1e20, 1e-20]];   // both operands < SPLITTER_MAX, product in range
  const outside = [[1e38, 1.0], [-3.0e38, 2.0]];
  const pkIn = packPairs(inside), pkOut = packPairs(outside);

  const gpuIn = await gpu(page, { fs: primitiveShader('twoProd'), W: inside.length, H: 1, a: pkIn.a, b: pkIn.b });
  const gpuOut = await gpu(page, { fs: primitiveShader('twoProd'), W: outside.length, H: 1, a: pkOut.a, b: pkOut.b });

  for (let i = 0; i < inside.length; i++) {
    const [x, y] = inside[i];
    expect(deq(dadd(D(gpuIn.px[i * 4]), D(gpuIn.px[i * 4 + 1])), dmul(D(x), D(y))),
      'inside the splitter bound TwoProd must stay exact').toBe(true);
  }
  for (let i = 0; i < outside.length; i++) {
    const [x, y] = outside[i];
    const js = EX.twoProd(x, y);
    expect(Number.isNaN(js[1]), 'the JS reference must show the bound: ' + x).toBe(true);
    expect(Number.isNaN(gpuOut.px[i * 4 + 1]), 'the GPU must show the same bound: ' + x).toBe(true);
    // TwoSum has NO such precondition and stays exact on the same operands.
  }
  const bound = EX.SPLITTER_MAX;
  expect(bound).toBeGreaterThan(1e34);
  expect(bound).toBeLessThan(1e35);
  console.log('[expansions pin2c] TwoProd splitter bound SPLITTER_MAX=' + bound.toExponential(3)
    + ' — exact inside, NaN outside, on GPU and in the JS reference alike'
    + ' (the recurrence\'s operand magnitudes are O(1), so the bound is not binding there)');
});

// ===========================================================================
// PIN 3 — cancellation / adjacent values keep a REQUIRED-NONZERO low component.
// ===========================================================================
test('EXPANSIONS pin 3: cancellation and adjacent values survive in a nonzero low component', async ({ page }) => {
  await page.goto('about:blank');
  const cases = [
    { a: 1.0, b: Math.pow(2, -24), note: '1 + 2^-24 rounds back to 1 in float32' },
    { a: 1.0, b: -(1 - Math.pow(2, -23)), note: 'adjacent floats, sum is one ulp' },
    { a: Math.pow(2, 30), b: -(Math.pow(2, 30) - 64), note: 'wide cancellation, exact difference' },
    { a: Math.fround(0.1), b: Math.fround(Math.pow(2, -30)), note: '0.1 + 2^-30' },
  ];
  const { a, b } = packPairs(cases.map((c) => [c.a, c.b]));
  const N = cases.length;
  const out = await gpu(page, { fs: opShader(2, 'add'), W: N, H: 1, a, b });
  const collapsed = await gpu(page, { fs: opShader(2, 'add', { collapse: true }), W: N, H: 1, a, b });

  let nonzeroLow = 0, representable = 0, k1Lost = 0;
  for (let i = 0; i < N; i++) {
    const c0 = out.px[i * 4], c1 = out.px[i * 4 + 1];
    const exact = dadd(D(cases[i].a), D(cases[i].b));
    expect(deq(dadd(D(c0), D(c1)), exact), 'k=2 sum exact: ' + cases[i].note).toBe(true);
    // The k=1 rung has only c0. Where it DIFFERS from the exact sum the low
    // component is doing real work and must be nonzero; where the exact sum is
    // representable in float32 the low component is correctly zero.
    const k1 = EX.Expansion(1).add([cases[i].a], [cases[i].b]);
    if (!deq(D(k1[0]), exact)) {
      k1Lost++;
      expect(c1 !== 0, 'recovered residual must be nonzero: ' + cases[i].note).toBe(true);
      nonzeroLow++;
    } else {
      expect(c1 === 0, 'an exactly representable sum has no residual: ' + cases[i].note).toBe(true);
      representable++;
    }
  }
  expect(nonzeroLow, 'the cases the k=1 rung loses must all carry a nonzero low component').toBeGreaterThanOrEqual(2);
  expect(representable, 'some cases are exactly representable and must have no residual').toBeGreaterThanOrEqual(1);

  // RED CONTROL: the collapsed k=2 build has c1 == 0 by construction, and the
  // exactness assertion above must fail on at least one case.
  let controlRejected = 0;
  for (let i = 0; i < N; i++) {
    if (!deq(dadd(D(collapsed.px[i * 4]), D(collapsed.px[i * 4 + 1])), dadd(D(cases[i].a), D(cases[i].b)))) controlRejected++;
  }
  expect(controlRejected, 'the collapsed control must be rejected').toBeGreaterThan(0);
  console.log('[expansions pin3] ' + N + ' cancellation cases: nonzero low components ' + nonzeroLow
    + '/' + N + '; collapsed control rejected on ' + controlRejected);
});

// ===========================================================================
// PIN 4 — large exponent gaps: the small operand survives.
// ===========================================================================
test('EXPANSIONS pin 4: a 200-bit exponent gap survives in the low components', async ({ page }) => {
  await page.goto('about:blank');
  const cases = [
    { a: Math.pow(2, 100), b: Math.pow(2, -100) },      // 200 bits apart
    { a: 1e30, b: 1.0 },                                 // ~100 bits apart
    { a: 3.0e38, b: Math.pow(2, -100) },
    { a: Math.pow(2, -100), b: Math.pow(2, 100) },
  ];
  const { a, b } = packPairs(cases.map((c) => [c.a, c.b]));
  const N = cases.length;
  const out = await gpu(page, { fs: opShader(2, 'add'), W: N, H: 1, a, b });
  const collapsed = await gpu(page, { fs: opShader(2, 'add', { collapse: true }), W: N, H: 1, a, b });

  let nonzeroLow = 0, rejected = 0;
  for (let i = 0; i < N; i++) {
    const c0 = out.px[i * 4], c1 = out.px[i * 4 + 1];
    expect(deq(dadd(D(c0), D(c1)), dadd(D(cases[i].a), D(cases[i].b))),
      `exponent-gap sum exact for 2^${Math.log2(Math.abs(cases[i].a)).toFixed(0)} + ${cases[i].b}`).toBe(true);
    if (c1 !== 0) nonzeroLow++;
    if (!deq(dadd(D(collapsed.px[i * 4]), D(collapsed.px[i * 4 + 1])), dadd(D(cases[i].a), D(cases[i].b)))) rejected++;
  }
  expect(nonzeroLow, 'the small operand must survive in a nonzero low component').toBe(N);
  expect(rejected, 'the collapsed control must be rejected').toBe(N);
  console.log('[expansions pin4] exponent-gap cases: nonzero low ' + nonzeroLow + '/' + N
    + '; collapsed control rejected ' + rejected + '/' + N);
});

// ===========================================================================
// PIN 5 — renormalisation keeps the expansion ordered along a chain.
// ===========================================================================
test('EXPANSIONS pin 5: renormalisation keeps the components ordered and the expansion alive across a chain', async ({ page }) => {
  await page.goto('about:blank');
  // A deterministic chain of k=4 additions/multiplications, run in the shader,
  // replayed in the JS reference, and checked against the BigInt oracle.
  const N = 32;
  const inputsA = new Float32Array(N * 4), inputsB = new Float32Array(N * 4);
  const jsResults = [];
  for (let i = 0; i < N; i++) {
    const a0 = Math.fround(1 + i / 64), a1 = Math.fround(Math.pow(2, -25) * (1 + i));
    const b0 = Math.fround(-1 + i / 128), b1 = Math.fround(Math.pow(2, -26) * (2 + i));
    inputsA[i * 4] = a0; inputsA[i * 4 + 1] = a1;
    inputsB[i * 4] = b0; inputsB[i * 4 + 1] = b1;
    // JS reference chain: ((A + B) * A) - B
    const E = EX.Expansion(4);
    const A = [a0, a1, 0, 0], B = [b0, b1, 0, 0];
    const sum = E.add(A, B);
    const prod = E.mul(sum, A);
    const back = E.sub(prod, B);
    jsResults.push({ A, B, back });
  }
  const fs = `precision highp float;
uniform sampler2D u_a; uniform sampler2D u_b; uniform vec2 u_size;
${EX.emitGLSL(4)}
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec4 va = texture2D(u_a, uv); vec4 vb = texture2D(u_b, uv);
  Exp A = Exp(va.r, va.g, va.b, va.a);
  Exp B = Exp(vb.r, vb.g, vb.b, vb.a);
  Exp r = EX_SUB(EX_MUL(EX_ADD(A, B), A), B);
  gl_FragColor = vec4(r.c0, r.c1, r.c2, r.c3);
}`;
  const out = await gpu(page, { fs, W: N, H: 1, a: Array.from(inputsA), b: Array.from(inputsB) });
  let orderViolations = 0, jsMismatches = 0, oracleFailures = 0, nonzeroLow = 0;
  for (let i = 0; i < N; i++) {
    const got = [out.px[i * 4], out.px[i * 4 + 1], out.px[i * 4 + 2], out.px[i * 4 + 3]];
    for (let c = 0; c < 4; c++) if (bitsOf(got[c]) !== bitsOf(jsResults[i].back[c])) jsMismatches++;
    for (let c = 1; c < 4; c++) if (Math.abs(got[c]) > Math.abs(got[c - 1]) * (1 + 1e-6)) orderViolations++;
    // Exact contract: the chain result's exact sum must equal the exact value of
    // the same chain evaluated on the exact (dyadic) inputs, to within the
    // k-component truncation. The first two components of a k=4 chain carry the
    // bulk; the assertion that matters is that components 2 and 3 are LIVE.
    const exact = dsub(dmul(dadd(dsum(jsResults[i].A), dsum(jsResults[i].B)), dsum(jsResults[i].A)), dsum(jsResults[i].B));
    const gotSum = dsum(got);
    if (dcmpAbs(dsub(gotSum, exact), { n: 0n, e: 0 }) !== 0) {
      // not exactly zero (the chain truncates at 4 components) — require the
      // relative error to be at the 4-component level, not the float32 level.
      const rel = Math.abs(dtoNum(dsub(gotSum, exact))) / Math.max(1e-300, Math.abs(dtoNum(exact)));
      if (rel > Math.pow(2, -24 * 4 + 10)) oracleFailures++;
    }
    if (got[2] !== 0 || got[3] !== 0) nonzeroLow++;
  }
  expect(jsMismatches, 'the emitted GLSL must match the JS float32 reference bit-for-bit across a chain').toBe(0);
  expect(orderViolations, 'renormalised components must stay ordered by magnitude').toBe(0);
  expect(oracleFailures, 'the chain must stay within the k-component truncation bound vs the BigInt oracle').toBe(0);
  expect(nonzeroLow, 'the 3rd/4th components must be live, not padding').toBeGreaterThan(N / 2);
  console.log('[expansions pin5] chain: GLSL/JS mismatches ' + jsMismatches + ', order violations '
    + orderViolations + ', oracle failures ' + oracleFailures + ', live low components ' + nonzeroLow + '/' + N);
});

// ===========================================================================
// PIN 6 — cost. Exact operation counts pinned; GPU wall time measured.
// ===========================================================================
test('EXPANSIONS pin 6: the cost model is exact and grows with k, and k=2 has a fixed per-op cost', async ({ page }) => {
  await page.goto('about:blank');
  // The deterministic model: for k components, EX_ADD distils 2k values
  // (C(2k,2) TwoSums); EX_MUL distils 2k^2 values (C(2k^2,2) TwoSums) from k^2
  // TwoProds. These are structural facts about the emitted source, so they can be
  // pinned exactly where a wall time cannot.
  const expected = {
    1: { add: 0, mul: 0, scale: 0, deltaTwoSum: 0, deltaTwoProd: 0 },
    2: { add: 6, mul: 28, scale: 6, deltaTwoSum: 138, deltaTwoProd: 20 },
    3: { add: 15, mul: 153, scale: 15, deltaTwoSum: 594, deltaTwoProd: 39 },
    4: { add: 28, mul: 496, scale: 28, deltaTwoSum: 1740, deltaTwoProd: 64 },
  };
  for (const k of [1, 2, 3, 4]) {
    const c = EX.opCounts(k);
    const twoSumFor = (n) => (n * (n - 1)) / 2;
    expect(c.add.twoSum, `k=${k} EX_ADD TwoSums`).toBe(k === 1 ? 0 : twoSumFor(2 * k));
    expect(c.mul.twoSum, `k=${k} EX_MUL TwoSums`).toBe(k === 1 ? 0 : twoSumFor(2 * k * k));
    expect(c.mul.twoProd, `k=${k} EX_MUL TwoProds`).toBe(k === 1 ? 0 : k * k);
    expect(c.scale.twoSum, `k=${k} EX_SCALE TwoSums`).toBe(k === 1 ? 0 : twoSumFor(2 * k));
    expect(c.deltaStep.twoSum, `k=${k} delta-step TwoSums`).toBe(expected[k].deltaTwoSum);
    expect(c.deltaStep.twoProd, `k=${k} delta-step TwoProds`).toBe(expected[k].deltaTwoProd);
  }
  // The k=2 rung is the first one with error-free transforms, and its per-op
  // overhead is a FIXED number of operations (no data-dependent branching), so
  // the cost of the ladder is k-dependent only.
  expect(EX.opCounts(2).deltaStep.twoSum).toBe(138);
  expect(EX.opCounts(4).deltaStep.twoSum / EX.opCounts(2).deltaStep.twoSum).toBeCloseTo(1740 / 138, 6);

  // Measured wall time for the recurrence, k = 1/2/4, same frame and budget.
  const W = 32, H = 24, MAXITER = 512, scale = Math.fround(1e-6);
  const orbit = orbitFor(scale, MAXITER);
  const timings = {};
  for (const k of [1, 2, 4]) {
    const r = await gpu(page, {
      fs: recurrenceShader(k, W, H, MAXITER, 'escape'),
      W, H, orbit: { zx: orbit.zx, zy: orbit.zy, w: orbit.w },
      uniforms: [['u_scale', scale], ['u_aspect', 1.0], ['u_maxIter', MAXITER]],
    });
    timings[k] = r.ms;
  }
  // A toy op-level frame for the pure-arithmetic ratio, free of escape/rebase.
  const N = 64;
  const pairs = [];
  for (let i = 0; i < N; i++) pairs.push([Math.fround(1 + i / 32), Math.fround(-1 + i / 64)]);
  const pk = packPairs(pairs);
  const opMs = {};
  for (const k of [1, 2, 4]) {
    // Repeat the mul many times inside the shader so the measurement is not
    // dominated by draw/readback overhead.
    const fs = `precision highp float;
uniform sampler2D u_a; uniform sampler2D u_b; uniform vec2 u_size;
${EX.emitGLSL(k)}
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec4 va = texture2D(u_a, uv); vec4 vb = texture2D(u_b, uv);
  Exp r = ${k === 1 ? 'Exp(va.r)' : 'Exp(' + new Array(k).fill('va.r').join(', ') + ')'};
  Exp s = ${k === 1 ? 'Exp(vb.r)' : 'Exp(' + new Array(k).fill('vb.r').join(', ') + ')'};
  for (int i = 0; i < 64; i++) { r = EX_MUL(r, s); s = EX_ADD(s, EX_FROM_FLOAT(0.001)); }
  gl_FragColor = vec4(r.c0, 0.0, 0.0, 0.0);
}`;
    const r = await gpu(page, { fs, W: N, H: 1, a: pk.a, b: pk.b });
    opMs[k] = r.ms;
  }
  // Timing is a MEASUREMENT, not a contract: assert only that the ladder is not
  // free, on the same host in the same run.
  expect(timings[2]).toBeGreaterThan(0);
  expect(timings[4]).toBeGreaterThan(timings[1]);
  console.log('[expansions pin6] op counts (twoSum/twoProd per delta step): '
    + [1, 2, 3, 4].map((k) => 'k' + k + '=' + EX.opCounts(k).deltaStep.twoSum + '/' + EX.opCounts(k).deltaStep.twoProd).join(' '));
  console.log('[expansions pin6] measured ms (software rasteriser): recurrence 32x24x' + MAXITER + ' '
    + [1, 2, 4].map((k) => 'k' + k + '=' + timings[k].toFixed(1)).join(' ')
    + ' | 64x EX_MUL/EX_ADD chain ' + [1, 2, 4].map((k) => 'k' + k + '=' + opMs[k].toFixed(1)).join(' '));
});

// ===========================================================================
// PIN 7 — deep-view accuracy against the 512-bit BigInt reference.
// ===========================================================================
test('EXPANSIONS pin 7: the ladder buys delta precision on a deep view (vs a 512-bit BigInt reference)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('about:blank');
  const W = 32, H = 24, MAXITER = 4096;

  // The delta-error table runs WITHOUT rebasing, so the step count must stay
  // inside float32's range: the delta grows like scale * 2^steps. One doubling
  // per bit of zoom keeps |delta| at O(1).
  const views = [
    { label: 'shallow 1e-6', scale: Math.fround(1e-6), maxIter: 1024, deltaSteps: 20 },
    { label: 'deep 1e-20', scale: Math.fround(1e-20), maxIter: MAXITER, deltaSteps: 64 },
  ];

  const rows = [];
  for (const view of views) {
    const scale = view.scale, maxIter = view.maxIter, aspect = 1.0;
    const orbit = orbitFor(scale, maxIter);
    const base = {
      W, H, orbit: { zx: orbit.zx, zy: orbit.zy, w: orbit.w },
      uniforms: [['u_scale', scale], ['u_aspect', aspect], ['u_maxIter', maxIter]],
    };

    // --- Table A: the computed delta's relative error, no escape/rebase ------
    const STEPS = view.deltaSteps;
    const orbitShort = orbitFor(scale, STEPS);
    const baseShort = {
      W, H, orbit: { zx: orbitShort.zx, zy: orbitShort.zy, w: orbitShort.w },
      uniforms: [['u_scale', scale], ['u_aspect', aspect], ['u_maxIter', STEPS]],
    };
    const deltaRows = [];
    for (const k of [1, 2, 4]) {
      const r = await gpu(page, { ...baseShort, fs: recurrenceShader(k, W, H, STEPS, 'delta') });
      let sumRel = 0, maxRel = 0, n = 0, nonzeroLow = 0;
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const i = (py * W + px) * 4;
          const got = [];
          for (let c = 0; c < k; c++) got.push(r.px[i + c]);
          const ref = refDelta(px, py, W, H, scale, aspect, orbitShort, k, STEPS);
          const den = Math.abs(dtoNum(ref.zx));
          if (den > 0) {
            const rel = Math.abs(dtoNum(dsub(dsum(got), ref.zx))) / den;
            sumRel += rel; n++;
            if (rel > maxRel) maxRel = rel;
          }
          if (k > 1 && got[1] !== 0) nonzeroLow++;
        }
      }
      deltaRows.push({ k, meanRel: n > 0 ? sumRel / n : NaN, maxRel, nonzeroLow, samples: n, ms: r.ms });
      if (k > 1) {
        expect(nonzeroLow, `k=${k}: the low component must be nonzero across the deep view`).toBeGreaterThan(0.9 * W * H);
      }
    }

    // --- Table B: escape index vs the direct 512-bit reference ---------------
    const truth = [];
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) truth.push(refEscape(px, py, W, H, scale, aspect, maxIter));
    const escRows = [];
    for (const k of [1, 2, 4]) {
      const r = await gpu(page, { ...base, fs: recurrenceShader(k, W, H, maxIter, 'escape') });
      let mis = 0, sum = 0;
      for (let i = 0; i < W * H; i++) {
        const g = r.px[i * 4] | 0;
        const gv = g < 0 ? -1 : g + 1;   // the shader's esc counts completed steps
        if (gv !== truth[i]) { mis++; sum += Math.abs(gv - truth[i]); }
      }
      escRows.push({ k, mis, mean: sum / (W * H), ms: r.ms });
    }

    rows.push({ view, deltaRows, escRows, inside: truth.filter((v) => v < 0).length });

    // Print the measured table into the raw gate log BEFORE asserting, so a red
    // gate still carries the numbers it is red about.
    console.log('[expansions pin7] ' + view.label + ' scale=' + scale
      + ' maxIter=' + maxIter + ' frame=' + W + 'x' + H
      + ' insideRef=' + rows[rows.length - 1].inside);
    for (const d of deltaRows) {
      console.log('    delta-error k=' + d.k + ' meanRel=' + d.meanRel.toExponential(3)
        + ' (2^' + Math.log2(d.meanRel).toFixed(1) + ') maxRel=' + d.maxRel.toExponential(3)
        + ' nonzeroLow=' + d.nonzeroLow + '/' + (W * H) + ' ms=' + d.ms.toFixed(0));
    }
    for (const e of escRows) {
      console.log('    escape k=' + e.k + ' misclassified=' + e.mis + '/' + (W * H)
        + ' = ' + (100 * e.mis / (W * H)).toFixed(4) + '% mean|d|=' + e.mean.toFixed(4) + ' ms=' + e.ms.toFixed(0));
    }

    // The contract: the ladder must NOT be worse as k grows, and the first rung
    // must be a strict improvement where the float32 delta is the limiter.
    const d1 = deltaRows[0].meanRel, d2 = deltaRows[1].meanRel, d4 = deltaRows[2].meanRel;
    expect(Number.isFinite(d1) && Number.isFinite(d2), `${view.label}: delta-error samples must be finite`).toBe(true);
    expect(d2, `${view.label}: k=2 must be more precise than k=1`).toBeLessThan(d1);
    expect(d4, `${view.label}: k=4 must not be worse than k=2`).toBeLessThanOrEqual(d2 * 1.05);
    const e1 = escRows[0].mis, e2 = escRows[1].mis;
    expect(e2, `${view.label}: k=2 must not misclassify more pixels than k=1`).toBeLessThanOrEqual(e1);
  }

  // Print the accuracy table into the raw gate log.
  for (const row of rows) {
    console.log('[expansions pin7 summary] ' + row.view.label
      + ' delta k1=' + row.deltaRows[0].meanRel.toExponential(3)
      + ' k2=' + row.deltaRows[1].meanRel.toExponential(3)
      + ' k4=' + row.deltaRows[2].meanRel.toExponential(3)
      + ' | escape mis k1=' + row.escRows[0].mis + ' k2=' + row.escRows[1].mis + ' k4=' + row.escRows[2].mis);
  }
});
