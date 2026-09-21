// @ts-check
// D1 / smooth colour — colour is a CONTINUOUS function of the escape value, shared
// by both renderers, so a precision hop cannot be amplified into a colour pop.
//
// Before D1 colour was a STEP function of the INTEGER iteration count in both
// renderers: `fractalViewer.js` built `Uint32Array(maxIter + 2)` — one entry per
// integer iteration — and `webglFractal.js` coloured `float(iter)/float(u_maxIter)`.
// A staircase AMPLIFIES a precision hop: a change far smaller than one iteration
// can push a pixel across a step and flip it a whole colour band, and those pixels
// cluster at the fractal boundary — exactly what is on screen when zooming. The
// pins below are behavioural: they observe the colour the renderer produces and the
// escape value the worker produced, never the shape of the implementation.
//
// Harness style is the existing one (tests/kernel-parity.spec.js,
// tests/worker-lifecycle.spec.js): the real app in the real browser, driven through
// the real UI and the real worker, observed through the frozen `window.__fv`
// surface. `colorForValue`/`iterBufferAll`/`renderShiftedBuffer` are the D1
// observation hooks in public/app.js; they run the production colour path, they do
// not add one.
//
// A small viewport keeps the sweep cheap; every number below was MEASURED on this
// host, and the landing report records the deliberately broken builds that turn
// each pin RED.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 200, height: 150 } });

// A coastal centre on the Mandelbrot boundary whose escape field stays structured
// all the way to the zoom cap (measured: at scale 1e-4 the values still span ~20
// iterations at a cap of 50, so the deepest step is not a blank frame).
const COAST = { centerX: -0.795, centerY: 0.18 };

// The cap the band-size pins use. A SMALL cap makes one iteration a large colour
// step (255/50 ≈ 5 RGB units for grayscale), which is what makes a staircase
// visible in 8-bit at all; at maxIter 2000 a single step is 0.13 units and the
// staircase hides inside the display's own quantisation.
const BAND_CAP = 50;

// The scale sweep: 0.05 down to the cap's own minimum (1/10000), log-spaced.
const SWEEP_LO = 0.05;
const SWEEP_STEPS = 14;

async function waitIdle(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv.jobToken()), { timeout: 60_000 })
    .toBe(null);
}

// Boot the app, put it on the CPU renderer (deterministic pixels, no GPU
// timing), select the type/palette through the real UI and run ONE real job.
async function setup(page, { scheme = 'grayscale', type = 'mandelbrot', cap = BAND_CAP, view = COAST, scale = SWEEP_LO } = {}) {
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await page.uncheck('#webglRender');
  await page.evaluate(({ scheme, type, cap, view, scale }) => {
    const schemeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('colorScheme'));
    schemeSelect.value = scheme;
    schemeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const typeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('fractalType'));
    typeSelect.value = type;
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    slider.value = String(cap);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    window.__fv.setView({ ...view, scale });
  }, { scheme, type, cap, view, scale });
  await waitIdle(page);
  await page.evaluate(() => window.__fv.runJob());
  await waitIdle(page);
}

// Run one job at the current view and hand back the canvas pixels and the escape
// buffer the worker produced for it.
async function frame(page) {
  return page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return {
      px: Array.from(px),
      vals: window.__fv.iterBufferAll(),
      cap: window.__fv.maxIter(),
      width: c.width,
      height: c.height,
      view: window.__fv.getView(),
    };
  });
}

const channelDelta = (a, b, k) => Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2]));

// --- pin 1 ---------------------------------------------------------------------

