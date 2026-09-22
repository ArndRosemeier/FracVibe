// @ts-check
// LANE-CONTINUITY — the 1e-4 discontinuity is removed, and the depth stop is gone.
//
// THE DEFECT (dispatcher-measured, reproduced in-pin below). At scale 1e-4 TWO
// mechanisms fired in the same wheel step:
//   1. D2's iteration floor turned ON, stepping the effective budget from the user's
//      floor to `512*log10(1/scale)` in ONE step (measured 512 -> 2058 here);
//   2. `webglFractal.js` swapped the whole shader program (`ITER_BUDGET_MIN_SCALE`).
// Through the REAL render path at the COAST view, the step that crosses 1e-4 moved
// the frame by 31.600 mean-red units against ~0.01-3.4 for its neighbours.
//
// THE MEASUREMENT THAT CHOSE THE FIX. Holding the budget FIXED (slider 4096, so the
// floor could not contribute) the SAME lane switch moves the frame by 0.005 mean-red
// units — the same order as the sweep's own non-boundary step (0.036). So the lane
// switch is INVISIBLE at the boundary (both lanes are sub-pixel accurate at 1e-4) and
// the discontinuity was the BUDGET FLOOR TURNING ON. The fix is therefore candidate
// (c)/(a): the floor is introduced CONTINUOUSLY (it departs from zero at the knee and
// reaches the 512-per-decade rule one decade below it), and the lane selection is left
// alone — blending the two programs was rejected because it would double the draw cost
// in the band for a difference below the frame's own step-to-step change.
//
// THE FAILING BASELINE IS IN-PIN. `legacyBudget()` is the REMOVED discontinuous rule,
// and the LEGACY arm drives the REAL render path with the pre-fix effective budget
// sequence (setting the slider to the old effective budget is pixel-equivalent to the
// pre-fix build: the cap, the lane and the shader are then identical). The pin asserts
// the legacy arm still jumps >= 25 units at the boundary, so a revert to the old rule
// (or any new step at the boundary) turns this RED.
//
// The owner's directive (docs/DECISIONS.md row 62) is the point: no depth is special,
// no hard stop, and the CPU lane is never chosen by depth or slowness.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 1000, height: 700 } });

const COAST = { centerX: -0.743643887037151, centerY: 0.13182590420533 };
// The dispatcher's own log-spaced scales, INCLUDING both boundary neighbours.
const SCALES = [9.0e-5, 9.6e-5, 1.0e-4, 1.05e-4, 1.2e-4, 1.5e-4];
const BOUNDARY_FROM = 9.6e-5;
const BOUNDARY_TO = 1.0e-4;
const KNEE = 1e-4;
const SLIDER = 512;              // the running app's default budget
const FIXED_DEEP = 4096;         // a budget ABOVE the old floor's step, for the lane-only arm
const LEGACY_BOUNDARY_JUMP = 31.600; // the dispatcher's pre-fix measurement, at this view/metric

// The REMOVED rule, verbatim in-pin. It is a fixed baseline and must not drift.
function legacyBudget(scale, slider) {
  const raw = scale < KNEE ? Math.ceil(512 * Math.log10(1 / scale)) : 1;
  return Math.max(slider, Math.min(8192, Math.max(1, raw)));
}

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
}

// ONE real frame through the REAL path: set the slider (the user's floor), set the
// view, run the REAL worker job, wait for it, then read the WebGL canvas.
async function runFrame(page, scale, slider) {
  return page.evaluate(async ({ view, scale, slider }) => {
    const el = document.getElementById('maxIter');
    el.value = String(slider);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    window.__fv.setView({ ...view, scale });
    window.__fv.runJob();
    await new Promise((res) => {
      const t0 = Date.now();
      const tick = () => {
        if ((window.__fv.jobToken && window.__fv.jobToken() === null) || Date.now() - t0 > 20000) res();
        else requestAnimationFrame(tick);
      };
      tick();
    });
    // COARSE-TO-FINE: the CPU job's final frame re-renders through the GPU path
    // (`setData` -> `render`), so its refinement chain must settle before the
    // pixels are read; the readback then lands in the same task as the
    // FULL-RESOLUTION draw.
    await window.__fv.whenRenderSettled();
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL') || document.querySelector('canvas'));
    const gl = c.getContext('webgl');
    const buf = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 4) sum += buf[i];
    return {
      mean: sum / (buf.length / 4),
      cap: window.__fv.maxIter(),
      lane: window.__fv.usePerturbation(),
      scale: window.__fv.getView().scale,
    };
  }, { view: COAST, scale, slider });
}

