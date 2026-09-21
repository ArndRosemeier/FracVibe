// @ts-check
// P2 / the ARBITRARY-PRECISION reference orbit — BigInt fixed point in a Worker,
// working precision growing with zoom.
//
// WHY THIS SLICE EXISTS. P1's wall is the COORDINATE, measured rather than
// assumed: a float64 view centre's own ULP near |c| ~ 0.74 is ~1.1e-16, so past
// zoom ~1e16 the requested frame sits many screen widths away from the one the
// float64 centre can name, and the float64 ITERATION of a chaotic orbit diverges
// from the true orbit by more than the frame's own scale (docs/DECISIONS.md rows
// 36-37; docs/PLAN-DEEPZOOM.md §9). The committed research
// (docs/RESEARCH-2026-09-21-arbitrary-depth.md §2) names the browser route: BigInt
// fixed point with the limb count growing with zoom, the closest analogue being
// bertbaron/mandelbrot, and no dependency needed. `public/bigOrbit.js` +
// `public/orbitWorker.js` are that route.
//
// THE PRECISION RULE. `bits ≈ log2(1/scale) + margin` (3.3219 bits per decimal
// digit; the shape is settled, the margin is not — 0 in the bare bound, +64 in
// rust-fractal-core). The margin CHOSEN here is +64 and the working precision is
// quantised UP to a multiple of 64 bits, so a precision step is a coarse,
// infrequent transition. Pin 3 holds the step itself; pin 1 measures that the
// chosen setting is sufficient.
//
// HOW THE ORBIT REACHES THE SHADER. One float32 word per component, one texel per
// iteration — P1's existing transport, unchanged. That is a MEASURED decision, not
// an assumption: at 1e-30 and 1e-40 the float32-transported BigInt orbit matches
// the fully independent reference with mean |Δ escape iteration| ≈ 1, and the
// binding wall further down is the float32 RANGE of the per-pixel coordinate
// (~1e-45, where the offset underflows float32), not the orbit's mantissa width.
// See docs/DECISIONS.md row 39.
//
// THE INDEPENDENT REFERENCE. Each depth pin computes, IN THE PAGE, a per-pixel
// DIRECT iteration of z² + c at high precision from the SAME exact centre string
// the app is given — no reference orbit, no deltas, no float32, and its own
// fixed-point parser/rounder. It therefore shares NOTHING with the GPU path (or
// with `public/bigOrbit.js`'s code) except the decimal centre, which is the
// DEFINITION of the view rather than a mechanism under test. The GPU frame is
// compared against it both as an ESCAPE INDEX (read back through the shader's own
// u_diag = 2 pass, so a palette cannot hide an iteration difference) and as a
// palette colour.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 160, height: 120 } });

// The exact centre. `C0` is a real Misiurewicz point near -1.4303576324512 whose
// critical orbit stays bounded (so the reference orbit is a valid frame for every
// pixel and never needs the reference-escape handling), and whose neighbourhood is
// a self-similar dendrite at every scale — the frame stays structured however deep
// the zoom goes. `2^-70` is BELOW C0's float64 ULP (~2.2e-16), so the float64
// centre cannot name the requested point at all: that is exactly P1's wall, and
// the pin's baseline arm renders through it.
const C0 = -1.4303576324512;
const OFFSET_BITS = 70;