test('D1 pin 1: colour is continuous in the escape value, in every palette', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await setup(page);

  const measured = await page.evaluate(() => {
    const fv = window.__fv;
    const cap = fv.maxIter();
    const out = {};
    for (const scheme of fv.colorSchemes()) {
      const select = /** @type {HTMLSelectElement} */ (document.getElementById('colorScheme'));
      select.value = scheme;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      let fineMax = 0, fineAt = null, oneMax = 0, tableResidual = 0;
      // At EVERY integer boundary in a wide range: a hop of 0.01 iterations
      // (1/100 of a colour band) must barely move the colour, while a whole
      // iteration moves it by the palette's band.
      for (let n = 1; n <= 30; n++) {
        for (const d of [0.001, 0.01]) {
          const a = fv.colorForValue(n - d, cap);
          const b = fv.colorForValue(n + d, cap);
          const delta = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
          if (delta > fineMax) { fineMax = delta; fineAt = { n, d }; }
        }
        const lo = fv.colorForValue(n, cap);
        const hi = fv.colorForValue(n + 1, cap);
        const one = Math.max(Math.abs(lo[0] - hi[0]), Math.abs(lo[1] - hi[1]), Math.abs(lo[2] - hi[2]));
        oneMax = Math.max(oneMax, one);
      }
      // The table the render writes must be the continuous definition, sampled:
      // the quantisation residual must stay inside one display unit.
      for (let v = 0.5; v < cap - 0.5; v += cap / 400) {
        const table = fv.colorForValue(v, cap);
        const exact = fv.colorAtSmoothIteration(v, cap);
        tableResidual = Math.max(tableResidual,
          Math.abs(table[0] - exact[0]), Math.abs(table[1] - exact[1]), Math.abs(table[2] - exact[2]));
      }
      out[scheme] = { fineMax, fineAt, oneMax, tableResidual };
    }
    return out;
  });
  console.log('[D1 pin1] ' + Object.entries(measured)
    .map(([s, m]) => `${s}=fine${m.fineMax}/oneMax${m.oneMax}/table${m.tableResidual}`).join(' '));

  // The palette must really have a band for the comparison to mean anything.
  const worstOneMax = Math.max(...Object.values(measured).map((m) => m.oneMax));
  expect(worstOneMax, 'the palettes must have a resolvable one-iteration colour step').toBeGreaterThanOrEqual(3);

  for (const [scheme, m] of Object.entries(measured)) {
    // A hop 100x smaller than a band must be a small colour change in absolute
    // terms (measured correct: 1 unit out of 255)...
    expect(m.fineMax, `${scheme}: colour change over a 0.01-iteration hop`).toBeLessThanOrEqual(3);
    // ...AND it must be proportional to the hop: under a staircase the whole
    // band arrives at once, so this ratio is 1.
    expect(m.fineMax / m.oneMax, `${scheme}: hop change as a fraction of the band`).toBeLessThanOrEqual(0.35);
    // The table the pixel loop writes is the continuous definition sampled at the
    // kernel's stride: the quantisation residual is under one display unit.
    expect(m.tableResidual, `${scheme}: table-vs-exact colour residual (RGB units)`).toBeLessThanOrEqual(1);
  }

  // The escape values the WORKER produced are themselves continuous: if the
  // pipeline still quantised them to integers, the colours above would be
  // continuous on paper while every pixel sat on a step.
  const data = await page.evaluate(() => {
    const vals = window.__fv.iterBufferAll();
    const cap = window.__fv.maxIter();
    let finite = 0, fractional = 0;
    for (const v of vals) {
      if (v === null || v !== v || v >= cap) continue;
      finite++;
      if (v !== Math.floor(v)) fractional++;
    }
    return { finite, fractional, frac: finite ? fractional / finite : 0 };
  });
  console.log(`[D1 pin1] buffer: ${data.finite} escaped cells, fractional fraction ${data.frac.toFixed(4)}`);
  expect(data.finite, 'the frame must contain escaped cells').toBeGreaterThan(1000);
  // Measured correct: 1.0000. A worker that wrote integer counts gives 0.
  expect(data.frac, 'escaped escape values must carry sub-iteration information').toBeGreaterThan(0.9);

  expect(pageErrors).toEqual([]);
});

