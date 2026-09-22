// @ts-check
// ITER-CAP — the owner's request, verbatim: "Iterations max needs to be much
// bigger, lets say 100000, for deep zooms. Also double the auto-iterations please."
//
//   (1) MAX_ITER 8192 -> 100000 (public/fractalKernel.js)
//   (2) ITER_BUDGET_PER_DECADE 512 -> 1024 (the auto rule's slope)
//
// Neither is a step: the LANE-CONTINUITY continuous ramp and the owner's "no hard
// stop" (docs/DECISIONS.md row 62) are untouched — a CEILING and a SLOPE moved, not
// a boundary introduced.
//
// THE PRECONDITION THIS SPEC EXISTS FOR. The reference orbit reaches the GPU as a
// FLOAT TEXTURE and was 1D, so its width was `min(MAX_TEXTURE_SIZE, MAX_ITER)` =
// 8192 while the caps of DECISIONS 95. Raising MAX_ITER without changing that would
// have left every iteration past 8192 re-sampling the LAST reference value: the
// reference FREEZES and those iterations are WRONG, not merely unhelpful. The fix is
// a 2D orbit texture (row width <= MAX_TEXTURE_SIZE, up to MAX_TEXTURE_SIZE rows,
// so the transport carries MAX_TEXTURE_SIZE^2 samples and is decoupled from
// MAX_ITER). Pin 3 asserts the reference cannot freeze AND shows the frozen
// behaviour as an in-pin failing baseline.
//
// THE FAILING BASELINE FOR (1) AND (2) IS THE PRE-CHANGE BUILD: `maxIterCap` was
// 8192 and `iterBudgetForScale` returned exactly HALF of every anchor asserted here.
// Both assertions below are false on that build by construction.
const { test, expect } = require('@playwright/test');

const OLD_CAP = 8192;             // the pre-change cap and the pre-change transport width
const NEW_CAP = 100000;           // the owner's requested ceiling
const OLD_PER_DECADE = 512;       // the pre-change slope
const NEW_PER_DECADE = 1024;      // "double the auto-iterations"

// A float64-lane centre whose reference orbit escapes LATE (iteration 12562, found
// by search near the COAST view). It makes "the transported reference really extends
// past index 8192" a non-vacuous statement: the old 1D width could not hold it.
const LATE_ESCAPE_X = -0.7436438870372314;
const LATE_ESCAPE_Y = 0.1318259042053147;
const LATE_ESCAPE_SCALE = 1e-15;  // float64 deep lane (the BigInt lane opens below 1e-15)

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderSource()), { timeout: 10_000 })
    .not.toBe(null);
}

