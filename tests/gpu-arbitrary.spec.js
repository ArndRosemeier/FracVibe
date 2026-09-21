// @ts-check
// GPU-ARBITRARY — the delta-coordinate RANGE, the render-time readout, and the
// GPU-only invariant.
//
// WHY THIS SLICE EXISTS. P2 built an arbitrary-precision BigInt reference orbit
// and measured its own ceiling precisely: the ORBIT was correct to 1e-30 and the
// transport was sufficient, but the real shader collapsed to ONE COLOUR at ~2e-38
// (docs/DECISIONS.md row 42). That wall is not a library limit and not a missing
// package — it is one float32 UNIFORM. The shader seeded its per-pixel delta as
//
//     float dcx = (v_uv.x - 0.5) * u_scale * u_aspect;
//
// and `u_scale` is float32, so past ~2e-38 the product is subnormal and every
// pixel lands on the reference point BEFORE any rebasing or rescaling can act.
//
// THE FIX. The delta only ever needs to be SMALL, never WIDE. The deep lane now
// seeds it in float32's NORMAL range and carries the scale's exponent in the
// rescaled representation's own `S`:
//
//     u_scale      <- scale * 2^shift   (a normal float32)
//     u_scaleShift <- shift             (folded into S = exp2(-shift))
//
// so `S * dc` is EXACTLY the physical offset the old code computed, while neither
// the seeded delta nor S is ever subnormal. Nothing else about the algorithm
// changed: rebasing, the glitch detector and the S-normalisation are untouched.
//
// THE REFERENCE. As in tests/bigorbit.spec.js, each depth pin computes IN THE PAGE
// a per-pixel DIRECT iteration of z^2 + c in BigInt fixed point from the SAME exact
// centre string the app is given — no reference orbit, no deltas, no float32, and
// its own parser. It shares NOTHING with the GPU path except the decimal centre,
// which is the DEFINITION of the view rather than a mechanism under test.
//
// THE FAILING BASELINE IS IN-PIN. `__fv.setLegacyDeltaSeed(true)` draws the SAME
// view through the SAME program with the PRE-FIX seed (`* u_scale`, S = 1), so the
// collapse is measured rather than asserted from a story about the old code.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 64, height: 48 } });

// The exact centre: a Misiurewicz point near -1.4303576324512 whose critical orbit
// stays bounded at every scale, so the frame is a self-similar dendrite and stays
// structured however deep the zoom goes. `2^-70` is below C0's float64 ULP, so the
// float64 centre cannot name it — that is the wall P2 removed.
const C0 = -1.4303576324512;
const OFFSET_BITS = 70;

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
  const s = num.toString().padStart(d + 1, '0');
  const frac = s.slice(s.length - d).replace(/0+$/, '');
  return sign + s.slice(0, s.length - d) + (frac ? '.' + frac : '');
}
function parseDecimalFixed(str, F) {
  let s = String(str).trim();
  let sign = 1n;
  if (s[0] === '-') { sign = -1n; s = s.slice(1); }
  const parts = s.split(/[eE]/);
  const exp = parts[1] ? parseInt(parts[1], 10) : 0;
  const dot = parts[0].indexOf('.');
  const ip = dot < 0 ? parts[0] : parts[0].slice(0, dot);
  const fp = dot < 0 ? '' : parts[0].slice(dot + 1);
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

// The depth this slice is REQUIRED to reach, and one shallower control.
const DEEP_SCALE = 1e-40;
const SHALLOW_DEEP_SCALE = 1e-30;

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderSource()), { timeout: 10_000 })
    .not.toBe(null);
}