// --- test-side exact decimal arithmetic (independent of the app) --------------
// A float64 has an exact finite decimal expansion; 2^-70 is an exact decimal too.
// Their SUM is what the view centre is, to arbitrary precision.
function exactDecimal(x) {
  const sign = x < 0 ? '-' : '';
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, Math.abs(x));
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (exp === 0) { e = -1074; } else { m |= (1n << 52n); e = exp - 1075; }
  if (e >= 0) return sign + (m << BigInt(e)).toString();
  const d = -e;
  const num = m * (5n ** BigInt(d));
  let s = num.toString().padStart(d + 1, '0');
  const intPart = s.slice(0, s.length - d);
  const frac = s.slice(s.length - d).replace(/0+$/, '');
  return sign + intPart + (frac ? '.' + frac : '');
}
function parseDecimalFixed(str, F) {
  let s = String(str).trim();
  let sign = 1n;
  if (s[0] === '-') { sign = -1n; s = s.slice(1); }
  const parts = s.split(/[eE]/);
  const exp = parts[1] ? parseInt(parts[1], 10) : 0;
  const mant = parts[0];
  const dot = mant.indexOf('.');
  const ip = dot < 0 ? mant : mant.slice(0, dot);
  const fp = dot < 0 ? '' : mant.slice(dot + 1);
  const D = BigInt((ip || '0') + fp);
  const e10 = exp - fp.length;
  let num = D * (1n << BigInt(F)), den = 1n;
  if (e10 >= 0) num *= 10n ** BigInt(e10); else den = 10n ** BigInt(-e10);
  return sign * ((num + den / 2n) / den);
}
function fixedToDecimal(X, F) {
  const neg = X < 0n;
  const a = neg ? -X : X;
  const ip = a >> BigInt(F);
  const frac = a & ((1n << BigInt(F)) - 1n);
  if (frac === 0n) return (neg ? '-' : '') + ip.toString();
  const digits = (frac * (5n ** BigInt(F))).toString().padStart(F, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + ip.toString() + '.' + digits;
}
const CENTRE_F = 640;
const CENTRE_X = fixedToDecimal(
  parseDecimalFixed(exactDecimal(C0), CENTRE_F) + (1n << BigInt(CENTRE_F - OFFSET_BITS)),
  CENTRE_F,
);
const CENTRE_Y = '0';
// A second exact centre one bit farther out, for the "a centre change rebuilds"
// half of pin 2.
const CENTRE_X2 = fixedToDecimal(
  parseDecimalFixed(exactDecimal(C0), CENTRE_F) + (1n << BigInt(CENTRE_F - OFFSET_BITS + 1)),
  CENTRE_F,
);

const DEPTH_SCALE = 1e-30; // past P1's ~1e16 wall by 14 orders of magnitude
const STEP_SCALE = 1e-20;  // sits on the 128 -> 192 bit precision step

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderSource()), { timeout: 10_000 })
    .not.toBe(null);
}

// Drive the REAL deep-view path with an exact decimal centre and wait for the
// Worker's orbit to be uploaded (the ready callback re-renders on its own).
async function setExactDeepView(page, { centerX = CENTRE_X, centerY = CENTRE_Y, scale = DEPTH_SCALE, bits = 0 } = {}) {
  const wanted = await page.evaluate(({ scale, bits }) => {
    // The precision the view will actually run at: the explicit override when one
    // is given, otherwise the RULE. Waiting on the rule (not on "some orbit
    // exists") is what makes a step-crossing wait for the NEW orbit.
    return bits > 0 ? bits : window.__fv.bigOrbitBitsForScale(scale);
  }, { scale, bits });
  await page.evaluate(({ centerX, centerY, scale, bits }) => {
    window.__fv.setBigOrbitBits(bits);
    window.__fv.setOrbitMode('bigint');
    const numericX = Number(centerX);
    window.__fv.setDeepView({ centerX: numericX, centerY: Number(centerY), scale, centerXExact: centerX, centerYExact: centerY });
  }, { centerX, centerY, scale, bits });
  // Wait for the orbit of THIS exact centre at THIS precision: a stale orbit
  // from another centre at the same bit count must not satisfy the wait.
  await expect
    .poll(() => page.evaluate(({ wanted, centerX }) => {
      const info = window.__fv.bigOrbitInfo();
      return !!(info && info.mode === 'bigint' && info.bits === wanted
        && info.key.indexOf(centerX + '|') === 0);
    }, { wanted, centerX }), { timeout: 30_000 })
    .toBe(true);
}