// --- pin 2 ---------------------------------------------------------------------

test('D1 pin 2: a sub-iteration precision hop stays invisible on screen', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await setup(page);

  const result = await page.evaluate(() => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
    const ctx = canvas.getContext('2d');
    const read = () => ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const cap = window.__fv.maxIter();
    const band = 255 / cap; // grayscale: one iteration = one band
    window.__fv.captureShiftBaseline();
    const vals = window.__fv.iterBufferAll();
    const before = read();
    // A precision hop: the SAME frame, every escape value moved by HALF an
    // iteration (the size of hop a rebased reference orbit or a float32 rounding
    // difference produces). Rendered through the real colour path.
    window.__fv.renderShiftedBuffer(0.5);
    const after = read();
    let measured = 0, nearCap = 0, over = 0, maxDelta = 0, blank = true;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v === null || v !== v) continue;
      const k = i * 4;
      if (before[k] || before[k + 1] || before[k + 2]) blank = false;
      // When the hop moves a pixel across the inside-the-set test the colour
      // change is the classification itself, which is correct rendering, not the
      // colour staircase. Those pixels are reported, not measured.
      if (v + 0.5 >= cap) { nearCap++; continue; }
      measured++;
      const delta = Math.max(Math.abs(before[k] - after[k]), Math.abs(before[k + 1] - after[k + 1]), Math.abs(before[k + 2] - after[k + 2]));
      if (delta > maxDelta) maxDelta = delta;
      if (delta > band * 0.8) over++;
    }
    window.__fv.clearShiftBaseline();
    return { measured, nearCap, over, overFrac: over / Math.max(1, measured), maxDelta, band, limit: band * 0.8, blank };
  });
  console.log(`[D1 pin2] measured=${result.measured} nearCap=${result.nearCap} over=${result.over} ` +
    `maxDelta=${result.maxDelta} limit=${result.limit.toFixed(2)} (band=${result.band.toFixed(2)})`);

  expect(result.blank, 'the frame must not be blank').toBe(false);
  // Non-vacuity: the hop must actually have been applied to a real population of
  // pixels.
  expect(result.measured, 'the hop must be measured over a real frame').toBeGreaterThan(5_000);
  // STATED THRESHOLD. Measured correct: 0 of 26 003 pixels exceed 0.8 band, and
  // the maximum change is 3 units (half an iteration of grayscale at cap 50 is
  // 2.55 units, plus one unit of display rounding). A staircase moves ~half the
  // pixels by a whole band (5 units), so `overFrac` jumps to ~0.5.
  expect(result.overFrac, 'fraction of pixels that flipped a colour band for a half-iteration hop').toBeLessThan(0.01);
  expect(result.maxDelta, 'the largest single-pixel colour change caused by the hop').toBeLessThanOrEqual(result.limit);

  expect(pageErrors).toEqual([]);
});

// --- pin 3 ---------------------------------------------------------------------