// Drive the REAL deep-view path with an exact decimal centre and wait for the
// Worker's orbit at the precision the RULE chose for this scale.
async function setExactDeepView(page, { centerX = CENTRE_X, centerY = CENTRE_Y, scale }) {
  const bits = await page.evaluate((s) => window.__fv.bigOrbitBitsForScale(s), scale);
  await page.evaluate(({ centerX, centerY, scale, bits }) => {
    window.__fv.setBigOrbitBits(0);          // the rule, not an override
    window.__fv.setOrbitMode('bigint');
    window.__fv.setDeepView({
      centerX: Number(centerX), centerY: Number(centerY), scale,
      centerXExact: centerX, centerYExact: centerY,
    });
  }, { centerX, centerY, scale, bits });
  await expect.poll(() => page.evaluate(({ wanted, centerX }) => {
    const info = window.__fv.bigOrbitInfo();
    return !!(info && info.mode === 'bigint' && info.bits === wanted
      && info.key.indexOf(centerX + '|') === 0);
  }, { wanted: bits, centerX }), { timeout: 60_000 }).toBe(true);
  return bits;
}

// Draw one frame and read back BOTH the shader's own escape index (u_diag = 2) and
// the palette colour, then compare against the independent BigInt reference.
async function measureAgainstReference(page, { legacy }) {
  return page.evaluate((legacy) => {
    const fv = window.__fv;
    fv.setLegacyDeltaSeed(legacy);
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
    const gl = canvas.getContext('webgl');
    const W = canvas.width, H = canvas.height;
    const view = fv.getView();
    const cap = fv.maxIter();
    const aspect = W / H;
    const bits = fv.bigOrbitBitsForScale(view.scale);
    const seed = fv.deepSeed();
    const passesBefore = fv.fullImagePasses();
    fv.renderWebGL();
    const passesAfter = fv.fullImagePasses();
    const colour = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, colour);
    const gpuN = Array.from(fv.orbitFrame().n);
    const source = fv.orbitSource();
    fv.setLegacyDeltaSeed(false);

    // --- the independent reference (its own parser, its own rounding) ---------
    const Fref = bits + 192;
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
    const refN = new Int32Array(W * H);
    let refEscaped = 0, refMin = cap + 1, refMax = 0;
    for (let j = 0; j < H; j++) {
      const ddyF = parseDec(String(((1 - ((j + 0.5) / H)) - 0.5) * view.scale), Fref);
      for (let i = 0; i < W; i++) {
        const dcxF = parseDec(String((((i + 0.5) / W) - 0.5) * view.scale * aspect), Fref);
        let x = 0n, y = 0n, n = cap + 1;
        for (let k = 1; k <= cap; k++) {
          const xt = mul(x, x) - mul(y, y) + cx + dcxF;
          const yt = 2n * mul(x, y) + cy + ddyF;
          x = xt; y = yt;
          if (x * x + y * y > bail) { n = k; break; }
        }
        refN[j * W + i] = n;
        if (n < cap + 1) { refEscaped++; if (n < refMin) refMin = n; if (n > refMax) refMax = n; }
      }
    }

    let mis = 0, sumAbs = 0, maxAbs = 0, sumDi = 0, maxDi = 0;
    const refCols = new Set(), gpuCols = new Set(), gpuIdx = new Set();
    for (let k = 0; k < W * H; k++) {
      const rIn = refN[k] === cap + 1, gIn = gpuN[k] === cap + 1;
      if (rIn !== gIn) mis++;
      const d = Math.abs(refN[k] - gpuN[k]);
      sumDi += d; if (d > maxDi) maxDi = d;
      const kk = k * 4;
      gpuIdx.add(gpuN[k]);
      refCols.add(refN[k]); gpuCols.add((colour[kk] << 16) | (colour[kk + 1] << 8) | colour[kk + 2]);
    }
    return {
      scale: view.scale, cap, bits, source, seed, legacy,
      fullImagePasses: passesAfter - passesBefore,
      reportedMs: fv.renderTimeMs(), readout: fv.renderTimeText(),
      misFrac: mis / (W * H), meanDi: sumDi / (W * H), maxDi,
      meanAbs: sumAbs, refEscaped, refMin, refMax,
      refDistinct: new Set(Array.from(refN)).size,
      gpuDistinct: gpuIdx.size,
      refColours: refCols.size, gpuColours: gpuCols.size,
    };
  }, legacy);
}

