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

function compileProgram(gl, fragSrc) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, VERT_SRC);
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
      ok('FEATURE GATES', 'max_vertex_texture_units', maxVtu + ' (MAX_VERTEX_TEXTURE_IMAGE_UNITS)');
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
              const value = 'scale=' + FLOAT_DEEP_SCALE + ' src=' + src + ' cap=' + cap
                + ' sampled=' + count + ' refEscaped=' + refEscaped
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
                const grid = sampleGrid(w, h, 240);
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
                const value = 'scale=' + BIGINT_SCALE + ' src=' + src + ' bits=' + bits + ' cap=' + cap
                  + ' orbitW=' + (info ? info.width : '?')
                  + ' sampled=' + count + ' refEscaped=' + refEscaped
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

          // (4) cost at three depths, through the real render path.
          for (const step of COST_STEPS) {
            const id = step.id;
            try {
              fv.setDeepView({ centerX: FLOAT_DEEP_X, centerY: FLOAT_DEEP_Y, scale: step.scale });
              const passesBefore = fv.fullImagePasses ? fv.fullImagePasses() : null;
              fv.renderWebGL();
              const ms = fv.renderTimeMs();
              const passesAfter = fv.fullImagePasses ? fv.fullImagePasses() : null;
              const src = fv.orbitSource();
              deepSources.push(src);
              const passes = (passesBefore !== null && passesAfter !== null) ? (passesAfter - passesBefore) : '?';
              const value = ms.toFixed(1) + ' ms (scale=' + step.scale + ' cap=' + fv.maxIter() + ' lane=' + src + ' passes=' + passes + ')';
              if (typeof ms === 'number' && isFinite(ms) && ms >= 0) deepOk(id, value);
              else deepFail(id, 'renderTimeMs() is not a finite number: ' + value);
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