test('D1 pin 3: no hop while zooming, at any step including the cap boundary', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await setup(page);

  const minScale = await page.evaluate(() => window.__fv.minScale);
  const scales = [];
  for (let i = 0; i <= SWEEP_STEPS; i++) scales.push(SWEEP_LO * Math.pow(minScale / SWEEP_LO, i / SWEEP_STEPS));
  // The last step IS the cap's own minimum scale.
  scales[scales.length - 1] = minScale;

  const rows = [];
  for (const scale of scales) {
    await page.evaluate(({ view, scale }) => window.__fv.setView({ ...view, scale }), { view: COAST, scale });
    await page.evaluate(() => window.__fv.runJob());
    await waitIdle(page);
    const row = await page.evaluate(() => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
      const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const cur = { vals: window.__fv.iterBufferAll(), cap: window.__fv.maxIter(), scale: window.__fv.getView().scale, px: Array.from(px) };
      const prev = window.__d1Prev;
      let stats = { scale: cur.scale, placeholder: 0, finite: 0, small: 0, hop: 0, meanStep: 0, maxStep: 0 };
      for (let i = 0; i < cur.vals.length; i++) {
        const v1 = cur.vals[i];
        if (v1 === null || v1 !== v1) stats.placeholder++;
      }
      if (prev) {
        let sum = 0, n = 0;
        for (let i = 0; i < cur.vals.length; i++) {
          const v0 = prev.vals[i], v1 = cur.vals[i];
          const k = i * 4;
          const d = Math.max(
            Math.abs(prev.px[k] - cur.px[k]),
            Math.abs(prev.px[k + 1] - cur.px[k + 1]),
            Math.abs(prev.px[k + 2] - cur.px[k + 2]),
          );
          sum += d; n++;
          if (d > stats.maxStep) stats.maxStep = d;
          if (v0 === null || v1 === null || v0 !== v0 || v1 !== v1) continue;
          if (v0 >= prev.cap || v1 >= cur.cap) continue;
          stats.finite++;
          const dv = Math.abs(v1 - v0);
          if (dv < 0.5) {
            stats.small++;
            // The colour change a proportional mapping implies for this pixel,
            // plus 2 units of display rounding. Grayscale: one iteration is one
            // band, so `dv/cap` is the fraction of a band.
            if (d > (dv / cur.cap) * 255 + 2) stats.hop++;
          }
        }
        stats.meanStep = sum / n;
      }
      stats.hopFrac = stats.hop / Math.max(1, stats.finite);
      stats.smallFrac = stats.small / Math.max(1, stats.finite);
      window.__d1Prev = cur;
      return stats;
    });
    // The first step has no predecessor, so it only contributes its placeholder
    // count; every later step is a real step-to-step comparison.
    if (rows.length || row.meanStep > 0 || row.finite > 0) rows.push(row);
  }
  for (const r of rows) {
    console.log(`[D1 pin3] scale=${r.scale.toExponential(2)} finite=${r.finite} small=${r.small} ` +
      `hop=${r.hop} meanStep=${r.meanStep.toFixed(2)} placeholder=${r.placeholder}`);
  }
  const steps = rows.filter((r) => r.finite > 0);
  console.log(`[D1 pin3] ${steps.length} comparable steps, max hopFrac ${Math.max(...steps.map((r) => r.hopFrac)).toFixed(4)}`);

  // Every completed frame is a COMPLETED frame: no cell is still "not calculated".
  for (const r of rows) {
    expect(r.placeholder, `scale ${r.scale}: a finished frame must contain no uncalculated cells`).toBe(0);
  }
  // The sweep must really compare frames, with a large population of pixels that
  // moved by less than half an iteration (otherwise "no hop" is vacuous).
  expect(steps.length, 'the sweep must produce comparable steps').toBeGreaterThanOrEqual(SWEEP_STEPS - 2);
  const nonVacuous = steps.filter((r) => r.small > 500);
  expect(nonVacuous.length, 'steps with a real population of sub-iteration moves').toBeGreaterThanOrEqual(8);
  const minSmallFrac = Math.min(...steps.map((r) => r.smallFrac));
  console.log(`[D1 pin3] smallest sub-iteration population ${(minSmallFrac * 100).toFixed(1)}% of escaped pixels`);
  expect(minSmallFrac, 'sub-iteration moves must be a substantial part of the frame').toBeGreaterThan(0.2);

  // THE PIN. No step may show a colour change a proportional mapping cannot
  // explain (measured correct: 0 at every step; a staircase: 2-5% of ALL escaped
  // pixels per step).
  for (const r of steps) {
    expect(r.hopFrac, `scale ${r.scale}: fraction of pixels that hopped a band`).toBeLessThanOrEqual(0.01);
  }

  // The owner's acceptance criterion, as a bound: the step that crosses the cap
  // must not be an OUTLIER in how much the image changes. (This bound alone is
  // not the discriminator — the frame-difference is dominated by genuine image
  // change; the hop fraction above is. It is recorded because "no spike at the
  // boundary" is the literal requirement.)
  const boundary = steps[steps.length - 1];
  const others = steps.slice(0, -1);
  const median = [...others.map((r) => r.meanStep)].sort((a, b) => a - b)[Math.floor(others.length / 2)];
  console.log(`[D1 pin3] boundary meanStep=${boundary.meanStep.toFixed(2)} median=${median.toFixed(2)} ` +
    `maxOther=${Math.max(...others.map((r) => r.meanStep)).toFixed(2)}`);
  expect(boundary.meanStep, 'the cap-boundary step must not change the image more than the other steps do')
    .toBeLessThanOrEqual(Math.max(median * 3, Math.max(...others.map((r) => r.meanStep))));

  expect(pageErrors).toEqual([]);
});