// --- pin 4: NO REGRESSION — the shallow lane is byte-for-byte identical ----------
//
// The owner's binding constraint is NO REGRESSION, and the trap here is specific:
// the exponent work added a uniform and changed the deep lane's coordinate
// expression. Every view at or above `ITER_BUDGET_MIN_SCALE` (1e-4) uses the plain
// lane, which is reached through the SAME shader program — so a silent shift in the
// shared uniform plumbing would change ordinary pixels with nothing failing.
//
// These hashes were captured from the PRISTINE pre-change build (base `ab59aaa`,
// `public/` restored by `git stash`) through THIS EXACT readback — same viewport,
// same centre, same `setDeepView` + `renderWebGL` + `readPixels` sequence — and the
// changed build reproduces all four EXACTLY. FNV-1a over the raw RGBA readback is
// sensitive to a single-bit change in any channel of any pixel, and the sequence is
// deterministic: two consecutive pre-fix captures produced byte-identical hashes.
const SHALLOW_GOLDEN = [
  { name: 'default',       scale: 3,        hash: 410787103,  colours: 82 },
  { name: 'atLaneKnee',    scale: 1e-4,     hash: 2918588311, colours: 479 },
  { name: 'belowOldWall',  scale: 1e-8,     hash: 3933966953, colours: 131 },
  { name: 'justAboveKnee', scale: 1.05e-4,  hash: 180559335,  colours: 466 },
];

test('GPU-ARBITRARY pin 4 (NO-REGRESSION): the shallow lane renders byte-identical pixels, before and after the exponent change', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  const out = await page.evaluate(() => {
    const fv = window.__fv;
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
    const gl = canvas.getContext('webgl');
    const centre = { centerX: -0.743643887037151, centerY: 0.13182590420533 };
    const scales = [3, 1e-4, 1e-8, 1.05e-4];
    const res = [];
    for (const scale of scales) {
      fv.setDeepView({ ...centre, scale });
      fv.renderWebGL();
      const buf = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let h = 0x811c9dc5;
      for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      const set = new Set();
      for (let i = 0; i < buf.length; i += 4) set.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
      res.push({ scale: fv.getView().scale, hash: h >>> 0, colours: set.size, seed: fv.deepSeed() });
    }
    return res;
  });

  expect(out.length).toBe(SHALLOW_GOLDEN.length);
  for (let i = 0; i < out.length; i++) {
    const got = out[i], want = SHALLOW_GOLDEN[i];
    // NON-VACUITY: each arm really rendered at the documented scale, and every one
    // of these is at or above the deep lane's boundary.
    expect(got.scale, `${want.name}: the view must be the one measured`).toBe(want.scale);
    expect(got.scale, `${want.name}: this is a SHALLOW view`).toBeGreaterThanOrEqual(1e-4);
    expect(got.colours, `${want.name}: the frame must not be degenerate`).toBeGreaterThan(10);
    // The exponent mechanism must be a NO-OP here: shift 0, so S = 1 and u_scale is
    // the true scale — the pre-change expressions exactly. `got.seed.shift` is the
    // mechanism's own report of that, not an inference.
    expect(got.seed.shift, `${want.name}: the exponent split must be a no-op in the shallow lane`).toBe(0);
    // THE PIN: the pixels, byte for byte.
    expect(got.hash, `${want.name}: shallow-lane pixels must be UNCHANGED by the exponent work`).toBe(want.hash);
    expect(got.colours, `${want.name}: shallow-lane colour count must be unchanged`).toBe(want.colours);
  }

  expect(pageErrors).toEqual([]);
});

// --- pin 1: the depth, correct, against an independent reference ---------------

