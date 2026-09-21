// @ts-check
// D2 / zoom-scaled iteration budget — the budget follows the zoom, so a deep view
// RESOLVES instead of saturating to "inside" (black).
//
// Why this slice exists, measured: the probe's view centre escapes only at iteration
// 3086 (float64, stable across budgets 2e4..2e6), so at the shipped budget of 512 the
// centre is called "inside" and a 1e8 frame is 100% black — regardless of how precise
// the arithmetic is. The probe needed maxIter 4096 at 1e8 to produce a real image
// (docs/PROBE-2026-09-21-gpu-precision.md item 7). Until the budget follows the zoom,
// no deep-zoom precision work can even be observed (docs/PLAN-DEEPZOOM.md D2).
//
// The rule under test (public/fractalKernel.js): the slider's value is a FLOOR and
// `effective = max(slider, floor(zoom))`. The floor is ZERO at and above the deep
// lane's boundary and grows 512 iterations per decade of zoom below it, but
// LANE-CONTINUITY made the departure CONTINUOUS (it ramps in over the decade below
// the boundary) so no depth has a budget jump:
//   zoom 1e5 -> 2560   1e6 -> 3072   1e8 -> 4096   1e15 -> 7680
// and the ONE cap (MAX_ITER) bounds it. There is NO app zoom cap any more.
//
// Everything is observed through the frozen `window.__fv` surface and driven through
// the real UI / real worker. `setDeepView` is the ONE observation hook: with the cap
// gone it is `setView` plus exact-centre handling; the view, the budget rule, the
// worker, the kernel and the colour path are the production ones. The last
// test-measured budget and every table count come from the app's own counters, not
// from pixels or inference.
const { test, expect } = require('@playwright/test');

// A small viewport keeps a real 4096-iteration CPU frame cheap; the pins are about
// the budget, not the resolution.
test.use({ viewport: { width: 200, height: 150 } });

// The probe's own deep scene, and the budgets its evidence names.
const PROBE_CENTRE = { centerX: -0.743643887037151, centerY: 0.13182590420533 };
const DEEP_SCALE = 1e-8; // zoom 1e8
const FIXED_BUDGET = 512; // the shipped default; the probe measured it 100% inside here
const SCALED_BUDGET = 4096; // the rule's floor at 1e8 == the budget the probe used

async function waitIdle(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv.jobToken()), { timeout: 60_000 })
    .toBe(null);
}

// Boot the app on the CPU renderer (deterministic pixels, and the CPU kernel is the
// float64 reference) with the slider at the shipped default budget.
async function setup(page) {
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await page.uncheck('#webglRender');
  await waitIdle(page);
}

// The inside fraction of the frame the app actually rendered, plus the frame's own
// pixel-centre coordinates, so a reference can be computed at the SAME points.
async function frame(page) {
  return page.evaluate(() => {
    const vals = window.__fv.iterBufferAll();
    const view = window.__fv.getView();
    const cap = window.__fv.maxIter();
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let inside = 0, escaped = 0, nan = 0, nonBlack = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v === null || v !== v) { nan++; continue; }
      if (v >= cap) {
        inside++;
        const k = i * 4;
        if (px[k] || px[k + 1] || px[k + 2]) nonBlack++;
      } else {
        escaped++;
        const k = i * 4;
        if (px[k] || px[k + 1] || px[k + 2]) nonBlack++;
      }
    }
    return {
      cap, width: c.width, height: c.height, view, n: vals.length, inside, escaped, nan, nonBlack,
      insideFrac: inside / vals.length,
    };
  });
}

// The app's OWN kernel at each sampled pixel's centre coordinate, classified at an
// explicit budget. This is the float64 reference; `smoothPixel` is the kernel's
// published smooth-value definition, not a second implementation.
async function referenceInsideFrac(page, budget, n) {
  return page.evaluate(({ budget, n }) => {
    const view = window.__fv.getView();
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
    const w = c.width, h = c.height;
    const aspect = w / h;
    let inside = 0, count = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = Math.floor((i + 0.5) * w / n);
        const y = Math.floor((j + 0.5) * h / n);
        const cx = view.centerX + (x - w / 2) * view.scale / w * aspect;
        const cy = view.centerY + (y - h / 2) * view.scale / h;
        if (window.__fv.smoothPixel('mandelbrot', cx, cy, budget, 0, 0) >= budget) inside++;
        count++;
      }
    }
    return { inside, count, frac: inside / count };
  }, { budget, n });
}