async function setSlider(page, value) {
  await page.evaluate((v) => {
    const s = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expect
    .poll(() => page.evaluate(() => window.__fv.jobToken()), { timeout: 120_000 })
    .toBe(null);
}

// --- pin 1: the cap is 100000 and the slider / clamp / shader agree --------------

test('ITER-CAP pin 1: the ONE iteration cap is 100000 and the slider, the clamp and the shader all say so', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  const cap = await page.evaluate(() => window.__fv.maxIterCap);
  console.log(`[iter-cap pin1] cap=${cap} (pre-change ${OLD_CAP})`);
  // THE CEILING. False on the pre-change build.
  expect(cap, 'the ONE cap').toBe(NEW_CAP);
  expect(cap, 'the cap must be bigger than the old one').toBeGreaterThan(OLD_CAP);

  const ui = await page.evaluate(() => {
    const s = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    return {
      attr: Number(s.getAttribute('max')),
      prop: s.max,
      shader: window.__fv.shaderMaxIter(),
      loops: window.__fv.shaderLoopBounds(),
    };
  });
  expect(ui.attr, 'slider max attribute').toBe(cap);
  expect(Number(ui.prop), 'slider max property').toBe(cap);
  expect(ui.shader, 'the value templated into #define MAX_ITER').toBe(cap);
  expect(ui.loops).toEqual(['MAX_ITER', 'MAX_ITER', 'MAX_ITER', 'MAX_ITER']);

  // The ONE clamp also holds at the top: a value past the cap is clamped to the cap,
  // not stored. (The hostile-record path shares `clampMaxIter`.)
  await setSlider(page, cap + 12345);
  const clamped = await page.evaluate(() => window.__fv.maxIterFloor());
  expect(clamped, 'the floor is clamped to the ONE cap').toBe(cap);
  await setSlider(page, 512);

  expect(pageErrors).toEqual([]);
});

// --- pin 2: the auto rule at depth is EXACTLY double the old value ---------------

test('ITER-CAP pin 2: the auto-iteration rule is doubled at depth, with the ramp and the no-hard-stop intact', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  const out = await page.evaluate(({ oldPerDecade }) => {
    const fv = window.__fv;
    // The PRE-CHANGE rule, verbatim in-pin: same ramp, half the slope. It is the
    // failing baseline for this pin.
    const old = (scale) => {
      const decades = Math.log10(1 / scale);
      const ramp = Math.max(0, Math.min(1, decades - 4));
      if (!(ramp > 0)) return 1;
      return Math.max(1, Math.min(8192, Math.ceil(oldPerDecade * decades * ramp)));
    };
    const scales = [1e-5, 1e-6, 1e-7, 1e-8, 1e-12, 1e-15];
    const rows = scales.map((s) => ({ scale: s, shipped: fv.iterBudgetForScale(s), old: old(s) }));
    // Continuity: the largest adjacent change over a fine log sweep across the knee
    // and the ramp must stay small — doubling a slope must not introduce a step.
    const sweep = Array.from({ length: 241 }, (_, i) => 1e-3 * Math.pow(1e-6 / 1e-3, i / 240));
    let maxJump = 0;
    for (let i = 1; i < sweep.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(fv.iterBudgetForScale(sweep[i]) - fv.iterBudgetForScale(sweep[i - 1])));
    }
    return {
      rows, maxJump,
      perDecade: fv.iterBudgetPerDecade,
      atKnee: fv.iterBudgetForScale(1e-4),
      cap: fv.maxIterCap,
      // A depth far past any reachable view: the RULE, not the cap, decides.
      rulePastReach: fv.iterBudgetForScale(1e-20),
      deepScaleStored: (() => { fv.setScale(1e-45); return fv.getView().scale; })(),
    };
  }, { oldPerDecade: OLD_PER_DECADE });
  console.log(`[iter-cap pin2] perDecade=${out.perDecade} atKnee=${out.atKnee} maxJump=${out.maxJump} ` +
    `anchors=${out.rows.map((r) => r.scale + ':' + r.shipped + '/' + r.old).join(' ')}`);

  // THE SLOPE. Both the constant and the measured result are doubled.
  expect(out.perDecade, 'the slope constant').toBe(NEW_PER_DECADE);
  for (const r of out.rows) {
    expect(r.shipped, `the shipped budget at ${r.scale} must be EXACTLY double the pre-change value`)
      .toBe(r.old * 2);
  }
  // The numbers, stated at a few depths (old -> new).
  expect(out.rows[0].old).toBe(2560); expect(out.rows[0].shipped).toBe(5120);   // 1e-5
  expect(out.rows[1].shipped).toBe(6144);                                       // 1e-6
  expect(out.rows[3].shipped).toBe(8192);                                       // 1e-8
  expect(out.rows[5].shipped).toBe(15360);                                      // 1e-15

  // THE RAMP IS PRESERVED: the floor leaves zero AT the knee (no step), the largest
  // adjacent change over the sweep is a few dozen iterations (a reintroduced hard
  // step is thousands), and a depth far past any reachable view is unaffected.
  expect(out.atKnee, 'the floor departs from zero at the knee').toBe(1);
  expect(out.maxJump, 'the effective budget stays continuous across the knee').toBeLessThanOrEqual(200);
  expect(out.rulePastReach, 'the rule, not the cap, decides over the deep reach').toBeLessThan(out.cap);
  // NO HARD STOP (DECISIONS 62): no zoom cap, depth stored verbatim.
  const shipped = await page.evaluate(() => ({ minScale: window.__fv.minScale, zoomCap: window.__fv.zoomCap }));
  expect(shipped.minScale).toBe(null);
  expect(shipped.zoomCap).toBe(null);
  expect(out.deepScaleStored).toBe(1e-45);

  expect(pageErrors).toEqual([]);
});