// --- pin 4 ---------------------------------------------------------------------

test('D1 pin 4: inside the set is black and an uncalculated cell is the placeholder', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await setup(page);

  // (a) The kernel's definition: a point that never escaped is EXACTLY maxIter,
  // which is what both renderers test for "inside".
  const kernel = await page.evaluate(() => {
    const cap = window.__fv.maxIter();
    return {
      cap,
      neverEscaped: window.__fv.smoothValue(500, cap + 1, cap),
      escaped: window.__fv.smoothValue(1e6, 5, cap),
      insidePoint: window.__fv.smoothPixel('mandelbrot', 0, 0, cap, 0, 0),
      // A point just outside the set must NOT be reported as inside.
      outsidePoint: window.__fv.smoothPixel('mandelbrot', 2, 2, cap, 0, 0),
    };
  });
  console.log('[D1 pin4] kernel ' + JSON.stringify(kernel));
  expect(kernel.neverEscaped).toBe(kernel.cap);
  expect(kernel.insidePoint).toBe(kernel.cap);
  expect(kernel.escaped).toBeLessThan(kernel.cap);
  expect(kernel.outsidePoint).toBeLessThan(kernel.cap);

  // (b) A real frame: every cell whose value is exactly maxIter renders black.
  const frameCheck = await page.evaluate(() => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
    const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const vals = window.__fv.iterBufferAll();
    const cap = window.__fv.maxIter();
    let inside = 0, black = 0, notBlack = 0, firstBad = null;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] !== cap) continue;
      inside++;
      const k = i * 4;
      if (px[k] === 0 && px[k + 1] === 0 && px[k + 2] === 0) black++;
      else { notBlack++; if (firstBad === null) firstBad = [px[k], px[k + 1], px[k + 2]]; }
    }
    return { inside, black, notBlack, firstBad };
  });
  console.log('[D1 pin4] real frame ' + JSON.stringify(frameCheck));
  expect(frameCheck.inside, 'the view must contain real set interior').toBeGreaterThan(100);
  expect(frameCheck.notBlack, 'every inside-the-set cell must be black').toBe(0);

  // (c) The uncalculated sentinel: an all-NaN buffer must render as the fixed
  // placeholder, through the sentinel path and not through the palette lookup.
  const placeholder = await page.evaluate(() => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
    const ctx = canvas.getContext('2d');
    window.__fv.captureShiftBaseline();
    window.__fv.renderShiftedBuffer(NaN);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const want = window.__fv.uncalculatedColor();
    let match = 0, n = 0, black = 0;
    for (let i = 0; i < px.length; i += 4) {
      n++;
      if (px[i] === want[0] && px[i + 1] === want[1] && px[i + 2] === want[2]) match++;
      if (px[i] === 0 && px[i + 1] === 0 && px[i + 2] === 0) black++;
    }
    window.__fv.clearShiftBaseline();
    // The same colour must come back from the value→colour API for the sentinel,
    // so "NaN renders as the placeholder" is a property of the one mapping and
    // not of a branch buried in the render loop.
    const viaApi = window.__fv.colorForValue(NaN, window.__fv.maxIter());
    return { want, match, n, black, matchFrac: match / n, viaApi };
  });
  console.log('[D1 pin4] placeholder ' + JSON.stringify(placeholder));
  expect(placeholder.matchFrac, 'every uncalculated cell must render as the placeholder').toBe(1);
  // The placeholder is its own value: not black (inside), and reachable only
  // through the sentinel path.
  expect(placeholder.black, 'the uncalculated placeholder must not be the inside black').toBe(0);
  expect(placeholder.want, 'the placeholder must not be black').not.toEqual([0, 0, 0]);
  expect(placeholder.viaApi, 'the value→colour API must return the placeholder for NaN').toEqual(placeholder.want);

  expect(pageErrors).toEqual([]);
});

