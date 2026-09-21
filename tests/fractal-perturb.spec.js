// @ts-check
// CPU PERTURBATION + ORBIT PORT (prototype) — `public/fractalPerturb.js`.
//
// WHY THIS SPEC EXISTS. The CPU lane cannot render deep zoom at all: it projects
// every pixel as an ABSOLUTE float64 coordinate (`public/fractalKernel.js:470-471`),
// so below ~1e-13 the coordinate staircase quantises the frame and from ~1e-16 there
// is ONE distinct coordinate (measured in `docs/PRECISION-CHAIN.md` §6: 200 distinct
// x at 1e-12 → 7 at 1e-15 → 1 at 1e-16). DECISIONS 67 calls this mechanism (c) and
// says it needs a PORT, not an optimisation. `public/fractalPerturb.js` is that port:
// it consumes `globalThis.BigOrbit` for the reference orbit and
// `globalThis.FractalKernel` for the cap, clamps and the ONE smooth-colour definition,
// and runs the same perturbation architecture the GPU lane runs (delta iteration,
// rebasing, Pauldelbrot glitch detection) in float64.
//
// THE INDEPENDENT REFERENCE. Each depth pin computes, in the page, a per-pixel DIRECT
// iteration of z² + c at high precision from the SAME exact centre string the
// prototype is given — no reference orbit, no deltas, no float32, its own fixed-point
// parser and rounder. It shares NOTHING with `public/bigOrbit.js` except the decimal
// centre, which is the DEFINITION of the view rather than a mechanism under test.
//
// THE FAILING BASELINE, IN-PIN. The same view is rendered through the SHIPPED CPU
// lane (`FractalKernel.calcFractalChunk`, the direct absolute float64 projection) and
// must fail the assertion the prototype passes — the frame the lane paints today.
//
// HONEST SCOPE. This is a PROTOTYPE (new files only). It does not touch the worker,
// the viewer or the lane dispatch; a future slice wires `calcPerturbChunk` into the
// worker. The orbit is consumed through `BigOrbit.computeOrbitFixed`, whose transport
// is the GPU's float32 words; the deltas are float64. "Genuinely arbitrary" therefore
// still needs the delta-width ladder (mechanism b) on this path too — see
// `docs/PRECISION-CHAIN.md` and the slice report.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 160, height: 120 } });

// The exact centre. `C0` is the P2 Misiurewicz point near -1.4303576324512 whose
// critical orbit stays bounded; `2^-70` is below C0's float64 ULP (~2.2e-16), so the
// float64 centre cannot name the requested point at all.
const C0 = -1.4303576324512;
const OFFSET_BITS = 70;

// --- test-side exact decimal arithmetic (independent of the app) --------------
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

async function loadPrototype(page) {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect.poll(
    () => page.evaluate(() => !!(window.__fv && window.FractalKernel && window.BigOrbit
      && window.__fv.animationSettled())),
    { timeout: 30_000 },
  ).toBe(true);
  // The prototype is a classic script with no import/export (the DECISIONS-52
  // shared-module pattern), loaded here exactly as a worker would `importScripts` it.
  await page.addScriptTag({ url: 'fractalPerturb.js' });
  await expect.poll(() => page.evaluate(() => typeof window.FractalPerturb), { timeout: 10_000 })
    .toBe('object');
  return pageErrors;
}

