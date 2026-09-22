// @ts-check
// TOUCH-INPUT — a phone or tablet has no wheel, so before this slice the app could
// PAN on those devices (the browser synthesises mouse events from a drag) but could
// not ZOOM at all: `FractalViewer` bound only mousedown/mousemove/mouseup/wheel, and
// the page had no `touch-action`, so a two-finger gesture zoomed the PAGE.
//
// WHAT IS PINNED HERE, and why each pin is written the way it is:
//   1. the canvases declare `touch-action: none` AND the handler consumes the
//      gesture (`preventDefault`). The CSS property is what makes the browser hand
//      a pinch to the canvas instead of the viewport; the handler call is the half
//      that keeps working when the property is not enough. Neither alone is the
//      contract, so both are asserted.
//   2. a two-finger pinch changes the SCALE by the ratio of the finger separation,
//      and the world point under the MIDPOINT does not move. The second half is the
//      part a centre-only zoom fails: the reference is the kernel's own
//      `pixelToCoord`, the ONE projection both renderers draw with, so the pin
//      compares the gesture against the app's coordinate contract rather than
//      restating the pin's own arithmetic.
//   3. one finger DRAGS the plane the distance the finger moved — the same
//      property `tests/smoke.spec.js`'s mouse drag has, through the touch path.
//   4. the CPU (2D) canvas answers the same gestures. app.js binds the handlers to
//      BOTH canvases; a regression that binds only the WebGL one must fail.
//   5. lifting one finger of a pinch continues as a pan WITHOUT a scale jump.
//
// The input is REAL touch input: CDP `Input.dispatchTouchEvent` feeds the browser's
// own input pipeline, so the same gesture arbitration the `touch-action` property
// and `preventDefault` act on is exercised. A synthetic `new TouchEvent(...)`
// dispatched from page script would pass with the CSS half missing.
const { test, expect } = require('@playwright/test');

// `hasTouch` makes the context a touch device (navigator.maxTouchPoints > 0), so
// the events are delivered as a real touch device's would be. The viewport is small
// because every gesture re-renders the fractal and this host renders WebGL in
// software; the gesture maths does not depend on the pixel count.
test.use({ hasTouch: true, viewport: { width: 600, height: 400 } });

// One CDP touch batch. `points` are client (CSS) coordinates with a stable `id`
// per finger across the whole gesture — the id is what makes a move the SAME
// finger rather than a new one.
//
// CDP's touch model, MEASURED here rather than assumed (the protocol docs read the
// other way round): a `touchStart`/`touchEnd` batch is applied ONE CHANGED POINT AT
// A TIME, and for `touchEnd` the listed points are the ones being RELEASED — the
// unlisted ones stay active. `touchEnd: [{id: 2}]` therefore lifts finger 2 and
// leaves finger 1 down, which is what the "pinch becomes a pan" pin needs.
async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
  });
}

// Put a view on screen that the gesture can be measured against, and stop the
// startup animation from overwriting it. `setScale` goes through the SAME
// `setView` every other path uses.
async function startAt(page, scale) {
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect
    .poll(async () => page.evaluate(() => !!(window.__fv && window.__fv.animationSettled())), { timeout: 30_000 })
    .toBe(true);
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  await page.evaluate((s) => window.__fv.setScale(s), scale);
}

// The world point under a client coordinate, through the kernel's ONE projection.
// Independent of the gesture code: it is the same mapping the fragment shader and
// `calcFractalChunk` use.
async function worldAt(page, canvasId, clientX, clientY) {
  return page.evaluate(([id, x, y]) => {
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById(id));
    const r = c.getBoundingClientRect();
    // pixelToCoord is homogeneous in (x, width), so CSS pixels with the CSS box
    // are the same point as backing pixels with the backing box.
    return window.FractalKernel.pixelToCoord(x - r.left, y - r.top, r.width, r.height, window.__fv.getView());
  }, [canvasId, clientX, clientY]);
}