// The BIG page-side measurement. Arms are compared against ONE independent
// direct-iteration reference, in ONE page task, so no paint can interleave.
async function measureArms(page) {
  return page.evaluate(() => {
    const fv = window.__fv;
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
    const gl = canvas.getContext('webgl');
    const W = canvas.width, H = canvas.height;
    const view = fv.getView();
    const cap = fv.maxIter();
    const aspect = W / H;
    const bits = fv.bigOrbitBitsForScale(view.scale);

    const readColour = () => {
      const buf = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };

    // --- arm A: the shipped BigInt orbit -------------------------------------
    fv.renderWebGL();
    const colourA = readColour();
    const srcA = fv.orbitSource();
    const diagA = fv.orbitFrame().n;
    const infoA = fv.bigOrbitInfo();

    // --- arm B: P1's float64 orbit of the ROUNDED centre (the wall) ----------
    fv.setOrbitMode('float64');
    fv.invalidateOrbit();
    fv.renderWebGL();
    const colourB = readColour();
    const srcB = fv.orbitSource();
    const diagB = fv.orbitFrame().n;
    fv.setOrbitMode('bigint');

    // --- the independent reference -------------------------------------------
    // Direct z -> z^2 + c per pixel at Fref bits, its OWN parser and rounder.
    const Fref = bits + 256;
    const parseDec = (str, F) => {
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
      let num = D * (1n << BigInt(F)), den = 1n;
      if (e10 >= 0) num *= 10n ** BigInt(e10); else den = 10n ** BigInt(-e10);
      return sign * ((num + den / 2n) / den);
    };
    const half = 1n << BigInt(Fref - 1);
    const mul = (a, b) => {
      const v = a * b;
      return v >= 0n ? (v + half) >> BigInt(Fref) : -(((-v) + half) >> BigInt(Fref));
    };
    const cx = parseDec(view.centerXExact, Fref);
    const cy = parseDec(view.centerYExact, Fref);
    const bail = 4n << BigInt(2 * Fref);
    const scale2 = Math.pow(2, -Fref);

    const refN = new Int32Array(W * H);
    const refSmooth = new Float32Array(W * H);
    let refEscaped = 0, refMin = cap + 1, refMax = 0;
    for (let j = 0; j < H; j++) {
      const v = (j + 0.5) / H;
      const ddy = ((1 - v) - 0.5) * view.scale;
      const ddyF = parseDec(String(ddy), Fref);
      for (let i = 0; i < W; i++) {
        const u = (i + 0.5) / W;
        const dcx = (u - 0.5) * view.scale * aspect;
        const dcxF = parseDec(String(dcx), Fref);
        let x = 0n, y = 0n, n = cap + 1, z2 = 0;
        for (let k = 1; k <= cap; k++) {
          const xt = mul(x, x) - mul(y, y) + cx + dcxF;
          const yt = 2n * mul(x, y) + cy + ddyF;
          x = xt; y = yt;
          if (x * x + y * y > bail) {
            n = k;
            const xr = Number(x) * scale2, yr = Number(y) * scale2;
            z2 = xr * xr + yr * yr;
            break;
          }
        }
        const idx = j * W + i;
        refN[idx] = n;
        refSmooth[idx] = n >= cap + 1 ? cap : fv.smoothValue(z2, n, cap);
        if (n < cap + 1) {
          refEscaped++;
          if (n < refMin) refMin = n;
          if (n > refMax) refMax = n;
        }
      }
    }

    // --- metrics -------------------------------------------------------------
    const metrics = (colour, diag, src) => {
      let mis = 0, sumAbs = 0, maxDi = 0, sumDi = 0, big = 0;
      const mask = new Uint8Array(W * H);
      const refCols = new Set(), gpuCols = new Set();
      const refInside = (k) => refN[k] === cap + 1;
      const gpuInside = (k) => diag[k] === cap + 1;
      for (let k = 0; k < W * H; k++) {
        const rIn = refInside(k), gIn = gpuInside(k);
        if (rIn !== gIn) mis++;
        const d = Math.abs(refN[k] - diag[k]);
        sumDi += d; if (d > maxDi) maxDi = d;
        const want = fv.colorForValue(refSmooth[k], cap);
        const kk = k * 4;
        const got = [colour[kk], colour[kk + 1], colour[kk + 2]];
        const cd = Math.max(Math.abs(want[0] - got[0]), Math.abs(want[1] - got[1]), Math.abs(want[2] - got[2]));
        sumAbs += (Math.abs(want[0] - got[0]) + Math.abs(want[1] - got[1]) + Math.abs(want[2] - got[2])) / 3;
        if (cd > 32) { big++; mask[k] = 1; }
        refCols.add((want[0] << 16) | (want[1] << 8) | want[2]);
        gpuCols.add((got[0] << 16) | (got[1] << 8) | got[2]);
      }
      const seen = new Uint8Array(W * H);
      const stack = new Int32Array(W * H);
      let largest = 0;
      for (let k = 0; k < W * H; k++) {
        if (!mask[k] || seen[k]) continue;
        let sp = 0; stack[sp++] = k; seen[k] = 1; let size = 0;
        while (sp > 0) {
          const q = stack[--sp]; size++;
          const x = q % W, y = (q / W) | 0;
          if (x > 0 && mask[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack[sp++] = q - 1; }
          if (x < W - 1 && mask[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack[sp++] = q + 1; }
          if (y > 0 && mask[q - W] && !seen[q - W]) { seen[q - W] = 1; stack[sp++] = q - W; }
          if (y < H - 1 && mask[q + W] && !seen[q + W]) { seen[q + W] = 1; stack[sp++] = q + W; }
        }
        if (size > largest) largest = size;
      }
      return {
        source: src, w: W, h: H, cap, bits,
        misFrac: mis / (W * H), meanAbs: sumAbs / (W * H),
        meanDi: sumDi / (W * H), maxDi,
        bigFrac: big / (W * H), largestComp: largest,
        distinctRef: refCols.size, distinctGpu: gpuCols.size,
      };
    };
    return {
      view: { scale: view.scale, centerX: view.centerX, centerXExact: view.centerXExact },
      bits, refEscaped, refMin, refMax, orbitW: fv.bigOrbitInfo() ? fv.bigOrbitInfo().width : 0,
      bigIntInfo: infoA, secondInfo: fv.bigOrbitInfo(),
      armA: metrics(colourA, diagA, srcA),
      armB: metrics(colourB, diagB, srcB),
      // the pre-P1 float32 absolute X coordinate on this view: how many distinct
      // values it takes. At this depth the requested offset is below the centre's
      // own ULP, so the float32 coordinate cannot name the frame at all.
      f32XCount: (() => {
        const s = new Set();
        for (let i = 0; i < W; i++) {
          const u = (i + 0.5) / W;
          s.add(Math.fround(Math.fround(view.centerX) + Math.fround(Math.fround((u - 0.5) * Math.fround(view.scale)) * Math.fround(aspect))));
        }
        return s.size;
      })(),
    };
  });
}

// --- pin 1: depth past the P1 wall -------------------------------------------------

test('P2 pin 1: at 1e-30 an exact centre past the float64 ULP matches an independent BigInt reference, where P1\'s float64 orbit does not', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  await setExactDeepView(page, { scale: DEPTH_SCALE });
  const out = await measureArms(page);
  console.log(`[P2 pin1] ${out.armA.w}x${out.armA.h} scale=${out.view.scale} bits=${out.bits} orbitW=${out.orbitW} ` +
    `refEscaped=${out.refEscaped} refRange=${out.refMin}..${out.refMax} f32X=${out.f32XCount}`);
  console.log(`[P2 pin1] arm A (bigint)  src=${out.armA.source} mis=${out.armA.misFrac.toFixed(5)} ` +
    `mean|dn|=${out.armA.meanDi.toFixed(3)} max=${out.armA.maxDi} meanAbs=${out.armA.meanAbs.toFixed(3)} ` +
    `blob=${out.armA.largestComp} cols=${out.armA.distinctRef}/${out.armA.distinctGpu}`);
  console.log(`[P2 pin1] arm B (float64) src=${out.armB.source} mis=${out.armB.misFrac.toFixed(5)} ` +
    `mean|dn|=${out.armB.meanDi.toFixed(3)} max=${out.armB.maxDi} meanAbs=${out.armB.meanAbs.toFixed(3)} ` +
    `blob=${out.armB.largestComp} cols=${out.armB.distinctRef}/${out.armB.distinctGpu}`);

  // NON-VACUITY. A real deep frame, a real reference with escaped cells, and the
  // precision the RULE chose (not a number the test restated).
  expect(out.armA.source, 'the BigInt orbit lane must have drawn').toBe('bigint');
  expect(out.bigIntInfo, 'a BigInt orbit must be held').not.toBe(null);
  expect(out.bigIntInfo.bits, 'the working precision is the scale-derived rule').toBe(out.bits);
  expect(out.bits, 'the precision must have grown with the zoom').toBeGreaterThan(128);
  expect(out.refEscaped, 'the independent reference must contain escaped cells').toBeGreaterThan(2000);
  expect(out.refMax - out.refMin, 'the reference frame must contain real escape-value variation')
    .toBeGreaterThan(20);
  expect(out.armA.distinctRef, 'the reference frame must not be degenerate').toBeGreaterThanOrEqual(5);
  // P1's wall, shown: the exact centre the view is given is BELOW the float64
  // centre's own ULP, so `Number()` of the exact centre loses it entirely, and the
  // pre-P1 float32 absolute X coordinate takes a single value.
  expect(Number(CENTRE_X), 'the exact centre is unnameable in float64').toBe(C0);
  expect(out.f32XCount, 'the float32 absolute coordinate must collapse at this scale').toBe(1);

  // THE PIN: the shipped lane matches the independent direct-BigInt reference.
  // Measured on this host at 160x120: mis 0.00000, mean |dn| 0.007, worst 23 (a
  // single chaotic boundary pixel, where the float32 DELTA arithmetic — a
  // different mechanism, measured in docs/DECISIONS.md row 37 — is the limit).
  expect(out.armA.misFrac, 'inside/outside disagreement with the independent reference').toBeLessThan(0.005);
  expect(out.armA.meanDi, 'mean |GPU escape index - independent reference| (iterations)').toBeLessThan(3);
  expect(out.armA.maxDi, 'worst per-pixel escape-index error (float32 delta arithmetic at one chaotic pixel)')
    .toBeLessThanOrEqual(40);
  expect(out.armA.meanAbs, 'mean per-channel |GPU colour - reference colour| (0-255)').toBeLessThan(1.5);
  expect(out.armA.largestComp, 'largest connected blob differing by more than 32').toBeLessThanOrEqual(8);
  expect(out.armA.distinctGpu, 'the BigInt lane must keep the reference frame\'s colour structure')
    .toBeGreaterThanOrEqual(Math.ceil(out.armA.distinctRef * 0.5));

  // THE FAILING BASELINE, in-pin: the same view through P1's float64 orbit of the
  // ROUNDED centre is measurably further from the SAME independent reference, by
  // more than a factor of two. If the BigInt orbit were not the mechanism, this
  // assertion would not separate the arms.
  expect(out.armB.source, 'the baseline arm must be the float64 orbit').toBe('float64');
  expect(out.armB.meanDi, 'the float64 baseline must be measurably worse than the BigInt orbit')
    .toBeGreaterThan(2 * out.armA.meanDi);
  expect(out.armB.meanDi, 'the float64 baseline must fail the pin\'s own threshold').toBeGreaterThan(3);

  expect(pageErrors).toEqual([]);
});

// --- pin 2: the orbit is computed once per view, counted ---------------------------

test('P2 pin 2: the arbitrary-precision orbit is built once per (exact centre, budget, precision), in one long-lived Worker', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  await setExactDeepView(page, { scale: DEPTH_SCALE });
  const first = await page.evaluate(() => ({
    requests: window.__fv.bigOrbitRequests(),
    builds: window.__fv.bigOrbitComputations(),
    spawns: window.__fv.bigOrbitWorkerSpawns(),
    info: window.__fv.bigOrbitInfo(),
    cap: window.__fv.maxIter(),
  }));
  // NON-VACUITY: a real Worker really built a real orbit at the RULE's precision.
  expect(first.requests, 'a deep exact view must request an orbit').toBeGreaterThan(0);
  expect(first.builds, 'and the Worker must have completed it').toBeGreaterThan(0);
  expect(first.spawns, 'exactly ONE long-lived Worker, not one per view').toBe(1);
  expect(first.info, 'the orbit must be observable').not.toBe(null);
  expect(first.info.bits).toBe(await page.evaluate((s) => window.__fv.bigOrbitBitsForScale(s), DEPTH_SCALE));
  expect(first.info.width).toBe(Math.min(first.cap + 1, 8192));

  // Five re-draws of the SAME view build NOTHING — counted, not inferred.
  const repeated = await page.evaluate(() => {
    const before = { r: window.__fv.bigOrbitRequests(), b: window.__fv.bigOrbitComputations() };
    for (let i = 0; i < 5; i++) window.__fv.renderWebGL();
    return { before, after: { r: window.__fv.bigOrbitRequests(), b: window.__fv.bigOrbitComputations() } };
  });
  expect(repeated.after.r - repeated.before.r, 're-drawing one view must not re-request the orbit').toBe(0);
  expect(repeated.after.b - repeated.before.b, 're-drawing one view must not rebuild the orbit').toBe(0);

  // A CENTRE change builds exactly one more.
  const moved = await page.evaluate(({ centerX, centerY, scale }) => {
    const before = window.__fv.bigOrbitComputations();
    window.__fv.setDeepView({ centerX: Number(centerX), centerY: 0, scale, centerXExact: centerX, centerYExact: centerY });
    return { before, requests: window.__fv.bigOrbitRequests() };
  }, { centerX: CENTRE_X2, centerY: CENTRE_Y, scale: DEPTH_SCALE });
  await expect.poll(() => page.evaluate(() => window.__fv.bigOrbitComputations()), { timeout: 30_000 })
    .toBe(moved.before + 1);

  // A SCALE change that stays inside the same precision STEP reuses the orbit:
  // the reference is a function of (centre, budget, bits), so the key must not
  // include the scale itself — otherwise every zoom nudge would recompute. The
  // centre-X orbit is awaited first so the build counters below are deterministic.
  await setExactDeepView(page, { centerX: CENTRE_X, scale: DEPTH_SCALE });
  const sameStep = await page.evaluate(({ centerX, centerY, scale }) => {
    const before = window.__fv.bigOrbitComputations();
    window.__fv.setDeepView({ centerX: Number(centerX), centerY: 0, scale: scale * 3, centerXExact: centerX, centerYExact: centerY });
    return { before, after: window.__fv.bigOrbitComputations(), b0: window.__fv.bigOrbitBitsForScale(scale), b1: window.__fv.bigOrbitBitsForScale(scale * 3) };
  }, { centerX: CENTRE_X, centerY: CENTRE_Y, scale: DEPTH_SCALE });
  expect(sameStep.b0, 'the two scales are on the same precision step').toBe(sameStep.b1);
  expect(sameStep.after - sameStep.before, 'a scale change inside one precision step must reuse the orbit').toBe(0);

  // A PRECISION change (a scale crossing a step) builds exactly one more.
  const prevBuilds = await page.evaluate(() => window.__fv.bigOrbitComputations());
  await setExactDeepView(page, { scale: 1e-39 });
  const afterStep = await page.evaluate(() => window.__fv.bigOrbitComputations());
  expect(afterStep, 'crossing a precision step must rebuild the orbit exactly once').toBe(prevBuilds + 1);
  const stepInfo = await page.evaluate(() => window.__fv.bigOrbitInfo());
  expect(stepInfo.bits, 'the rebuild is at the next precision step').toBe(256);

  expect(pageErrors).toEqual([]);
});