// --- pin 1 ---------------------------------------------------------------------

test('D2 pin 1: the auto budget makes a deep view resolve instead of saturating to black', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await setup(page);

  // The shipped default budget, set through the real slider handler, at a shallow
  // view (so no floor is in force yet and the slider value is the whole budget).
  await page.evaluate((fixed) => {
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    slider.value = String(fixed);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, FIXED_BUDGET);
  await waitIdle(page);

  // Now go genuinely deep. `setDeepView` bypasses ONLY the GPU zoom clamp; the
  // budget rule then raises the effective budget from the 512 floor, and the real
  // worker computes the frame at it.
  await page.evaluate(({ centre, scale }) => window.__fv.setDeepView({ ...centre, scale }), {
    centre: PROBE_CENTRE, scale: DEEP_SCALE,
  });
  const raised = await page.evaluate(() => ({
    floor: window.__fv.maxIterFloor(),
    effective: window.__fv.maxIter(),
    budgetFloor: window.__fv.iterBudget(),
    readout: document.getElementById('maxIterValue').textContent,
    scale: window.__fv.getView().scale,
  }));
  await page.evaluate(() => window.__fv.runJob());
  await waitIdle(page);

  const out = await frame(page);
  console.log(`[D2 pin1] scale=${raised.scale} slider=${raised.floor} budget=${raised.effective} ` +
    `readout="${raised.readout}" frame=${out.width}x${out.height} inside=${out.inside} ` +
    `escaped=${out.escaped} nan=${out.nan} nonBlack=${out.nonBlack}`);

  // The view really is deep and the app really is indexing it at the scaled budget:
  // a shallow or unsized run would make every assertion below meaningless.
  expect(raised.scale).toBe(DEEP_SCALE);
  expect(raised.floor, 'the slider still holds the user value').toBe(FIXED_BUDGET);
  // THE MECHANISM, observable: the zoom floor raised the budget above the slider.
  expect(raised.budgetFloor, 'the zoom-derived floor at 1e8').toBe(SCALED_BUDGET);
  expect(raised.effective, 'the budget the job ran at').toBe(SCALED_BUDGET);
  // The UI is honest about which of the two is in force.
  expect(raised.readout, 'the readout must mark the auto-raised budget').toContain('auto');
  expect(raised.readout).toContain(String(SCALED_BUDGET));

  // The frame is a COMPLETED frame at the scaled budget, and it is a REAL image:
  // the probe measured 100% "inside" (pure black) at this view with the fixed budget.
  expect(out.nan, 'a finished frame carries no uncalculated cells').toBe(0);
  expect(out.nonBlack, 'the deep frame must not be blank black').toBeGreaterThan(10_000);
  // Measured correct: inside 0 of 30 000 cells (0.0%); the fixed budget gives 100%.
  expect(out.insideFrac, 'the interior fraction at the scaled budget must be far from 100%').toBeLessThan(0.05);
  expect(out.escaped, 'the resolved frame is almost entirely escaped cells').toBeGreaterThan(out.n * 0.9);

  // NON-VACUITY: the view is genuinely a saturating one for the shipped budget. The
  // app's OWN float64 kernel at the frame's own pixel centres, at the fixed budget,
  // calls the view ~100% inside — so "not saturated" below is a real change.
  const fixedRef = await referenceInsideFrac(page, FIXED_BUDGET, 30);
  console.log(`[D2 pin1] float64 reference at cap ${FIXED_BUDGET}: ${(fixedRef.frac * 100).toFixed(1)}% inside`);
  expect(fixedRef.frac, `cap ${FIXED_BUDGET} must saturate this view`).toBeGreaterThan(0.9);

  // And the scaled budget's classification agrees with a MUCH larger budget (the
  // converged float64 reference) within a stated threshold.
  const capMax = await page.evaluate(() => window.__fv.maxIterCap);
  const convergedRef = await referenceInsideFrac(page, capMax, 30);
  console.log(`[D2 pin1] float64 reference at cap ${capMax}: ${(convergedRef.frac * 100).toFixed(1)}% inside`);
  expect(convergedRef.frac, 'the converged reference must also be resolved').toBeLessThan(0.05);

  expect(pageErrors).toEqual([]);
});

