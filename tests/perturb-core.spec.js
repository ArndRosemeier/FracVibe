// @ts-check
// P1 / the perturbation core — a reference orbit computed ONCE per view on the CPU
// in float64 and uploaded to the GPU, then per-pixel DELTA iteration with REBASING,
// RESCALING and Pauldelbrot glitch detection.
//
// Why this slice exists: the committed probe (docs/PROBE-2026-09-21-perturbation.md)
// built a NAIVE perturbation renderer — reference orbit + delta iteration, nothing
// else — and measured it clean at 1e8, degraded at 1e12 and structurally wrong at
// 1e15 (26.4 % of pixels misclassified, 74.6 % glitched, six distinct colours where
// the reference has fifty-three). The research (docs/RESEARCH-2026-09-21-arbitrary-
// depth.md §3) says that failure is a MISSING-MECHANISM result: the two mechanisms
// that keep deltas representable are REBASING and RESCALING. This spec pins the
// mechanisms and the depth they buy.
//
// THE REFERENCE. The CPU fallback cannot be the reference at this depth: it samples
// an ABSOLUTE float64 coordinate, and the float64 ULP of a centre near |c| ~ 0.74 is
// ~1.1e-16, so past zoom ~1e16 every pixel rounds to the same coordinate — the frame
// degenerates (measured: one distinct value, spread 0.0). The reference used here is
// therefore a float64 PERTURBATION render computed in the page from the app's OWN
// uploaded orbit (`window.__fv.orbitValues()`): the same delta recurrence, the same
// rebasing rule, in float64, with dc taken from the pixel offset. That is well
// defined at any depth, and it is what the GPU's float32 delta arithmetic is
// measured against.
//
// Everything is observed through the frozen `window.__fv` surface and driven through
// the real renderer. Since LANE-CONTINUITY there is NO GPU zoom cap (owner directive,
// DECISIONS 62), so `setDeepView` is `setView` plus exact-centre handling. The deep
// lane itself is selected by the scale constant `ITER_BUDGET_MIN_SCALE`
// (`__fv.iterBudgetMinScale()`), which D2 pin 2 pins; the lane boundary's own colour
// delta is pinned by tests/lane-continuity.spec.js, not here.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 200, height: 150 } });

const PROBE_CENTRE = { centerX: -0.743643887037151, centerY: 0.13182590420533 };
const DEPTH_SCALE = 1e-15; // zoom 1e15 — where the naive probe collapsed

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  // The renderer is built one macrotask after startup (the same convention
  // tests/kernel-parity.spec.js uses).
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderSource()), { timeout: 10_000 })
    .not.toBe(null);
}