// One depth, one page task: the prototype frame, the SHIPPED-lane frame, and the
// independent direct-BigInt reference. Nothing paints in between.
async function measureDepth(page, scale, W = 48, H = 36) {
  return page.evaluate(({ scale, W, H, CENTRE_X, CENTRE_Y }) => {
    const K = window.FractalKernel;
    const FP = window.FractalPerturb;
    const view = {
      centerX: Number(CENTRE_X), centerY: 0, scale,
      centerXExact: CENTRE_X, centerYExact: CENTRE_Y,
    };
    const cap = K.effectiveMaxIter(512, scale);
    const bits = window.__fv.bigOrbitBitsForScale(scale);

    // --- the prototype (the port) -------------------------------------------
    FP.clearCache();
    const proto = FP.renderFrame(view, 512, W, H);

    // --- the SHIPPED CPU lane (the failing baseline): direct absolute float64 --
    const baseSmooth = new Float32Array(W * H).fill(NaN);
    const chunk = [];
    for (let i = 0; i < W * H; i++) chunk.push(i);
    K.calcFractalChunk({
      width: W, height: H, type: 'mandelbrot', maxIter: cap, view,
      params: {}, gridStep: 1, prior: null, chunk,
    }, baseSmooth);

    // --- the independent reference: direct z -> z^2 + c at high precision -----
    // Its OWN decimal parser and rounder, shared with nothing in the app.
    const F = bits + 256;
    const half = 1n << BigInt(F - 1);
    const parseDec = (str, FF) => {
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
      let num = D * (1n << BigInt(FF)), den = 1n;
      if (e10 >= 0) num *= 10n ** BigInt(e10); else den = 10n ** BigInt(-e10);
      return sign * ((num + den / 2n) / den);
    };
    const mul = (a, b) => {
      const v = a * b;
      return v >= 0n ? (v + half) >> BigInt(F) : -(((-v) + half) >> BigInt(F));
    };
    const cx = parseDec(CENTRE_X, F);
    const bail = 4n << BigInt(2 * F);
    const scale2 = Math.pow(2, -F);
    const aspect = W / H;
    const refK = new Int32Array(W * H);
    const refSmooth = new Float32Array(W * H);
    let refEscaped = 0, refMin = cap + 1, refMax = 0;
    for (let j = 0; j < H; j++) {
      const v = (j + 0.5) / H;
      const dcy = ((1 - v) - 0.5) * scale;
      const dcyF = parseDec(dcy, F);
      for (let i = 0; i < W; i++) {
        const u = (i + 0.5) / W;
        const dcx = (u - 0.5) * scale * aspect;
        const dcxF = parseDec(dcx, F);
        let x = 0n, y = 0n, n = cap + 1, z2 = 0;
        for (let k = 1; k <= cap; k++) {
          const xt = mul(x, x) - mul(y, y) + cx + dcxF;
          const yt = 2n * mul(x, y) + dcyF;
          x = xt; y = yt;
          if (x * x + y * y > bail) {
            n = k;
            const xr = Number(x) * scale2, yr = Number(y) * scale2;
            z2 = xr * xr + yr * yr;
            break;
          }
        }
        refK[j * W + i] = n;
        refSmooth[j * W + i] = n >= cap + 1 ? cap : K.smoothIterationValue(z2, n, cap);
        if (n < cap + 1) {
          refEscaped++;
          if (n < refMin) refMin = n;
          if (n > refMax) refMax = n;
        }
      }
    }

    // --- metrics --------------------------------------------------------------
    const metrics = (smooth) => {
      let mis = 0, sum = 0, max = 0;
      const cols = new Set();
      for (let k = 0; k < W * H; k++) {
        const rIn = refK[k] === cap + 1;
        const gIn = smooth[k] >= cap;
        if (rIn !== gIn) mis++;
        const d = Math.abs(refSmooth[k] - smooth[k]);
        sum += d; if (d > max) max = d;
        cols.add(Math.round(smooth[k] * 64) / 64);
      }
      return { mis: mis / (W * H), mean: sum / (W * H), max, distinct: cols.size };
    };
    return {
      scale, W, H, cap, bits,
      refEscaped, refMin, refMax,
      proto: metrics(proto.smooth),
      base: metrics(baseSmooth),
      refDistinct: (() => { const s = new Set(); for (const v of refSmooth) s.add(Math.round(v * 64) / 64); return s.size; })(),
      protoStats: {
        rebases: proto.rebases, glitches: proto.glitches, maxM: proto.maxM,
        orbitWidth: proto.orbitWidth, orbitMs: proto.orbitMs, ms: proto.ms,
        bits: proto.bits, delegated: proto.delegated,
      },
    };
  }, { scale, W, H, CENTRE_X, CENTRE_Y });
}