// --- pin 5 ---------------------------------------------------------------------

test('D1 pin 5: the GPU evaluates the identical smooth expression with the same constants', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  // The renderer is built one macrotask after startup; poll rather than read it
  // synchronously (the same convention tests/kernel-parity.spec.js uses).
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderSource()), { timeout: 10_000 })
    .not.toBe(null);

  const shader = await page.evaluate(() => ({
    source: window.__fv.shaderSource(),
    templated: window.__fv.shaderSmoothLogBailout(),
    kernel: window.__fv.smoothLogBailout,
    bailoutSq: window.__fv.bailoutSq,
    loopBounds: window.__fv.shaderLoopBounds(),
  }));
  const src = shader.source;
  expect(typeof src).toBe('string');

  // The constants are templated from the kernel's own values, not restated.
  expect(shader.templated, 'the SMOOTH_LOG_BAILOUT templated into the GLSL').toBe(Math.fround(shader.kernel));
  expect(shader.bailoutSq).toBeGreaterThan(0);
  expect(src).toContain('#define SMOOTH_LOG_BAILOUT ' + Math.fround(shader.kernel));
  // The smooth value is the SAME expression as the kernel's, on the same
  // `iter + 1` convention and the same escape magnitude the test fired on.
  expect(src, 'the GPU smooth value must be n + 1 - log2(log(|z|^2)/log(BAILOUT_SQ))')
    .toContain('float n = float(iter) + 1.0;');
  expect(src).toContain('float smooth = n + 1.0 - log(log(escapeRadiusSq) * SMOOTH_LOG_BAILOUT) / log(2.0);');
  // The escape magnitude is the quantity the iteration test fires on, at all
  // four fractal-type sites.
  const radiusSites = src.match(/escapeRadiusSq = x \* x \+ y \* y;/g) || [];
  expect(radiusSites, 'all four loops must capture the escape magnitude').toHaveLength(4);
  const bailoutSites = src.match(/escapeRadiusSq > BAILOUT_SQ/g) || [];
  expect(bailoutSites, 'all four loops must test the shared squared bailout').toHaveLength(4);
  // The colour parameter comes from the SMOOTH value, and colour cycling applies
  // to it.
  expect(src).toContain('float t = smooth / float(u_maxIter);');
  expect(src).toContain('t = mod(t + u_colorOffset, 1.0);');
  // Inside the set is still tested on the iteration count and still black.
  expect(src).toContain('if (iter == u_maxIter)');
  // The four loop bounds still come from the ONE cap (S3 pin 2 is untouched).
  expect(shader.loopBounds).toEqual(['MAX_ITER', 'MAX_ITER', 'MAX_ITER', 'MAX_ITER']);

  // A shader that fails to compile falls back to the CPU silently, which is
  // exactly how a GLSL int/float type error hides. Nothing may have been logged.
  expect(pageErrors).toEqual([]);

  // (b) A REAL GPU/CPU comparison at a cap where one iteration is a whole colour
  // band. The comparison is made at IDENTICAL complex coordinates — each GPU
  // fragment's own centre — because the CPU kernel samples pixel corners while the
  // shader samples fragment centres (the documented S3 residual), and at low
  // iteration counts that half-pixel offset alone is worth an iteration. Predicted
  // colour comes from the kernel's own value→colour path, so what this checks is
  // that the SHADER's expression agrees with the KERNEL's, not that two different
  // sampling conventions agree.
  //
  // This is the net that catches a GPU-side staircase: at maxIter 2000 one
  // iteration is 0.13 of an RGB unit, so the S3 per-pixel parity pins (mean |Δ| <
  // 6) cannot see it at all — measured with the GPU put back on `float(iter)`,
  // S3 pins 1 and 3 stayed GREEN.
  await page.evaluate(() => {
    const schemeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('colorScheme'));
    schemeSelect.value = 'grayscale';
    schemeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const view = window.__fv.getView();
    window.__fv.setView({ ...view, centerX: -0.795, centerY: 0.18, scale: 0.05 });
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    slider.value = '50';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.uncheck('#webglRender');
  await waitIdle(page);
  await page.check('#webglRender');
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  await expect.poll(() => page.evaluate(() => window.__fv.liveRenderers()), { timeout: 10_000 }).toBe(1);
  const parity = await page.evaluate(() => {
    window.__fv.renderWebGL();
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
    const gl = canvas.getContext('webgl');
    if (!gl) return null;
    const w = canvas.width, h = canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const view = window.__fv.getView();
    const cap = window.__fv.maxIter();
    const aspect = w / h;
    const n = 32;
    let count = 0, sumAbs = 0, worst = 0, far = 0, insideAgree = true;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = Math.floor((i + 0.5) * w / n);
        // px is in readPixels order (row 0 = bottom), so the row read here IS the
        // fragment's own y. The coordinate below is therefore that fragment's
        // centre, which is exactly what the shader evaluates.
        const y = Math.floor((j + 0.5) * h / n);
        const x0 = view.centerX + ((x + 0.5) / w - 0.5) * view.scale * aspect;
        const y0 = view.centerY + ((1.0 - (y + 0.5) / h) - 0.5) * view.scale;
        const expected = window.__fv.colorForValue(window.__fv.smoothPixel('mandelbrot', x0, y0, cap, 0, 0), cap);
        const k = (y * w + x) * 4;
        const got = [px[k], px[k + 1], px[k + 2]];
        const d = Math.max(Math.abs(expected[0] - got[0]), Math.abs(expected[1] - got[1]), Math.abs(expected[2] - got[2]));
        count++;
        sumAbs += Math.abs(expected[0] - got[0]) + Math.abs(expected[1] - got[1]) + Math.abs(expected[2] - got[2]);
        if (d > worst) worst = d;
        if (d > 8) far++;
        // Both must call the point inside when the kernel does.
        if (expected[0] === 0 && expected[1] === 0 && expected[2] === 0 && (got[0] || got[1] || got[2])) insideAgree = false;
      }
    }
    return { count, meanAbs: sumAbs / (count * 3), worst, farFrac: far / count, insideAgree };
  });
  expect(parity, 'the WebGL renderer must be usable for this comparison').not.toBe(null);
  console.log(`[D1 pin5] GPU-vs-kernel at cap 50: meanAbs=${parity.meanAbs.toFixed(3)} worst=${parity.worst} farFrac=${parity.farFrac.toFixed(3)}`);
  // Measured correct: meanAbs 0.1, worst 1, farFrac 0 (a one-iteration formula
  // error is a whole 5-unit band at this cap).
  expect(parity.meanAbs, 'per-channel |GPU pixel - kernel colour| at a cap where one iteration is visible').toBeLessThan(3);
  expect(parity.farFrac, 'fraction of samples off by more than a band').toBeLessThan(0.05);
  expect(parity.insideAgree, 'the GPU must call a point inside exactly when the kernel does').toBe(true);

  expect(pageErrors).toEqual([]);
});