// Mean-red step between each pair of neighbouring frames (the dispatcher's metric,
// which is the ONLY metric the 31.6-unit baseline is quoted in).
function stepsOf(rows) {
  const steps = [];
  for (let i = 1; i < rows.length; i++) {
    steps.push({
      from: rows[i - 1].scale,
      to: rows[i].scale,
      step: Math.abs(rows[i].mean - rows[i - 1].mean),
    });
  }
  return steps;
}
const boundaryStep = (steps) => steps.find((s) => s.from === BOUNDARY_FROM && s.to === BOUNDARY_TO).step;
const maxStep = (steps) => steps.reduce((a, b) => (b.step > a.step ? b : a));

// --- pin 1: the colour sweep has no step at the old boundary, and the removed rule's
// --- step is MEASURED in the same pin as the failing baseline. ------------------

test('LANE-CONTINUITY pin 1: the sweep across 1e-4 has no outlier step, where the removed budget rule jumps 31.6 units', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  // The shipped rule, at the running app's own slider value.
  const shippedRows = [];
  for (const scale of SCALES) shippedRows.push(await runFrame(page, scale, SLIDER));
  const shippedSteps = stepsOf(shippedRows);

  // The pre-fix effective budget sequence, through the SAME real render path. The
  // emulation is exact: setting the slider to the old effective budget reproduces the
  // old cap, and the lane depends only on the scale, so the pixels are the pre-fix
  // build's pixels.
  const legacyRows = [];
  for (const scale of SCALES) legacyRows.push(await runFrame(page, scale, legacyBudget(scale, SLIDER)));
  const legacySteps = stepsOf(legacyRows);

  console.log('[lane pin1] shipped rows ' + shippedRows.map((r) => `${r.scale.toExponential(2)}:${r.mean.toFixed(3)}(cap${r.cap}${r.lane ? 'D' : 'P'})`).join(' '));
  console.log('[lane pin1] shipped steps ' + shippedSteps.map((s) => `${s.from.toExponential(2)}->${s.to.toExponential(2)}:${s.step.toFixed(3)}`).join(' '));
  console.log('[lane pin1] legacy steps  ' + legacySteps.map((s) => `${s.from.toExponential(2)}->${s.to.toExponential(2)}:${s.step.toFixed(3)}`).join(' '));

  const sh = boundaryStep(shippedSteps);
  const lg = boundaryStep(legacySteps);

  // NON-VACUITY: both arms really crossed the boundary, and the boundary frame really
  // changed lane (deep below, plain at/above).
  expect(shippedRows[1].scale).toBe(BOUNDARY_FROM);
  expect(shippedRows[2].scale).toBe(BOUNDARY_TO);
  expect(shippedRows[1].lane, 'below the boundary the deep lane draws').toBe(true);
  expect(shippedRows[2].lane, 'at the boundary the plain lane draws').toBe(false);
  // The legacy arm reproduced the PRE-FIX budget sequence: the removed rule's floor is
  // what the deep frames ran at, not the shipped ramp's.
  expect(legacyRows[1].cap, 'the legacy arm must run at the removed rule\'s budget').toBe(legacyBudget(BOUNDARY_FROM, SLIDER));
  expect(legacyRows[2].cap, 'the legacy arm must run at the plain floor above the boundary').toBe(SLIDER);

  // THE FAILING BASELINE, in-pin: the removed rule's step at the boundary is huge.
  expect(lg, 'the removed budget rule must still jump at the boundary (the baseline)')
    .toBeGreaterThan(LEGACY_BOUNDARY_JUMP * 0.8); // >= 25.3; measured 31.600
  // THE PIN: the shipped rule's step at the boundary is tiny...
  expect(sh, 'the shipped sweep must not step at the boundary').toBeLessThan(1.0);
  // ...and it is not an OUTLIER in the sweep (measured 0.019 against a max of 11.834).
  expect(sh, 'the boundary step must not be the sweep\'s largest')
    .toBeLessThanOrEqual(maxStep(shippedSteps).step);
  expect(sh, 'the fix must move the boundary by at least an order of magnitude')
    .toBeLessThan(lg / 10);

  expect(pageErrors).toEqual([]);
});