// --- pin 1: the port renders a deep view the shipped CPU lane cannot -----------

test('CPU-perturb pin 1: the port matches an independent direct-BigInt reference at 1e-30, 1e-40 and 1e-120, where the shipped direct-float64 CPU projection collapses', async ({ page }) => {
  const pageErrors = await loadPrototype(page);
  for (const scale of [1e-30, 1e-40, 1e-120]) {
    const out = await measureDepth(page, scale);
    console.log(`[cpu-perturb] scale=${scale} bits=${out.bits} cap=${out.cap} `
      + `refEscaped=${out.refEscaped} refRange=${out.refMin}..${out.refMax}`);
    console.log(`[cpu-perturb] PORT     mis=${out.proto.mis.toFixed(5)} mean|dS|=${out.proto.mean.toFixed(4)} `
      + `max=${out.proto.max} distinct=${out.proto.distinct}/${out.refDistinct} rebases=${out.protoStats.rebases} `
      + `glitches=${out.protoStats.glitches} maxM=${out.protoStats.maxM} orbitW=${out.protoStats.orbitWidth} ms=${out.protoStats.ms.toFixed(0)}`);
    console.log(`[cpu-perturb] BASELINE mis=${out.base.mis.toFixed(5)} mean|dS|=${out.base.mean.toFixed(3)} `
      + `max=${out.base.max} distinct=${out.base.distinct}`);

    // NON-VACUITY: a real deep frame with real escape-value variation.
    expect(out.refEscaped, 'the independent reference must contain escaped cells').toBeGreaterThan(200);
    expect(out.refMax - out.refMin, 'the reference frame must contain real escape-value variation').toBeGreaterThan(10);
    expect(out.refDistinct, 'the reference frame must not be degenerate').toBeGreaterThanOrEqual(5);
    expect(out.protoStats.delegated, 'the port must have run the perturbation lane').toBe(false);
    expect(out.protoStats.rebases, 'rebasing must actually have fired').toBeGreaterThan(0);

    // THE PIN: the port matches the independent reference.
    expect(out.proto.mis, 'port inside/outside disagreement with the reference').toBeLessThan(0.005);
    expect(out.proto.mean, 'port mean |smooth - reference smooth|').toBeLessThan(1.5);
    expect(out.proto.distinct, 'the port must keep the reference frame\'s colour structure')
      .toBeGreaterThanOrEqual(Math.ceil(out.refDistinct * 0.5));

    // THE FAILING BASELINE, in-pin: the shipped direct-float64 CPU projection at the
    // SAME view, against the SAME reference. It is the lane's own code
    // (`FractalKernel.calcFractalChunk`), not a re-derivation.
    expect(out.base.mis, 'the shipped CPU lane must be measurably wrong at this depth').toBeGreaterThan(0.01);
    expect(out.base.mean, 'and its error must dwarf the port\'s').toBeGreaterThan(50);
    expect(out.base.mean, 'the port must be better than the shipped lane by a large factor')
      .toBeGreaterThan(10 * Math.max(out.proto.mean, 1e-6));
    expect(out.base.distinct, 'the shipped lane collapses the frame to a staircase')
      .toBeLessThan(0.25 * out.refDistinct);
  }
  expect(pageErrors).toEqual([]);
});

// --- pin 2: cost, usability, and the orbit cache -------------------------------