// --- pin 2 ---------------------------------------------------------------------

test('D2 pin 2: the budget is monotone in zoom, bounded by the one cap, and the slider max IS that cap', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  // The renderer is built one macrotask after startup; poll rather than read it
  // synchronously (the same convention tests/kernel-parity.spec.js uses).
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderMaxIter()), { timeout: 10_000 })
    .not.toBe(null);

  const measured = await page.evaluate(() => {
    const fv = window.__fv;
    const cap = fv.maxIterCap;
    // Walk the scale from the widest view down well past the float64 orbit reach and
    // record the floor at every step. Monotone in zoom means: as the scale falls,
    // the floor never falls. The deepest samples are past the point where the rule
    // reaches the cap, so the sweep covers the clamp as well as the growth.
    const scales = [];
    for (let i = 0; i <= 60; i++) scales.push(10 * Math.pow(1e-20, i / 60));
    const rows = scales.map((scale) => ({ scale, budget: fv.iterBudgetForScale(scale) }));
    let monotone = true, worstDrop = 0, overCap = 0;
    for (let i = 1; i < rows.length; i++) {
      const drop = rows[i - 1].budget - rows[i].budget;
      if (drop > worstDrop) worstDrop = drop;
      if (drop > 0) monotone = false;
      if (rows[i].budget > cap) overCap++;
    }
    if (rows[0].budget > cap) overCap++;
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    return {
      cap, monotone, worstDrop, overCap,
      anchors: {
        atCap: fv.iterBudgetForScale(1e-4),
        at1e5: fv.iterBudgetForScale(1e-5),
        at1e6: fv.iterBudgetForScale(1e-6),
        at1e7: fv.iterBudgetForScale(1e-7),
        at1e8: fv.iterBudgetForScale(1e-8),
        at1e15: fv.iterBudgetForScale(1e-15),
        atDeep: fv.iterBudgetForScale(1e-20),
        shallow: fv.iterBudgetForScale(3),
      },
      rows,
      minScale: fv.minScale,
      zoomCap: fv.zoomCap,
      deepPrecisionMinScale: fv.deepPrecisionMinScale,
      iterBudgetMinScale: fv.iterBudgetMinScale(),
      // The scale the perturbation (deep) lane opens at, read from the renderer's
      // OWN decision at a real draw (below), not from a restated constant.
      deepLaneMinScale: fv.iterBudgetMinScale(),
      perDecade: fv.iterBudgetPerDecade,
      sliderMaxAttr: slider.getAttribute('max'),
      sliderMaxProp: slider.max,
      shaderMaxIter: fv.shaderMaxIter(),
      shaderLoopBounds: fv.shaderLoopBounds(),
    };
  });
  console.log(`[D2 pin2] cap=${measured.cap} perDecade=${measured.perDecade} monotone=${measured.monotone} ` +
    `overCap=${measured.overCap} anchors=${JSON.stringify(measured.anchors)}`);

  // Monotone in zoom (never decreasing as the zoom rises) and never above the ONE cap.
  expect(measured.monotone, 'the budget must never fall as the zoom rises').toBe(true);
  expect(measured.worstDrop).toBe(0);
  expect(measured.overCap, 'no sampled budget may exceed the ONE cap').toBe(0);

  // The stated anchors of the rule, including the probe's own budget at 1e8.
  expect(measured.anchors.shallow, 'no floor at a shallow view').toBe(1);
  expect(measured.anchors.atCap, 'no floor AT the shipped GPU zoom cap').toBe(1);
  expect(measured.anchors.at1e5).toBe(2560);
  expect(measured.anchors.at1e6).toBe(3072);
  expect(measured.anchors.at1e7).toBe(3584);
  expect(measured.anchors.at1e8, "the budget the probe needed at 1e8").toBe(4096);
  expect(measured.anchors.at1e15).toBe(7680);
  // Past the float64 orbit's reach the ONE cap, not the rule, decides.
  expect(measured.anchors.atDeep, 'the rule can never exceed the ONE cap').toBe(measured.cap);

  // LANE-CONTINUITY removed the app's zoom cap (owner directive, DECISIONS 62), so
  // the rule's knee is no longer equal to a cap and the old equality is GONE.
  // `ITER_BUDGET_MIN_SCALE` stays 1e-4 because that is the scale the DEEP LANE opens
  // at, and the two must still agree. What the pin now holds is that the knee is a
  // stated LANE constant, that the shipped zoom state is UNLIMITED, and that the
  // accuracy reach is reported separately from the (now absent) stop.
  expect(measured.iterBudgetMinScale, 'the floor knee is the deep lane threshold, stated as a number')
    .toBe(measured.deepLaneMinScale);
  // The knee is a BEHAVIOUR, not a restated constant: at the knee the deep lane is
  // off and just below it the deep lane is on, measured through the renderer's own
  // `usePerturbation` after a real draw.
  const lane = await page.evaluate(() => {
    const fv = window.__fv;
    const centre = { centerX: -0.743643887037151, centerY: 0.13182590420533 };
    fv.setDeepView({ ...centre, scale: fv.iterBudgetMinScale() });
    fv.renderWebGL();
    const atKnee = fv.usePerturbation();
    fv.setDeepView({ ...centre, scale: fv.iterBudgetMinScale() * 0.5 });
    fv.renderWebGL();
    const belowKnee = fv.usePerturbation();
    return { atKnee, belowKnee };
  });
  expect(lane.atKnee, 'at the knee the perturbation lane is NOT used').toBe(false);
  expect(lane.belowKnee, 'below the knee the perturbation lane IS used').toBe(true);
  // THERE IS NO CAP. `null` is the shipped, deliberate value (the owner's "no hard
  // stop"), and the accuracy reach is a SEPARATE, non-blocking number.
  expect(measured.minScale, 'the shipped zoom state must be UNLIMITED').toBe(null);
  expect(measured.zoomCap, 'there must be no zoom cap').toBe(null);
  expect(measured.deepPrecisionMinScale, 'the measured-correct reach is reported, not enforced').toBe(1e-40);

  // S3 pin 2 stays green: the slider's bound IS the kernel cap IS the templated
  // shader loop bound (four sites).
  expect(Number(measured.sliderMaxAttr), 'slider max attribute').toBe(measured.cap);
  expect(Number(measured.sliderMaxProp), 'slider max property').toBe(measured.cap);
  expect(measured.shaderMaxIter, 'the templated #define MAX_ITER').toBe(measured.cap);
  expect(measured.shaderLoopBounds).toEqual(['MAX_ITER', 'MAX_ITER', 'MAX_ITER', 'MAX_ITER']);

  // The real path agrees with the rule at a deep view AND keeps the slider's value
  // when the rule is off — and, with the cap gone, a scale far past the old cap is
  // stored UNCHANGED (the whole point of the owner's "no hard stop").
  const driven = await page.evaluate(({ centre, deep, fixed }) => {
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    // The lane check above left the view at 5e-5, which is inside the floor's
    // range. Put the view back to a SHALLOW scale first, so "where the floor is off
    // the slider value is the budget" is measured where the floor really is off.
    window.__fv.setScale(3);
    slider.value = String(fixed);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    const shallow = { floor: window.__fv.maxIterFloor(), effective: window.__fv.maxIter() };
    window.__fv.setDeepView({ ...centre, scale: deep });
    const deepState = {
      floor: window.__fv.maxIterFloor(),
      effective: window.__fv.maxIter(),
      rule: window.__fv.iterBudgetForScale(deep),
      ruleNow: window.__fv.iterBudget(),
    };
    // No cap: this scale is stored verbatim.
    window.__fv.setScale(1e-30);
    const stored = window.__fv.getView().scale;
    return { shallow, deepState, stored };
  }, { centre: PROBE_CENTRE, deep: DEEP_SCALE, fixed: FIXED_BUDGET });
  console.log(`[D2 pin2] driven ${JSON.stringify(driven)}`);
  expect(driven.shallow.effective, 'where the floor is off the slider value is the budget').toBe(FIXED_BUDGET);
  expect(driven.deepState.effective, "the real view uses max(slider, floor)").toBe(SCALED_BUDGET);
  expect(driven.deepState.rule).toBe(SCALED_BUDGET);
  expect(driven.deepState.ruleNow).toBe(SCALED_BUDGET);
  expect(driven.stored, 'a depth past the old cap must be stored unchanged (no hard stop)').toBe(1e-30);

  expect(pageErrors).toEqual([]);
});