// --- pin 3: the reference is NOT silently clamped --------------------------------
//
// THE FAILURE MODE. A 1D orbit texture of width min(MAX_TEXTURE_SIZE, MAX_ITER) =
// 8192 with a 100000 budget makes the shader sample the last texel for every
// iteration whose reference index m exceeds 8191. Those iterations are WRONG.
//
// THE MECHANISM PINNED HERE: the transport must CARRY maxIter + 1 values (a 2D
// texture: row width <= MAX_TEXTURE_SIZE, up to MAX_TEXTURE_SIZE rows), and the
// values past 8192 must be REAL (not a padded repeat of the last texel), so the
// shader never has to clamp the index. The pre-change build (or a build with the old
// 1D transport) reports length 8192 here and goes RED on `covered`.
//
// HONEST SCOPE, measured (and recorded in the landing report): at every STRUCTURED
// view measurable on this host the shader's reference index m stays well below 8192
// because REBASING resets it — a Misiurewicz reference reaches m ~ 230, a reference
// that escapes at 12562 reaches m ~ 3900, an escaping COAST reference is bounded by
// its own escape (3086). Only a uniformly-inside view drives m to the budget, and
// there the frame is uniform. So the freeze was a LATENT lie at these views, not an
// observable colour error; the transport is fixed because it must not be a function
// of a coincidence, and this pin reports the measured max m rather than claiming an
// effect it cannot see.