test('CPU-perturb pin 2: the port costs a measured ms per full frame, builds ONE orbit per view, and delegates every view it cannot improve', async ({ page }) => {
  const pageErrors = await loadPrototype(page);

  const cost = await page.evaluate(({ CENTRE_X, CENTRE_Y }) => {
    const FP = window.FractalPerturb;
    const rows = [];
    for (const scale of [1e-20, 1e-30, 1e-40]) {
      for (const [W, H] of [[160, 120], [320, 240]]) {
        const view = { centerX: Number(CENTRE_X), centerY: 0, scale, centerXExact: CENTRE_X, centerYExact: CENTRE_Y };
        FP.clearCache();
        FP.renderFrame(view, 512, W, H); // warm the orbit cache
        const t0 = performance.now();
        const out = FP.renderFrame(view, 512, W, H);
        const ms = performance.now() - t0;
        rows.push({
          scale, W, H, cap: out.cap, bits: out.bits, ms,
          msPerKpx: ms / (W * H / 1000),
          orbitMs: out.orbitMs, rebases: out.rebases, maxM: out.maxM,
        });
      }
    }
    // One orbit per view: after the view is warm, two more renders add no orbit build.
    const view = { centerX: Number(CENTRE_X), centerY: 0, scale: 1e-30, centerXExact: CENTRE_X, centerYExact: CENTRE_Y };
    FP.renderFrame(view, 512, 64, 48); // build the orbit for THIS view
    const before = FP.stats().orbitsBuilt;
    FP.renderFrame(view, 512, 64, 48);
    FP.renderFrame(view, 512, 64, 48);
    const after = FP.stats().orbitsBuilt;

    // Delegation: a shallow view and a view with no exact centre must run the
    // SHIPPED kernel, byte-for-byte — the port cannot regress a view it cannot improve.
    const shallow = { centerX: -0.5, centerY: 0, scale: 1e-3, centerXExact: CENTRE_X, centerYExact: CENTRE_Y };
    const noExact = { centerX: Number(CENTRE_X), centerY: 0, scale: 1e-30 };
    const canShallow = FP.canPerturb(shallow, 'mandelbrot');
    const canNoExact = FP.canPerturb(noExact, 'mandelbrot');
    const shallowOut = FP.renderFrame(shallow, 512, 32, 24);
    const noExactOut = FP.renderFrame(noExact, 512, 32, 24);
    return {
      rows,
      cache: { before, after, grew: after - before },
      canShallow, canNoExact,
      shallowDelegated: shallowOut.delegated,
      noExactDelegated: noExactOut.delegated,
    };
  }, { CENTRE_X, CENTRE_Y });

  for (const r of cost.rows) {
    console.log(`[cpu-perturb cost] scale=${r.scale.toExponential(0)} ${r.W}x${r.H} cap=${r.cap} bits=${r.bits} `
      + `frame=${r.ms.toFixed(0)}ms (${r.msPerKpx.toFixed(2)} ms/kpx) orbitBuild=${r.orbitMs.toFixed(0)}ms `
      + `rebases=${r.rebases} maxM=${r.maxM}`);
    // A usability bound, not a benchmark: a frame must complete, not hang. Generous
    // so the pin cannot flake on a loaded host (this one runs 12 CPUs beside a gate).
    expect(r.ms, 'a full prototype frame must complete').toBeGreaterThan(0);
    expect(r.ms, 'a 320x240 prototype frame must stay under 15 s on this host').toBeLessThan(15_000);
    expect(r.maxM, 'the perturbation must not exhaust the orbit').toBeLessThan(r.cap);
  }

  // ONE orbit per (centre, budget, bits): re-rendering the same view builds nothing.
  expect(cost.cache.grew, 're-rendering one view must not rebuild the orbit').toBe(0);

  // The port never takes over a view it cannot improve.
  expect(cost.canShallow, 'a shallow view must not enter the perturbation lane').toBe(false);
  expect(cost.canNoExact, 'a view with no exact centre must not enter the perturbation lane').toBe(false);
  expect(cost.shallowDelegated, 'a shallow view must delegate to the shipped kernel').toBe(true);
  expect(cost.noExactDelegated, 'a view with no exact centre must delegate to the shipped kernel').toBe(true);

  expect(pageErrors).toEqual([]);
});