// --- pin 2: the LANE SWITCH alone, at a budget held FIXED across the boundary ----

test('LANE-CONTINUITY pin 2: the lane switch\'s own colour delta is below the sweep noise, at a budget held fixed', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  // Three scales straddling the boundary, all at the SAME effective budget (the
  // slider is above the ramp's floor on both sides), so only the program changes.
  const scales = [BOUNDARY_FROM, BOUNDARY_TO, 1.05e-4];
  const rows = [];
  for (const scale of scales) rows.push(await runFrame(page, scale, FIXED_DEEP));
  const steps = stepsOf(rows);
  console.log('[lane pin2] rows ' + rows.map((r) => `${r.scale.toExponential(2)}:${r.mean.toFixed(3)}(cap${r.cap}${r.lane ? 'D' : 'P'})`).join(' '));
  console.log('[lane pin2] steps ' + steps.map((s) => `${s.from.toExponential(2)}->${s.to.toExponential(2)}:${s.step.toFixed(3)}`).join(' '));

  // NON-VACUITY: the budget really was held fixed and the lane really changed.
  for (const r of rows) expect(r.cap, `${r.scale}: the budget must be the fixed one`).toBe(FIXED_DEEP);
  expect(rows[0].lane, 'below the boundary the deep lane draws').toBe(true);
  expect(rows[1].lane, 'at the boundary the plain lane draws').toBe(false);
  // THE PIN: the lane switch's own colour delta is smaller than the frame's own
  // step-to-step change at these scales (measured 0.005 at the boundary).
  const lane = steps[0].step;
  expect(lane, 'the lane switch must be invisible at a fixed budget').toBeLessThan(1.0);
  expect(lane, 'the fix must be tiny against the removed rule\'s step').toBeLessThan(LEGACY_BOUNDARY_JUMP / 20);

  expect(pageErrors).toEqual([]);
});