test('both canvases hand touch gestures to the app instead of the page', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await startAt(page, 1);

  // (a) The CSS half, on BOTH canvases: the property is what stops the browser
  // from scrolling or pinch-zooming the viewport before the app ever sees a move.
  const actions = await page.evaluate(() => {
    const read = (id) => getComputedStyle(/** @type {HTMLElement} */ (document.getElementById(id))).touchAction;
    return { webgl: read('fractalCanvasWebGL'), cpu: read('fractalCanvas') };
  });
  expect(actions.webgl, 'the WebGL canvas consumes pan/pinch itself').toBe('none');
  expect(actions.cpu, 'the CPU canvas consumes pan/pinch itself').toBe('none');

  // (b) The event half: the app's own listener, registered at startup, has already
  // called preventDefault by the time a LATER listener on the same element runs.
  await page.evaluate(() => {
    const c = /** @type {HTMLElement} */ (document.getElementById('fractalCanvasWebGL'));
    /** @type {any} */ (window).__touchDefaultPrevented = [];
    for (const type of ['touchstart', 'touchmove']) {
      c.addEventListener(type, (e) => {
        /** @type {any} */ (window).__touchDefaultPrevented.push({ type, prevented: e.defaultPrevented });
      });
    }
  });

  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', [{ x: 200, y: 300, id: 1 }, { x: 400, y: 300, id: 2 }]);
  await touch(cdp, 'touchMove', [{ x: 150, y: 300, id: 1 }, { x: 450, y: 300, id: 2 }]);
  await touch(cdp, 'touchEnd', []);

  const seen = await page.evaluate(() => /** @type {any} */ (window).__touchDefaultPrevented);
  const start = seen.find((s) => s.type === 'touchstart');
  const move = seen.find((s) => s.type === 'touchmove');
  expect(start && start.prevented, 'touchstart is consumed, not left to the page').toBe(true);
  expect(move && move.prevented, 'touchmove is consumed, not left to the page').toBe(true);
  expect(pageErrors).toEqual([]);
});

test('a two-finger pinch zooms about the midpoint under the fingers', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await startAt(page, 0.5);

  // An OFF-CENTRE midpoint, deliberately: a centre-only implementation would pass
  // a scale check at the canvas centre and fail the anchor check here.
  const midX = 420;
  const midY = 300;
  const worldBefore = await worldAt(page, 'fractalCanvasWebGL', midX, midY);

  const cdp = await page.context().newCDPSession(page);
  // Separation 160 -> 320 (factor 2), midpoint held still.
  await touch(cdp, 'touchStart', [{ x: midX - 80, y: midY, id: 1 }, { x: midX + 80, y: midY, id: 2 }]);
  await touch(cdp, 'touchMove', [{ x: midX - 110, y: midY, id: 1 }, { x: midX + 110, y: midY, id: 2 }]);
  await touch(cdp, 'touchMove', [{ x: midX - 160, y: midY, id: 1 }, { x: midX + 160, y: midY, id: 2 }]);
  await touch(cdp, 'touchEnd', []);

  const after = await page.evaluate(() => ({
    view: window.__fv.getView(),
    info: document.getElementById('info').textContent,
  }));
  expect(after.view.scale, 'a 2x finger spread doubles the zoom').toBeCloseTo(0.25, 6);

  const worldAfter = await worldAt(page, 'fractalCanvasWebGL', midX, midY);
  expect(worldAfter[0], 'the anchored point does not slide in x').toBeCloseTo(worldBefore[0], 10);
  expect(worldAfter[1], 'the anchored point does not slide in y').toBeCloseTo(worldBefore[1], 10);

  // Pinching back out restores the view — the gesture is symmetric, so a stale
  // anchor cannot quietly bias one direction.
  await touch(cdp, 'touchStart', [{ x: midX - 160, y: midY, id: 3 }, { x: midX + 160, y: midY, id: 4 }]);
  await touch(cdp, 'touchMove', [{ x: midX - 80, y: midY, id: 3 }, { x: midX + 80, y: midY, id: 4 }]);
  await touch(cdp, 'touchEnd', []);
  const back = await page.evaluate(() => window.__fv.getView());
  expect(back.scale, 'pinching back out returns to the starting scale').toBeCloseTo(0.5, 6);
  expect(after.info, 'the readout follows the touch view, like it follows the wheel').toContain('Zoom');
  expect(pageErrors).toEqual([]);
});