// The float64 perturbation reference AND the GPU frame, in ONE page task: the
// readback must follow the draw without an intervening paint, exactly as D1 pin 5
// does. Returns per-pixel reference smooth values, the GPU pixels, the rebase count
// and the metrics the pin asserts on.
//
// COARSE-TO-FINE: `renderWebGL` now starts a refinement CHAIN and applies its
// coarsest level synchronously; `whenRenderSettled()` resolves in a microtask of
// the FULL-RESOLUTION pass's own task, so the readback below still lands before
// compositing (the drawing buffer is intact) while measuring the final image.
async function deepFrame(page) {
  return page.evaluate(async () => {
    const fv = window.__fv;
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
    const gl = canvas.getContext('webgl');
    if (!gl) return { error: 'no webgl context' };
    fv.renderWebGL();
    await fv.whenRenderSettled();
    const w = canvas.width, h = canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const orbit = fv.orbitValues();
    const view = fv.getView();
    const cap = fv.maxIter();
    const aspect = w / h;
    const ref = new Float32Array(w * h);
    const zx = orbit.zx, zy = orbit.zy, ow = orbit.width;
    let rebases = 0;
    for (let j = 0; j < h; j++) {
      const v = (j + 0.5) / h;
      const dcy = ((1 - v) - 0.5) * view.scale;
      for (let i = 0; i < w; i++) {
        const u = (i + 0.5) / w;
        const dcx = (u - 0.5) * view.scale * aspect;
        let dx = 0, dy = 0, m = 0, iter = 0, z2 = 0;
        for (; iter < cap; iter++) {
          const Zx = zx[m], Zy = zy[m];
          const Z2 = Zx * Zx + Zy * Zy;
          z2 = Z2 + 2 * (Zx * dx + Zy * dy) + dx * dx + dy * dy;
          if (z2 > 4) break;
          const nx = 2 * (Zx * dx - Zy * dy) + (dx * dx - dy * dy) + dcx;
          const ny = 2 * (Zx * dy + Zy * dx) + (2 * dx * dy) + dcy;
          dx = nx; dy = ny; m++;
          if (m >= ow) break;
          const X = zx[m], Y = zy[m];
          const vx = X + dx, vy = Y + dy;
          if (vx * vx + vy * vy < dx * dx + dy * dy) { dx = vx; dy = vy; m = 0; rebases++; }
        }
        ref[j * w + i] = iter >= cap ? cap : fv.smoothValue(z2, iter, cap);
      }
    }
    // Metrics vs the float64 perturbation reference.
    let mis = 0, sumAbs = 0, big = 0, maxAbs = 0, escaped = 0;
    const diffMask = new Uint8Array(w * h);
    const refCols = new Set(), gpuCols = new Set();
    for (let k = 0; k < w * h; k++) {
      const rv = ref[k];
      const insideRef = rv >= cap;
      if (!insideRef) escaped++;
      const want = fv.colorForValue(rv, cap);
      const kk = k * 4;
      const got = [px[kk], px[kk + 1], px[kk + 2]];
      const gpuInside = got[0] === 0 && got[1] === 0 && got[2] === 0;
      if (insideRef !== gpuInside) mis++;
      const d = Math.max(Math.abs(want[0] - got[0]), Math.abs(want[1] - got[1]), Math.abs(want[2] - got[2]));
      sumAbs += (Math.abs(want[0] - got[0]) + Math.abs(want[1] - got[1]) + Math.abs(want[2] - got[2])) / 3;
      if (d > maxAbs) maxAbs = d;
      if (d > 32) { big++; diffMask[k] = 1; }
      refCols.add((want[0] << 16) | (want[1] << 8) | want[2]);
      gpuCols.add((got[0] << 16) | (got[1] << 8) | got[2]);
    }
    // Largest 4-connected component of pixels differing by more than 32.
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let largest = 0;
    for (let k = 0; k < w * h; k++) {
      if (!diffMask[k] || seen[k]) continue;
      let sp = 0; stack[sp++] = k; seen[k] = 1; let size = 0;
      while (sp > 0) {
        const q = stack[--sp]; size++;
        const x = q % w, y = (q / w) | 0;
        if (x > 0 && diffMask[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack[sp++] = q - 1; }
        if (x < w - 1 && diffMask[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack[sp++] = q + 1; }
        if (y > 0 && diffMask[q - w] && !seen[q - w]) { seen[q - w] = 1; stack[sp++] = q - w; }
        if (y < h - 1 && diffMask[q + w] && !seen[q + w]) { seen[q + w] = 1; stack[sp++] = q + w; }
      }
      if (size > largest) largest = size;
    }
    let spread = 0;
    for (let k = 0; k < ref.length; k++) if (ref[k] < cap) { spread = 1; break; }
    // The float32 ABSOLUTE coordinate the pre-P1 shader line formed, sampled at the
    // same fragment centres: the contrast the depth pin needs.
    const f32coords = new Set();
    for (let j = 0; j < h; j++) {
      const v = (j + 0.5) / h;
      for (let i = 0; i < w; i++) {
        const u = (i + 0.5) / w;
        f32coords.add(Math.fround(Math.fround(view.centerX) + Math.fround(Math.fround((u - 0.5) * Math.fround(view.scale)) * Math.fround(aspect))));
      }
    }
    return {
      w, h, cap, scale: view.scale, orbitW: ow, rebases,
      misFrac: mis / (w * h), meanAbs: sumAbs / (w * h), maxAbs,
      bigFrac: big / (w * h), largestComp: largest,
      distinctRef: refCols.size, distinctGpu: gpuCols.size, escaped,
      f32CoordCount: f32coords.size,
      usePerturbation: fv.usePerturbation(),
      orbitComputations: fv.orbitComputations(),
      nonDegenerate: spread,
    };
  });
}

// --- pin 1: depth beyond the naive failure --------------------------------------

test('P1 pin 1: at zoom 1e15 the deep lane matches a float64 perturbation reference where the naive lane collapsed', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  await page.evaluate(({ centre, scale }) => window.__fv.setDeepView({ ...centre, scale }), {
    centre: PROBE_CENTRE, scale: DEPTH_SCALE,
  });
  const out = await deepFrame(page);
  console.log(`[P1 pin1] ${out.w}x${out.h} scale=${out.scale} cap=${out.cap} orbitW=${out.orbitW} ` +
    `lane=${out.usePerturbation} mis=${out.misFrac.toFixed(5)} meanAbs=${out.meanAbs.toFixed(3)} ` +
    `maxAbs=${out.maxAbs} bigFrac=${out.bigFrac.toFixed(4)} largestComp=${out.largestComp} ` +
    `cols ref/gpu=${out.distinctRef}/${out.distinctGpu} escaped=${out.escaped} rebases=${out.rebases}`);

  // NON-VACUITY: a real deep render against a real, non-degenerate reference. The
  // committed probe's naive arm at this depth produced SIX distinct colours where the
  // reference had 53; a pin whose reference were itself a constant frame would prove
  // nothing (the probe's own 1e18 case is exactly that).
  expect(out.error).toBeUndefined();
  expect(out.usePerturbation, 'the deep lane must be the one that drew').toBe(true);
  expect(out.escaped, 'the reference frame must contain escaped cells').toBeGreaterThan(1000);
  expect(out.distinctRef, 'the float64 perturbation reference must not be degenerate').toBeGreaterThan(50);
  expect(out.rebases, 'rebasing must actually occur at this depth').toBeGreaterThan(1000);

  // THE BASELINE, shown so the pin cannot pass vacuously: the pre-P1 coordinate line
  // (`u_centerX + offset` in float32) collapses the whole frame to ONE coordinate at
  // this scale, because the offset is ~1e-18 and the float32 ULP of a centre near 0.74
  // is ~6e-8. That is the defect the reference orbit removes; the committed probe
  // measured the arm built on it at 26.4 % misclassified and 74.6 % glitched.
  console.log(`[P1 pin1] pre-P1 float32 absolute coordinate: ${out.f32CoordCount} distinct value(s) over ${out.w * out.h} pixels`);
  expect(out.f32CoordCount, 'the naive float32 absolute coordinate must collapse at this scale').toBe(1);

  // STATED THRESHOLDS. Measured correct on this host at 200x150: mis 0.00000,
  // meanAbs 0.453, largest 4-connected component of pixels differing by more than 32
  // = 3 px, and the SAME 136 distinct colours as the reference. The control
  // (rebasing removed, byte-restored afterwards) measures meanAbs 3.18, a 90-px
  // component and 6 distinct colours — see docs/DECISIONS.md row 33.
  expect(out.misFrac, 'inside/outside disagreement with the float64 perturbation reference').toBeLessThan(0.005);
  expect(out.meanAbs, 'mean per-channel |GPU - reference| (0-255)').toBeLessThan(1.5);
  expect(out.largestComp, 'largest connected blob differing by more than 32').toBeLessThanOrEqual(8);
  expect(out.distinctGpu, 'the deep lane must keep the reference frame\'s colour structure').toBeGreaterThanOrEqual(
    Math.ceil(out.distinctRef * 0.5),
  );

  expect(pageErrors).toEqual([]);
});

// --- pin 2: the orbit is computed once per view, counted ------------------------

test('P1 pin 2: the reference orbit is built once per view, counted, never per draw', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  const first = await page.evaluate(({ centre, scale }) => {
    window.__fv.setDeepView({ ...centre, scale });
    return { count: window.__fv.orbitComputations(), orbit: window.__fv.orbitValues(), cap: window.__fv.maxIter() };
  }, { centre: PROBE_CENTRE, scale: DEPTH_SCALE });

  // NON-VACUITY: an orbit was really built, at the job's own budget.
  expect(first.count, 'a deep view must build an orbit').toBeGreaterThan(0);
  expect(first.orbit, 'the orbit must be observable').not.toBe(null);
  expect(first.orbit.width, 'Z_0 .. Z_maxIter').toBe(Math.min(first.cap + 1, 8192));
  // The orbit really is the app's float64 orbit of the view centre: Z_0 = 0 and
  // Z_1 = C.
  expect(first.orbit.zx[0]).toBe(0);
  expect(first.orbit.zy[0]).toBe(0);
  expect(first.orbit.zx[1]).toBeCloseTo(PROBE_CENTRE.centerX, 12);
  expect(first.orbit.zy[1]).toBeCloseTo(PROBE_CENTRE.centerY, 12);

  // Five more draws of the SAME view (the real render path, exactly what a colour
  // change or a resize does) build NOTHING — counted, not inferred.
  const repeated = await page.evaluate(() => {
    const before = window.__fv.orbitComputations();
    for (let i = 0; i < 5; i++) window.__fv.renderWebGL();
    return { before, after: window.__fv.orbitComputations() };
  });
  expect(repeated.after - repeated.before, 're-drawing one view must not rebuild the orbit').toBe(0);

  // A VIEW change builds exactly one more: the centre moved, so the reference moved.
  const moved = await page.evaluate(({ centre, scale }) => {
    const before = window.__fv.orbitComputations();
    window.__fv.setDeepView({ centerX: centre.centerX + 1e-15, centerY: centre.centerY, scale });
    return { before, after: window.__fv.orbitComputations() };
  }, { centre: PROBE_CENTRE, scale: DEPTH_SCALE });
  expect(moved.after - moved.before, 'a centre change must rebuild the orbit exactly once').toBe(1);

  // A BUDGET change is a different reference orbit (it is the same recurrence, more
  // terms), so it also builds exactly one more.
  const budget = await page.evaluate(({ centre, scale }) => {
    window.__fv.setDeepView({ ...centre, scale });
    const before = window.__fv.orbitComputations();
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    slider.value = '8000';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    window.__fv.renderWebGL();
    return { before, after: window.__fv.orbitComputations() };
  }, { centre: PROBE_CENTRE, scale: DEPTH_SCALE });
  expect(budget.after - budget.before, 'a budget change must rebuild the orbit exactly once').toBe(1);

  expect(pageErrors).toEqual([]);
});