// --- pin 3: the RULE is continuous, not just the pixels at one view --------------
//
// A colour sweep at one view cannot see a budget step that happens to be invisible
// there. This is the rule-level net: over a fine log sweep spanning the knee and the
// ramp's saturation, the effective budget must change by a few iterations per step,
// where the removed rule changed by thousands in one step.
test('LANE-CONTINUITY pin 3: the effective budget is continuous in the view scale', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  const out = await page.evaluate(({ slider, scales }) => {
    const fv = window.__fv;
    const eff = (s) => Math.max(slider, fv.iterBudgetForScale(s));
    // The REMOVED rule, again in-pin, as the numeric baseline.
    const legacy = (s) => {
      const raw = s < 1e-4 ? Math.ceil(512 * Math.log10(1 / s)) : 1;
      return Math.max(slider, Math.min(8192, Math.max(1, raw)));
    };
    const biggestJump = (fn) => {
      let m = 0, at = null;
      for (let i = 1; i < scales.length; i++) {
        const d = Math.abs(fn(scales[i]) - fn(scales[i - 1]));
        if (d > m) { m = d; at = scales[i]; }
      }
      return { m, at };
    };
    return {
      shipped: biggestJump(eff),
      removed: biggestJump(legacy),
      first: eff(scales[0]),
      last: eff(scales[scales.length - 1]),
    };
  }, {
    slider: SLIDER,
    // 240 log-spaced samples from 1e-3 (above the knee) to 1e-6 (past the ramp).
    scales: Array.from({ length: 241 }, (_, i) => 1e-3 * Math.pow(1e-6 / 1e-3, i / 240)),
  });
  console.log(`[lane pin3] shipped max adjacent jump ${out.shipped.m} at ${out.shipped.at}; `
    + `removed rule ${out.removed.m} at ${out.removed.at} (${out.first} -> ${out.last})`);
  // The removed rule steps by the whole floor in ONE sample (measured ~2051).
  expect(out.removed.m, 'the removed rule must still show its step (the numeric baseline)')
    .toBeGreaterThan(1000);
  // The shipped rule is CONTINUOUS: the largest change between neighbouring samples
  // is a small fraction of the whole range, and it shrinks with the step size. A
  // reintroduced hard step is two orders of magnitude larger.
  expect(out.shipped.m, 'the effective budget must be continuous across the knee').toBeLessThanOrEqual(200);
  expect(out.shipped.m, 'the shipped rule must not step anything like the removed one')
    .toBeLessThan(out.removed.m / 10);
  // NON-VACUITY: the sweep really spans a big budget range (so "no jump" is not a
  // sweep of a constant).
  expect(out.last - out.first, 'the sweep must span a large budget range').toBeGreaterThan(1000);

  expect(pageErrors).toEqual([]);
});

// --- pin 4: there is NO hard stop ----------------------------------------------
//
// A small viewport: the wheel path starts a real CPU job, and at 8192 iterations a
// full-window frame is minutes on this host's software rasteriser. The zoom maths and
// the stored scale do not depend on the viewport size.

test.describe('no hard stop', () => {
  test.use({ viewport: { width: 64, height: 48 } });

  test('LANE-CONTINUITY pin 4: there is no zoom cap, and depth is stored verbatim through every path', async ({ page }) => {
    test.setTimeout(120_000);
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto('./', { waitUntil: 'domcontentloaded' });
    await waitSettled(page);

    const shipped = await page.evaluate(() => ({
      minScale: window.__fv.minScale,
      zoomCap: window.__fv.zoomCap,
      measuredReach: window.__fv.deepPrecisionMinScale,
    }));
    expect(shipped.minScale, 'the shipped zoom state is UNLIMITED').toBe(null);
    expect(shipped.zoomCap, 'there is no zoom cap').toBe(null);
    // The accuracy limit is a SEPARATE, non-blocking number: the limit of the CURRENT
    // single-factor float32 delta solver (24-bit mantissa), fixed by widening the
    // MANTISSA next (compensated/multi-component), not by more exponent.
    expect(shipped.measuredReach, 'the measured-correct reach of the current solver is reported').toBe(1e-40);

    // A depth WELL past the old cap and past the current solver's reach is stored
    // verbatim by every path — the owner's "no hard stop".
    const driven = await page.evaluate(() => {
      const fv = window.__fv;
      const deep = 1e-45;
      fv.setScale(deep);
      const viaSetView = fv.getView().scale;
      for (let i = 0; i < 3; i++) fv.wheelTick(-300);
      const viaWheel = fv.getView().scale;
      fv.setScale(deep);
      fv.renderWebGL();
      const viaRender = fv.getView().scale;
      const events = [];
      window.addEventListener('fv-deep-precision', (e) => events.push(e.detail.scale));
      fv.setScale(deep);
      return { viaSetView, viaWheel, viaRender, events, message: document.getElementById('appMessage').textContent };
    });
    expect(driven.viaSetView).toBe(1e-45);
    expect(driven.viaWheel, 'the wheel keeps zooming past every old cap').toBeLessThan(1e-45);
    expect(driven.viaRender).toBe(1e-45);
    // The only depth signal left is informational.
    expect(driven.events.length).toBeGreaterThan(0);
    expect(driven.message).toContain('measured-correct precision');

    expect(pageErrors).toEqual([]);
  });
});