test('one finger drags the plane the distance the finger moved', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await startAt(page, 1);

  const fromX = 200;
  const fromY = 300;
  const toX = 260;
  const toY = 250;
  const worldAtStart = await worldAt(page, 'fractalCanvasWebGL', fromX, fromY);
  const scaleBefore = (await page.evaluate(() => window.__fv.getView())).scale;

  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', [{ x: fromX, y: fromY, id: 1 }]);
  await touch(cdp, 'touchMove', [{ x: (fromX + toX) / 2, y: (fromY + toY) / 2, id: 1 }]);
  await touch(cdp, 'touchMove', [{ x: toX, y: toY, id: 1 }]);
  await touch(cdp, 'touchEnd', []);

  const view = await page.evaluate(() => window.__fv.getView());
  expect(view.scale, 'a one-finger drag does not change the zoom').toBe(scaleBefore);
  // The point that was under the finger is now under where the finger ENDED —
  // the pan contract, read through the kernel's projection.
  const worldAtEnd = await worldAt(page, 'fractalCanvasWebGL', toX, toY);
  expect(worldAtEnd[0]).toBeCloseTo(worldAtStart[0], 10);
  expect(worldAtEnd[1]).toBeCloseTo(worldAtStart[1], 10);
  expect(pageErrors).toEqual([]);
});

test('lifting one finger of a pinch continues as a pan with no scale jump', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await startAt(page, 0.5);

  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', [{ x: 200, y: 300, id: 1 }, { x: 400, y: 300, id: 2 }]);
  await touch(cdp, 'touchMove', [{ x: 170, y: 300, id: 1 }, { x: 430, y: 300, id: 2 }]);
  const midPinch = await page.evaluate(() => window.__fv.getView());

  // Finger 2 lifts: the remaining finger must continue as a PAN from where it is,
  // so the scale is untouched by the transition. (The CDP batch lists the finger
  // being RELEASED; finger 1 at (170,300) stays down.)
  await touch(cdp, 'touchEnd', [{ x: 430, y: 300, id: 2 }]);
  const afterLift = await page.evaluate(() => window.__fv.getView());
  expect(afterLift.scale, 'the transition itself does not zoom').toBe(midPinch.scale);

  const before = await worldAt(page, 'fractalCanvasWebGL', 170, 300);
  await touch(cdp, 'touchMove', [{ x: 130, y: 340, id: 1 }]);
  await touch(cdp, 'touchEnd', []);
  const after = await page.evaluate(() => window.__fv.getView());
  expect(after.scale, 'the continued pan does not zoom either').toBe(afterLift.scale);
  const worldAfter = await worldAt(page, 'fractalCanvasWebGL', 130, 340);
  expect(worldAfter[0], 'the remaining finger still drags the plane').toBeCloseTo(before[0], 10);
  expect(worldAfter[1]).toBeCloseTo(before[1], 10);
  expect(pageErrors).toEqual([]);
});

test('the CPU (2D) canvas answers the same pinch', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await startAt(page, 0.5);

  // Switch to the CPU lane the way the user does, and wait for the 2D canvas to be
  // the visible one (updateWebGLState swaps them).
  await page.locator('#webglRender').uncheck();
  await expect(page.locator('#fractalCanvas')).toBeVisible();

  const cdp = await page.context().newCDPSession(page);
  // Separation 80 -> 160 (2x apart = 2x zoom in), midpoint held still.
  await touch(cdp, 'touchStart', [{ x: 260, y: 300, id: 1 }, { x: 340, y: 300, id: 2 }]);
  await touch(cdp, 'touchMove', [{ x: 220, y: 300, id: 1 }, { x: 380, y: 300, id: 2 }]);
  await touch(cdp, 'touchEnd', []);

  const view = await page.evaluate(() => window.__fv.getView());
  expect(view.scale, 'the 2D canvas pinches too, not only the WebGL one').toBeCloseTo(0.25, 6);
  expect(pageErrors).toEqual([]);
});
