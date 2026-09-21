// @ts-check
// S1 — the zoom cap exists ONCE and clamps to the SAME value whichever path
// reaches it: the wheel, the startup animation's setView, or a render call.
//
// Before S1 the clamp was triplicated (a setView monkey-patch, a re-installed
// monkey-patch inside updateWebGLState, and a render-time mutation), so the three
// paths could disagree.
const { test, expect } = require('@playwright/test');

test('wheel, startup-animation setView and render all clamp to the same scale', async ({ page }) => {
  // The cap is 1e-20 now, so every capped wheel tick renders a real image.
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });

  // Let the startup animation settle first so it cannot race the measurements.
  await expect
    .poll(async () => page.evaluate(() => window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const result = await page.evaluate(() => {
    const fv = window.__fv;
    const limitEvents = [];
    window.addEventListener('fv-zoom-limit', (e) => limitEvents.push(e.detail));

    // Path 1 — the wheel, the way the user reaches the cap. Zoom OUT is what
    // lowers `scale`, so every wheel step goes far past the cap. The cap is now
    // 1e6 (scale 1e-6), deep enough that a full-viewport render per tick is
    // expensive on a software rasteriser, so the canvas is SHRUNK for the storm:
    // the zoom maths does not depend on the canvas size, and the dimensions are
    // restored before the paths that must render at full size.
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
    const fullW = canvas.width, fullH = canvas.height;
    canvas.width = 16; canvas.height = 16;
    // ONE real wheel tick through the viewer's own `onWheel` handler. The startup
    // animation settles at scale 3 and one tick is e^-0.3, so ~48 ticks are needed
    // to pass the 1e-6 cap; 60 over-shoots it and lands on the clamp.
    for (let i = 0; i < 60; i++) fv.wheelTick(-300);
    const afterWheel = fv.getView().scale;
    canvas.width = fullW; canvas.height = fullH;

    // Path 2 — the startup animation's path: a plain setView with an over-cap
    // scale, applied to a fresh object (never the live one).
    fv.setScale(1e-9);
    const afterAnimationPath = fv.getView().scale;

    // Path 3 — an explicit render must not change what was clamped.
    fv.setScale(1e-9);
    fv.renderWebGL();
    const afterRender = fv.getView().scale;

    return { afterWheel, afterAnimationPath, afterRender, minScale: fv.minScale, limitEvents };
  });

  expect(result.minScale).toBeGreaterThan(0);
  expect(result.afterWheel).toBe(result.minScale);
  expect(result.afterAnimationPath).toBe(result.minScale);
  expect(result.afterRender).toBe(result.minScale);
  // Every wheel tick past the cap clamps to the SAME value...
  expect(result.limitEvents.length).toBeGreaterThan(0);
  expect(result.limitEvents.map((e) => e.scale)).toEqual(
    result.limitEvents.map(() => result.minScale),
  );
  // ...and the cap is REPORTED on every capped tick. GPU-ARBITRARY removed the
  // "ask the user once" behaviour along with the CPU-switch offer: with the delta
  // RANGE fixed the cap is a performance limit on a GPU that stays on the GPU, so
  // there is nothing to ask. `prompted` stays in the payload as an observable and
  // must now be false on EVERY tick — a regression that reintroduced the ask turns
  // this RED.
  expect(result.limitEvents.filter((e) => e.prompted).length).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('below the cap, setView stores the requested scale unchanged', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const stored = await page.evaluate(() => {
    window.__fv.setScale(0.5);
    return window.__fv.getView().scale;
  });
  expect(stored).toBe(0.5);
  expect(pageErrors).toEqual([]);
});