test('ITER-CAP pin 3: the deep-lane reference covers the budget — the orbit transport is not silently clamped', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  // A LATE-ESCAPING reference (escape iteration 12562, found by search): the
  // transported reference genuinely extends past 8192, so "the tail is real" is a
  // non-vacuous assertion about values the old width could not hold.
  await setSlider(page, NEW_CAP);
  await page.evaluate(({ x, y, scale }) => window.__fv.setDeepView({
    centerX: x, centerY: y, scale,
  }), { x: LATE_ESCAPE_X, y: LATE_ESCAPE_Y, scale: LATE_ESCAPE_SCALE });
  await page.evaluate(() => window.__fv.runJob());
  await expect
    .poll(() => page.evaluate(() => window.__fv.jobToken()), { timeout: 120_000 })
    .toBe(null);

  // ONE page task: the draw, the await and the readback must not be separated, or
  // compositing clears the (non-preserved) drawing buffer and the readback is black.
  const out = await page.evaluate(async ({ oldCap }) => {
    const fv = window.__fv;
    fv.renderWebGL();
    await fv.whenRenderSettled();
    const canvas = document.getElementById('fractalCanvasWebGL');
    const gl = canvas.getContext('webgl');
    const w = canvas.width, h = canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const orbit = fv.orbitValues();
    const view = fv.getView();
    const cap = fv.maxIter();
    const aspect = w / h;
    const zx = orbit.zx, zy = orbit.zy;
    const fullLen = orbit.length;
    // The reference's own escape iteration, counted from the transported values.
    let refEscape = -1;
    for (let k = 0; k < fullLen; k++) {
      if (zx[k] * zx[k] + zy[k] * zy[k] > 4) { refEscape = k; break; }
    }
    // The float64 PERTURBATION reference at one point, over the FULL transported
    // reference, using the shipped recurrence and rebasing rule.
    const refAt = (dcx, dcy) => {
      let dx = 0, dy = 0, m = 0, iter = 0, z2 = 0, maxM = 0;
      for (; iter < cap; iter++) {
        const Zx = zx[m], Zy = zy[m];
        const Z2 = Zx * Zx + Zy * Zy;
        z2 = Z2 + 2 * (Zx * dx + Zy * dy) + dx * dx + dy * dy;
        if (z2 > 4) break;
        const nx = 2 * (Zx * dx - Zy * dy) + (dx * dx - dy * dy) + dcx;
        const ny = 2 * (Zx * dy + Zy * dx) + (2 * dx * dy) + dcy;
        dx = nx; dy = ny; m++;
        if (m > maxM) maxM = m;
        if (m >= fullLen) break;
        const X = zx[m], Y = zy[m];
        const vx = X + dx, vy = Y + dy;
        if (vx * vx + vy * vy < dx * dx + dy * dy) { dx = vx; dy = vy; m = 0; }
      }
      return { v: iter >= cap ? cap : fv.smoothValue(z2, iter, cap), maxM };
    };
    // A coarse grid keeps the reference affordable while spanning the frame.
    const NX = 40, NY = 30;
    let dFull = 0, n = 0, maxM = 0, distinct = new Set();
    for (let j = 0; j < NY; j++) {
      const yv = Math.floor((j + 0.5) * h / NY);
      const dcy = ((1 - (yv + 0.5) / h) - 0.5) * view.scale;
      for (let i = 0; i < NX; i++) {
        const xv = Math.floor((i + 0.5) * w / NX);
        const dcx = ((xv + 0.5) / w - 0.5) * view.scale * aspect;
        const r = refAt(dcx, dcy);
        if (r.maxM > maxM) maxM = r.maxM;
        const want = fv.colorForValue(r.v, cap);
        distinct.add((want[0] << 16) | (want[1] << 8) | want[2]);
        // readPixels row j is the row whose shader `v_uv.y` gives the reference's
        // dcy for the same j (see tests/perturb-core.spec.js), so NO flip here.
        const k = (yv * w + xv) * 4;
        const got = [px[k], px[k + 1], px[k + 2]];
        dFull += (Math.abs(want[0] - got[0]) + Math.abs(want[1] - got[1]) + Math.abs(want[2] - got[2])) / 3;
        n++;
      }
    }
    return {
      cap, w, h, fullLen, orbitWidth: orbit.width, orbitRows: orbit.rows,
      source: fv.orbitSource(), refEscape,
      tail8192: zx[oldCap], tailAtCap: zx[cap], lastAtOld: zx[oldCap - 1],
      transport: fv.orbitTransport(),
      meanFull: dFull / n, maxM, distinct: distinct.size, n,
    };
  }, { oldCap: OLD_CAP });
  console.log(`[iter-cap pin3] cap=${out.cap} orbitLen=${out.fullLen} orbitW=${out.orbitWidth}x${out.orbitRows} ` +
    `src=${out.source} refEscapedAt=${out.refEscape} covered=${out.transport.covered} shortfall=${out.transport.shortfall} ` +
    `mean|GPU-fullRef|=${out.meanFull.toFixed(3)} maxRefIndex=${out.maxM} distinct=${out.distinct}`);

  // THE TRANSPORT (the mechanism). The deep lane really carried the whole budget; a
  // 1D transport reports length 8192 here and `covered` is false — the orbit-frozen
  // failure mode this assertion exists to catch.
  expect(out.transport, 'the transport must be observable').not.toBe(null);
  expect(out.transport.budget, 'the deep lane ran at the requested budget').toBe(out.cap);
  expect(out.transport.length, 'the transported reference covers Z_0 .. Z_cap (no silent clamp)')
    .toBeGreaterThanOrEqual(out.cap + 1);
  expect(out.transport.covered, 'the shader never has to clamp the reference index').toBe(true);
  expect(out.transport.shortfall, 'nothing was dropped').toBe(0);
  expect(out.fullLen, 'Z_0 .. Z_cap really are transported').toBe(out.cap + 1);
  expect(out.fullLen).toBeGreaterThan(OLD_CAP);
  // The values PAST the old 8192 width are real reference values, not a padded
  // repeat of the last one the old transport could hold.
  expect(out.refEscape, 'the reference really is used past the old width').toBeGreaterThan(OLD_CAP);
  expect(out.tail8192, 'the tail must not be a frozen repeat of index 8191').not.toBe(out.lastAtOld);

  // THE EFFECT: the shipped frame matches the reference built from the FULL orbit.
  expect(out.maxM, 'the measured max reference index is reported').toBeGreaterThan(100);
  expect(out.distinct, 'a structured frame, not a uniform one').toBeGreaterThan(20);
  expect(out.meanFull, 'the shipped frame matches the full transported reference').toBeLessThan(1.5);

  expect(pageErrors).toEqual([]);
});