// --- pin 3: a precision step is invisible ------------------------------------------

test('P2 pin 3: crossing the precision step changes nothing visible, where a transition-corrupted centre jumps', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  // The step is REAL: the rule puts 128 bits above it and 192 below. The step is
  // chosen at 1e-20 — inside float32's NORMAL range — because a scale below
  // float32's smallest normal (~1.2e-38) collapses the frame on this host
  // regardless of precision (measured: a structured frame at 5e-38, one value at
  // 2e-38). That wall is this slice's measured ceiling and is recorded in
  // docs/DECISIONS.md; it is a RANGE wall, not an orbit-precision one.
  const rule = await page.evaluate(() => ({
    above: window.__fv.bigOrbitBitsForScale(1e-19),
    below: window.__fv.bigOrbitBitsForScale(1e-20),
    step: window.__fv.bigOrbitStepBits,
  }));
  console.log(`[P2 pin3] rule: 1e-19 -> ${rule.above} bits, 1e-20 -> ${rule.below} bits (step ${rule.step})`);
  expect(rule.above, 'the step boundary must really be between these scales').toBe(128);
  expect(rule.below, 'and the next step must really be 192').toBe(192);

  // ONE fixed view, the two sides of that step, through the REAL Worker path.
  await setExactDeepView(page, { scale: STEP_SCALE, bits: 128 });
  const low = await page.evaluate(() => {
    window.__fv.renderWebGL();
    const c = document.getElementById('fractalCanvasWebGL');
    const gl = c.getContext('webgl');
    const buf = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { colour: Array.from(buf), n: Array.from(window.__fv.orbitFrame().n), info: window.__fv.bigOrbitInfo() };
  });
  await setExactDeepView(page, { scale: STEP_SCALE, bits: 192 });
  const high = await page.evaluate(() => {
    window.__fv.renderWebGL();
    const c = document.getElementById('fractalCanvasWebGL');
    const gl = c.getContext('webgl');
    const buf = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { colour: Array.from(buf), n: Array.from(window.__fv.orbitFrame().n), info: window.__fv.bigOrbitInfo() };
  });
  // NON-VACUITY: the two arms really ran at the two precisions.
  expect(low.info.bits, 'the low arm must have run at 128 bits').toBe(128);
  expect(high.info.bits, 'the high arm must have run at 192 bits').toBe(192);

  const diff = (a, b, stride) => {
    let sum = 0, max = 0, differing = 0;
    for (let i = 0; i < a.length / stride; i++) {
      let d = 0;
      for (let k = 0; k < stride; k++) d = Math.max(d, Math.abs(a[i * stride + k] - b[i * stride + k]));
      sum += d; if (d > max) max = d; if (d > 0) differing++;
    }
    return { mean: sum / (a.length / stride), max, differingFrac: differing / (a.length / stride) };
  };
  const stepColour = diff(low.colour, high.colour, 4);
  const stepN = diff(low.n, high.n, 1);
  console.log(`[P2 pin3] shipped step 128->192: colour mean=${stepColour.mean.toFixed(4)} max=${stepColour.max} ` +
    `escIndex mean=${stepN.mean.toFixed(4)} max=${stepN.max}`);

  // THE PIN: the precision step changes NOTHING. The transported orbit is float32,
  // and a 2^-128 vs 2^-192 difference is far below its 2^-24 resolution, so the
  // GPU output must be identical — not merely close.
  expect(stepN.mean, 'the escape index must not move across a precision step').toBeLessThan(0.5);
  expect(stepN.max, 'no pixel may move by a whole iteration across a precision step').toBeLessThanOrEqual(1);
  expect(stepColour.mean, 'the colour must not move across a precision step').toBeLessThan(0.5);
  expect(stepColour.max, 'no pixel may change colour across a precision step').toBeLessThanOrEqual(1);

  // THE FAILING BASELINE, in-pin: the documented defect class here is Kalles
  // Fraktaler 2.13.10 (2018), "corrupt image at transition between number types".
  // Inject exactly that — the higher-precision side parses its centre at a COARSER
  // number type (32 bits), so the transition shifts the coordinate — and show the
  // SAME comparison goes RED. (Default-off; reset immediately after.)
  await setExactDeepView(page, { scale: STEP_SCALE, bits: 192 });
  const corrupt = await page.evaluate(() => {
    window.__fv.setBigOrbitControl(160);
    return true;
  });
  expect(corrupt).toBe(true);
  await setExactDeepView(page, { scale: STEP_SCALE, bits: 192 });
  const bad = await page.evaluate(() => {
    const out = { n: Array.from(window.__fv.orbitFrame().n), info: window.__fv.bigOrbitInfo() };
    window.__fv.setBigOrbitControl(0);
    return out;
  });
  expect(bad.info.bits, 'the corrupted arm really ran at the step precision').toBe(192);
  expect(bad.info.control, 'the corruption really reached the Worker').toBe(160);
  const corruptDiff = diff(high.n, bad.n, 1);
  console.log(`[P2 pin3] control (transition-corrupted centre): escIndex mean=${corruptDiff.mean.toFixed(2)} ` +
    `max=${corruptDiff.max} differing=${(corruptDiff.differingFrac * 100).toFixed(1)}%`);
  expect(corruptDiff.mean, 'the injected transition corruption must actually change the frame').toBeGreaterThan(1);
  expect(corruptDiff.differingFrac, 'and it must change a visible population of pixels').toBeGreaterThan(0.05);
  expect(await page.evaluate(() => window.__fv.bigOrbitControl()), 'the control must be reset').toBe(0);

  expect(pageErrors).toEqual([]);
});