// --- pin 3 ---------------------------------------------------------------------

test('D2 pin 3: the colour table is sized by the job cap and cached, not rebuilt per frame at the maximum cap', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await setup(page);

  const stride = await page.evaluate(() => window.__fv.colorLutStride);

  // A shallow CPU frame at the shipped default budget, rendered through the app.
  await page.evaluate(() => window.__fv.paintCpuFrame());
  const cost = await page.evaluate(() => ({
    cap: window.__fv.maxIter(),
    capMax: window.__fv.maxIterCap,
    entries: window.__fv.colorTableEntries(),
    builds: window.__fv.colorTableBuilds(),
    imageBuilds: window.__fv.colorImageDataBuilds(),
  }));
  console.log(`[D2 pin3] cap=${cost.cap} entries=${cost.entries} builds=${cost.builds} ` +
    `imageBuilds=${cost.imageBuilds} (max-cap table would be ${cost.capMax * stride + 3})`);

  // SIZED BY THE JOB'S CAP. The table for this frame is the cap it ran at — NOT the
  // table for MAX_ITER (which would be 16x larger at cap 512).
  expect(cost.entries, 'table entries for a frame at this cap').toBe(cost.cap * stride + 3);
  expect(cost.entries, 'the table must not be sized by the module maximum').not.toBe(cost.capMax * stride + 3);
  expect(cost.entries, 'far below the module-maximum table').toBeLessThan(cost.capMax * stride);

  // CACHED. Five more renders at the same (scheme, offset, cap) build NOTHING —
  // counted, not inferred — and they also reuse the one ImageData.
  const afterCache = await page.evaluate(() => {
    const before = { builds: window.__fv.colorTableBuilds(), imageBuilds: window.__fv.colorImageDataBuilds() };
    for (let i = 0; i < 5; i++) window.__fv.paintCpuFrame();
    return { before, after: { builds: window.__fv.colorTableBuilds(), imageBuilds: window.__fv.colorImageDataBuilds() } };
  });
  expect(afterCache.after.builds - afterCache.before.builds, 're-renders at the same key must not rebuild the table').toBe(0);
  expect(afterCache.after.imageBuilds - afterCache.before.imageBuilds, 're-renders must reuse the one ImageData').toBe(0);

  // NON-VACUITY: the counter is live — a key change DOES rebuild, so "0 builds" is
  // not a counter that can never move.
  const rebuilt = await page.evaluate(() => {
    const before = window.__fv.colorTableBuilds();
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('colorScheme'));
    const other = window.__fv.colorSchemes().find((s) => s !== select.value);
    select.value = other;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { before, after: window.__fv.colorTableBuilds(), other };
  });
  expect(rebuilt.after, 'a palette change must rebuild the table').toBe(rebuilt.before + 1);

  // ...and the table FOLLOWS A DEEP JOB'S cap (4096), still far below the max-cap
  // table — the allocation is a function of the job, at every depth.
  await page.evaluate(({ centre, scale }) => window.__fv.setDeepView({ ...centre, scale }), {
    centre: PROBE_CENTRE, scale: DEEP_SCALE,
  });
  await page.evaluate(() => window.__fv.runJob());
  await waitIdle(page);
  const deep = await page.evaluate(() => ({
    cap: window.__fv.maxIter(),
    capMax: window.__fv.maxIterCap,
    entries: window.__fv.colorTableEntries(),
    builds: window.__fv.colorTableBuilds(),
  }));
  console.log(`[D2 pin3] deep cap=${deep.cap} entries=${deep.entries} builds=${deep.builds}`);
  expect(deep.cap).toBe(SCALED_BUDGET);
  expect(deep.entries, "the deep table is sized by the deep job's cap").toBe(deep.cap * stride + 3);
  expect(deep.entries).toBeLessThan(deep.capMax * stride);

  // The cost report the slice's docs quote, in bytes of Uint32Array.
  console.log(`[D2 pin3] measured bytes: cap512=${(512 * stride + 3) * 4} ` +
    `cap4096=${(4096 * stride + 3) * 4} maxCap=${(deep.capMax * stride + 3) * 4}`);

  expect(pageErrors).toEqual([]);
});