// --- pin 3: the lane is depth-selected and the glitch detector is on-GPU ---------

test('P1 pin 3: the deep lane is depth-selected, and the Pauldelbrot detector is measured on the GPU', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  // (a) The shallow lane is the PLAIN pre-P1 shader: no reference, no glitch
  // detector, and the GPU's glitch frame is therefore all zeros. This is the
  // non-vacuity control for (b): a detector that always reported the same number
  // would be indistinguishable from one that never ran.
  const shallow = await page.evaluate(() => {
    window.__fv.setView({ centerX: -0.795, centerY: 0.18, scale: 0.05 });
    window.__fv.renderWebGL();
    return {
      lane: window.__fv.usePerturbation(),
      glitch: window.__fv.glitchFrame(),
      scale: window.__fv.getView().scale,
    };
  });
  console.log(`[P1 pin3] shallow scale=${shallow.scale} lane=${shallow.lane} glitchedFrac=${shallow.glitch.glitchedFrac}`);
  // No cap now: the shallow scale is stored verbatim.
  expect(shallow.scale).toBe(0.05);
  expect(shallow.lane, 'the shallow lane must be the plain one').toBe(false);
  expect(shallow.glitch.glitchedFrac, 'the plain lane has no reference, so nothing can glitch').toBe(0);

  // (b) The deep lane starts at the SAME scale the shipped GPU zoom cap owns, and
  // the Pauldelbrot detector runs there. Measured: 73.8 % of pixels glitch at some
  // iteration at G = 1e-4. That is a property of the reference/pixel geometry (the
  // committed probe measured 74.6 % for the naive arm too), so it is a DIAGNOSTIC,
  // not a repair trigger — which is exactly the literature's position on G.
  const deep = await page.evaluate(({ centre, scale }) => {
    window.__fv.setDeepView({ ...centre, scale });
    return {
      lane: window.__fv.usePerturbation(),
      glitch: window.__fv.glitchFrame(),
      orbit: window.__fv.orbitValues(),
      constants: window.__fv.perturbConstants(),
      source: window.__fv.shaderSource(),
    };
  }, { centre: PROBE_CENTRE, scale: DEPTH_SCALE });
  await page.evaluate(() => window.__fv.renderWebGL());
  console.log(`[P1 pin3] deep lane=${deep.lane} glitchedFrac=${deep.glitch.glitchedFrac.toFixed(4)} ` +
    `G=${deep.constants.glitchG} interval=${deep.constants.rescaleInterval} orbitW=${deep.constants.orbitWidth}`);
  expect(deep.lane, 'the deep lane must be the perturbation one').toBe(true);
  expect(deep.glitch.glitched, 'the detector must fire on a real population').toBeGreaterThan(1000);
  expect(deep.glitch.glitchedFrac).toBeGreaterThan(0.5);
  expect(deep.glitch.glitchedFrac).toBeLessThan(0.95);
  // The G actually templated into the GLSL is the kernel's ONE constant, and the
  // rescale interval is templated too — a pin that only read the JS constant could
  // not see a shader that restated a different number.
  expect(deep.source).toContain('#define PERTURB_GLITCH_G ' + Math.fround(deep.constants.glitchG));
  expect(deep.source).toContain('#define PERTURB_RESCALE_INTERVAL ' + deep.constants.rescaleInterval);
  // The deep lane really has an orbit to glitch against.
  expect(deep.orbit.width).toBeGreaterThan(1000);

  expect(pageErrors).toEqual([]);
});
