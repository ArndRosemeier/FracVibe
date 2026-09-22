// @ts-check
// S1 — a zoom clamp, IF one is declared, exists ONCE and clamps to the SAME value
// whichever path reaches it: the wheel, setView, or a render call.
//
// Before S1 the clamp was triplicated (a setView monkey-patch, a re-installed
// monkey-patch inside updateWebGLState, and a render-time mutation), so the three
// paths could disagree.
//
// LANE-CONTINUITY changed the shipped setting, NOT the machinery: the owner's
// directive ("no hard stop", docs/DECISIONS.md row 62) removed the app's zoom cap,
// so the shipped state is UNLIMITED and the clamp is exercised here through the
// diagnostic hook (`__fv.setZoomLimitForTest`). Two properties are pinned:
//   1. the MACHINERY still applies one value on every path — the S1 property;
//   2. the SHIPPED state is unlimited, so a deep scale is stored verbatim, and the
//      only depth signal left is the non-blocking measured-correct-reach notice.
const { test, expect } = require('@playwright/test');

// ITER-CAP: these pins drive deep views (1e-9, 1e-12, 1e-45) whose zoom-derived
// budget is now up to 46080, and they assert STATE, not pixels. A small viewport
// keeps the renders bounded; the clamp machinery and the stored scale do not depend
// on the canvas size (test 1 already shrinks the canvas for its wheel storm).
test.use({ viewport: { width: 160, height: 120 } });

test('the ONE clamp applies the same value on every path (S1), and the shipped state has no limit', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });

  // Let the startup animation settle first so it cannot race the measurements.
  await expect
    .poll(async () => page.evaluate(() => window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  // The shipped state: NO cap. `minScale`/`zoomCap` are null and a scale far past
  // the old caps is stored unchanged by every path.
  const shipped = await page.evaluate(() => {
    const fv = window.__fv;
    const before = { minScale: fv.minScale, zoomCap: fv.zoomCap };
    fv.setScale(1e-9);
    const viaSetView = fv.getView().scale;
    fv.setScale(1e-9);
    fv.renderWebGL();
    const viaRender = fv.getView().scale;
    return { before, viaSetView, viaRender, deepPrecisionMinScale: fv.deepPrecisionMinScale };
  });
  expect(shipped.before.minScale, 'the shipped zoom state is unlimited').toBe(null);
  expect(shipped.before.zoomCap, 'there is no zoom cap').toBe(null);
  expect(shipped.viaSetView, 'a deep scale is stored verbatim (no hard stop)').toBe(1e-9);
  expect(shipped.viaRender).toBe(1e-9);
  expect(shipped.deepPrecisionMinScale, 'the measured-correct reach is a separate number').toBe(1e-40);

  // The MACHINERY (S1's subject) still exists and still agrees on all three paths
  // when a limit IS declared. This is diagnostic-only: production ships null.
  const result = await page.evaluate(() => {
    const fv = window.__fv;
    fv.setZoomLimitForTest(1e-6);
    // Path 1 — the wheel, the way the user reaches a limit. The canvas is SHRUNK
    // for the storm: the zoom maths does not depend on the canvas size, and the
    // dimensions are restored before the paths that must render at full size.
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
    const fullW = canvas.width, fullH = canvas.height;
    canvas.width = 16; canvas.height = 16;
    // ONE real wheel tick through the viewer's own `onWheel` handler. The startup
    // animation settles at scale 3 and one tick is e^-0.3, so ~48 ticks are needed
    // to pass the 1e-6 limit; 60 over-shoots it and lands on the clamp.
    for (let i = 0; i < 60; i++) fv.wheelTick(-300);
    const afterWheel = fv.getView().scale;
    canvas.width = fullW; canvas.height = fullH;

    // Path 2 — a plain setView with an over-limit scale, applied to a fresh object
    // (never the live one).
    fv.setScale(1e-9);
    const afterSetView = fv.getView().scale;

    // Path 3 — an explicit render must not change what was clamped.
    fv.setScale(1e-9);
    fv.renderWebGL();
    const afterRender = fv.getView().scale;

    // Restore the SHIPPED unlimited state.
    fv.setZoomLimitForTest(null);
    fv.setScale(1e-9);
    const restored = fv.getView().scale;
    fv.setScale(3);
    return { afterWheel, afterSetView, afterRender, restored };
  });

  expect(result.afterWheel).toBe(1e-6);
  expect(result.afterSetView).toBe(1e-6);
  expect(result.afterRender).toBe(1e-6);
  expect(result.restored, 'null removes the limit and the deep scale passes through').toBe(1e-9);
  expect(pageErrors).toEqual([]);
});

// LANE-CONTINUITY: the cap notice is replaced by the measured-correct-reach notice,
// which is INFORMATION — it never changes the view, the renderer or the lane.
test('past the measured-correct reach the app notifies without limiting or switching renderer', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const out = await page.evaluate(() => {
    const events = [];
    window.addEventListener('fv-deep-precision', (e) => events.push(e.detail));
    window.__fv.setScale(1e-45);
    return {
      scale: window.__fv.getView().scale,
      events,
      message: document.getElementById('appMessage').textContent,
      shown: document.getElementById('appMessage').style.display,
      webgl: /** @type {HTMLInputElement} */ (document.getElementById('webglRender')).checked,
      offered: window.__fv.zoomCapOffered(),
      prompted: window.__fv.zoomCapPrompted(),
    };
  });
  // The view is NOT clamped: the notice is information, not a stop.
  expect(out.scale, 'a scale past the measured reach is stored unchanged').toBe(1e-45);
  expect(out.events.length, 'crossing the reach is reported').toBeGreaterThan(0);
  expect(out.events[out.events.length - 1].scale).toBe(1e-45);
  expect(out.message, 'the notice names the measured-correct precision').toContain('measured-correct precision');
  expect(out.shown, 'the notice is a visible, non-modal status surface').not.toBe('none');
  // The renderer never switches itself and no CPU offer exists.
  expect(out.webgl, 'the renderer never switches itself').toBe(true);
  expect(out.offered).toBe(false);
  expect(out.prompted).toBe(false);
  await expect(page.locator('#zoomCapOffer')).toHaveCount(0);
  await expect(page.locator('#zoomCapSwitchToCpu')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('no cap: setView stores the requested scale unchanged', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const stored = await page.evaluate(() => {
    window.__fv.setScale(0.5);
    const shallow = window.__fv.getView().scale;
    window.__fv.setScale(1e-12);
    const deep = window.__fv.getView().scale;
    return { shallow, deep };
  });
  expect(stored.shallow).toBe(0.5);
  expect(stored.deep).toBe(1e-12);
  expect(pageErrors).toEqual([]);
});