test('GPU-ARBITRARY pin 1: 1e-40 renders the fractal and matches an independent BigInt reference, where the pre-fix seed collapses', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  await setExactDeepView(page, { scale: DEEP_SCALE });
  const fixed = await measureAgainstReference(page, { legacy: false });
  const legacy = await measureAgainstReference(page, { legacy: true });
  console.log(`[GA pin1] scale=${DEEP_SCALE.toExponential(0)} bits=${fixed.bits} src=${fixed.source} ` +
    `seed=${JSON.stringify(fixed.seed)} refEscaped=${fixed.refEscaped} refRange=${fixed.refMin}..${fixed.refMax}`);
  console.log(`[GA pin1] FIXED : mis=${(fixed.misFrac * 100).toFixed(5)}% mean|dn|=${fixed.meanDi.toFixed(3)} ` +
    `worst=${fixed.maxDi} refDistinct=${fixed.refDistinct} gpuDistinct=${fixed.gpuDistinct} ` +
    `refColours=${fixed.refColours} gpuColours=${fixed.gpuColours}`);
  console.log(`[GA pin1] LEGACY: mis=${(legacy.misFrac * 100).toFixed(5)}% mean|dn|=${legacy.meanDi.toFixed(3)} ` +
    `worst=${legacy.maxDi} gpuDistinct=${legacy.gpuDistinct} gpuColours=${legacy.gpuColours}`);

  // NON-VACUITY: a real deep frame, a real reference with escaped cells and real
  // escape-value variation, at the precision the RULE chose.
  expect(fixed.source, 'the BigInt orbit lane must have drawn').toBe('bigint');
  expect(fixed.bits, 'past the float32 range the orbit must be at a grown precision').toBeGreaterThan(192);
  expect(fixed.refEscaped, 'the reference must contain escaped cells').toBeGreaterThan(1000);
  expect(fixed.refMax - fixed.refMin, 'the reference must contain real escape-value variation')
    .toBeGreaterThan(20);
  expect(fixed.refDistinct, 'the reference frame must not be degenerate').toBeGreaterThanOrEqual(5);
  // The pre-fix mechanism really is dead at this scale: the raw float32 product
  // underflows, so the LEGACY arm's frame is one value (the failing baseline,
  // measured through the same program).
  expect(legacy.gpuDistinct, 'the pre-fix seed must collapse to a single value at 1e-40').toBe(1);
  expect(legacy.misFrac, 'the pre-fix seed must be wrong about essentially every pixel').toBeGreaterThan(0.99);
  // And the fixed lane must NOT be collapsed.
  expect(fixed.gpuDistinct, 'the fixed lane must keep the frame\'s structure').toBeGreaterThan(20);

  // THE PIN: the shipped mechanism matches the independent direct-BigInt reference.
  // Measured on this host at 128x96: mis 0.00000%, mean |dn| 0.0, worst 16.
  expect(fixed.misFrac, 'inside/outside disagreement with the independent reference').toBeLessThan(0.005);
  expect(fixed.meanDi, 'mean |GPU escape index - independent reference| (iterations)').toBeLessThan(3);
  expect(fixed.maxDi, 'worst per-pixel escape-index error').toBeLessThanOrEqual(40);
  // ...and the fixed lane keeps the reference frame's colour structure, where the
  // collapsed one has a single colour.
  expect(fixed.gpuColours, 'the fixed lane must keep more than one colour')
    .toBeGreaterThanOrEqual(Math.ceil(fixed.refColours * 0.5));
  expect(legacy.gpuColours, 'the collapsed lane has exactly one colour').toBe(1);

  expect(pageErrors).toEqual([]);
});

// --- pin 2: the render time is reported, and it is a FULL image -----------------

test('GPU-ARBITRARY pin 2: the per-full-image render time is visible and observable, and one pass covers the whole image', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  // The user-visible readout exists and carries a number, at the default view.
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const shallow = await page.evaluate(() => {
    const before = window.__fv.fullImagePasses();
    window.__fv.renderWebGL();
    return {
      passes: window.__fv.fullImagePasses() - before,
      reported: window.__fv.renderTimeMs(),
      text: window.__fv.renderTimeText(),
      width: document.getElementById('fractalCanvasWebGL').width,
      height: document.getElementById('fractalCanvasWebGL').height,
    };
  });
  // ONE pass per render, and it covers the WHOLE drawing buffer: the renderer
  // issues exactly one full-frame drawArrays, so the number is a full image rather
  // than a partial refinement frame.
  expect(shallow.passes, 'one render is exactly one full-image pass').toBe(1);
  expect(shallow.reported, 'the readout must be a real elapsed time').toBeGreaterThanOrEqual(0);
  expect(shallow.reported, 'the readout must be finite').toBeLessThan(60_000);
  expect(shallow.text).toMatch(/Render: [\d.]+ ms/);
  expect(shallow.text, 'the readout reports the measured value').toContain(
    shallow.reported.toFixed(1),
  );
  expect(shallow.width * shallow.height, 'the pass covers the whole canvas').toBeGreaterThan(0);

  // A deep frame is the same ONE full-image pass, and its time is reported too.
  await setExactDeepView(page, { scale: SHALLOW_DEEP_SCALE });
  const deep = await page.evaluate(() => {
    const before = window.__fv.fullImagePasses();
    window.__fv.renderWebGL();
    return {
      passes: window.__fv.fullImagePasses() - before,
      reported: window.__fv.renderTimeMs(),
      text: window.__fv.renderTimeText(),
    };
  });
  expect(deep.passes, 'a deep frame is still ONE full-image pass').toBe(1);
  expect(deep.reported).toBeGreaterThanOrEqual(0);
  expect(deep.text).toMatch(/Render: [\d.]+ ms/);
  expect(deep.text).toContain(deep.reported.toFixed(1));

  expect(pageErrors).toEqual([]);
});

// --- pin 3: WEBGL_ZOOM_CAP is no longer the precision wall ----------------------

test('GPU-ARBITRARY pin 3: the deep lane renders far past the old float32 range wall, and the cap is no longer where it was', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  // The measured wall of the OLD mechanism, through the REAL shader: 2e-38 is
  // float32's smallest normal and the raw product collapses there. The fixed lane
  // must render structure at that exact scale (which is the point of the slice).
  const wall = await page.evaluate((CENTRE) => {
    window.__GA_CENTRE_X = CENTRE;
    const fv = window.__fv;
    fv.setLegacyDeltaSeed(false);
    fv.setDeepView({
      scale: 1e-38, centerX: Number(window.__GA_CENTRE_X), centerY: 0,
      centerXExact: window.__GA_CENTRE_X, centerYExact: '0',
    });
    fv.renderWebGL();
    const src = fv.orbitSource();
    const fixedDistinct = new Set(Array.from(fv.orbitFrame().n)).size;
    fv.setLegacyDeltaSeed(true);
    fv.renderWebGL();
    const legacyDistinct = new Set(Array.from(fv.orbitFrame().n)).size;
    fv.setLegacyDeltaSeed(false);
    return { fixedDistinct, legacyDistinct, src };
  }, CENTRE_X);
  // The exact scale where P2 measured the collapse is no longer special: the legacy
  // arm still dies there and the shipped arm does not.
  expect(wall.legacyDistinct, 'the pre-fix seed collapses at the old 2e-38 wall').toBe(1);
  expect(wall.fixedDistinct, 'the new mechanism renders structure at the old wall').toBeGreaterThan(2);

  // The cap cannot simply BE the old precision wall: the deep lane is exercised at
  // a scale two orders past it (1e-40) and the app's own cap must admit that scale
  // when the clamp is lifted through the real deep-view path.
  const reach = await page.evaluate(() => ({
    capScale: window.__fv.minScale,
    cap: window.__fv.zoomCap,
  }));
  expect(reach.cap, 'the cap must be a zoom way past the old 1e4').toBeGreaterThan(1e10);
  expect(reach.capScale, 'the cap scale must be below the old 1e-4').toBeLessThan(1e-10);
  // ...and the DEEP LANE is exercised past the cap, through the real deep-view
  // path, at the depth the deliverable names (1e-40): the old wall must not be
  // where the app stops.
  expect(reach.capScale, 'the cap must be far past the measured old wall').toBeGreaterThan(1e-38);

  expect(pageErrors).toEqual([]);
});
