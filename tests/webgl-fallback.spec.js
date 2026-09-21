// @ts-check
// S1 / B9 — WebGL failure must fall back to a REAL CPU render and say so.
//
// Before S1 the failure path alerted, unchecked the box, hid the WebGL canvas and
// called viewer.render() without ever starting a calculation, leaving a blank
// #222 canvas and an uncaught alert. These tests use the same harness style as
// tests/smoke.spec.js: drive the real app in the real browser, never a second
// fixture set.
const { test, expect } = require('@playwright/test');

// Pixels belonging to the fractal set render black (see smoke.spec.js).
async function countSetPixels(page) {
  return page.evaluate(() => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context on #fractalCanvas');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let black = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] < 30) black++;
    }
    return black;
  });
}

// Make every WebGL context request fail, exactly as a GPU-less browser or a
// driver-blocklisted machine would. '2d' is untouched, so the CPU renderer can
// still do its job.
async function denyWebGLContexts(page) {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') return null;
      return original.call(this, type, ...rest);
    };
  });
}

test('forced WebGL context-creation failure still renders on the CPU canvas and says so', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await denyWebGLContexts(page);
  await page.goto('./', { waitUntil: 'domcontentloaded' });

  // A visible, non-modal message (not an alert) reports the fallback.
  const message = page.locator('#appMessage');
  await expect(message).toBeVisible();
  await expect(message).toContainText(/WebGL/i);
  await expect(message).toContainText(/CPU/i);

  // The 2D canvas is the visible one again and the WebGL canvas is gone.
  await expect(page.locator('#fractalCanvas')).toBeVisible();
  await expect(page.locator('#fractalCanvasWebGL')).toBeHidden();

  // The app did not just paint the background: a real calculation ran.
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  // The startup animation ends at zoom 3; wait for it to settle before judging
  // pixels, exactly as the B3 pin does.
  await expect
    .poll(async () => page.evaluate(() => window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect.poll(() => countSetPixels(page), { timeout: 30_000 }).toBeGreaterThan(20_000);

  expect(pageErrors).toEqual([]);
});

test('a WebGL failure AFTER startup starts a NEW CPU calculation', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  // Count the jobs the app hands to the worker. This is the observable that the
  // old failure path lacked entirely: it called viewer.render() (which paints the
  // background when no image data exists) and never started a calculation.
  await page.addInitScript(() => {
    window.__fvWorkerMessages = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) {
      window.__fvWorkerMessages++;
      return post.apply(this, args);
    };
  });
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect
    .poll(async () => page.evaluate(() => window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const before = await page.evaluate(() => window.__fvWorkerMessages);
  await page.evaluate(() => window.__fv.forceFallback());
  await expect(page.locator('#appMessage')).toContainText(/CPU/i);
  await expect(page.locator('#fractalCanvas')).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => window.__fvWorkerMessages), { timeout: 10_000 })
    .toBeGreaterThan(before);

  expect(pageErrors).toEqual([]);
});

// The REAL event path: the browser fires `webglcontextlost` at the canvas, the
// listener installed by attachContextLossGuard must call preventDefault() and
// degrade. A dispatchEvent on a cancelable event returns false exactly when the
// handler cancelled it, so the guard's preventDefault() is pinned too — not
// assumed. (The hook-based test below covers the handler, NOT this wiring.)
test('the real webglcontextlost event degrades to the CPU canvas with a message', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const dispatch = await page.evaluate(() => {
    const e = new Event('webglcontextlost', { cancelable: true });
    const target = document.getElementById('fractalCanvasWebGL');
    return { returnValue: target.dispatchEvent(e), prevented: e.defaultPrevented };
  });
  // false = the guard cancelled the default (i.e. the REAL listener is wired up).
  expect(dispatch.returnValue, 'attachContextLossGuard must preventDefault()').toBe(false);
  expect(dispatch.prevented).toBe(true);

  const message = page.locator('#appMessage');
  await expect(message).toBeVisible();
  await expect(message).toContainText(/context lost/i);
  await expect(message).toContainText(/CPU/i);
  await expect(page.locator('#fractalCanvas')).toBeVisible();
  await expect(page.locator('#fractalCanvasWebGL')).toBeHidden();
  await expect(page.locator('#webglRender')).not.toBeChecked();
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  expect(pageErrors).toEqual([]);
});

// Coverage of the degradation HANDLER (called directly). This does not exercise
// the DOM listener wiring — the test above is the one that pins that.
test('handleWebGLLoss (via the observation hook) degrades to the CPU canvas with a message', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  await page.evaluate(() => window.__fv.simulateContextLoss());

  const message = page.locator('#appMessage');
  await expect(message).toBeVisible();
  await expect(message).toContainText(/context lost/i);
  await expect(message).toContainText(/CPU/i);
  await expect(page.locator('#fractalCanvas')).toBeVisible();
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  expect(pageErrors).toEqual([]);
});

// Renderer construction is deferred by one macrotask in app.js so the canvas is
// visible first; the count is therefore observed by polling the exposed counter,
// never by reading it synchronously.
async function expectLiveRenderers(page, n) {
  await expect.poll(() => page.evaluate(() => window.__fv.liveRenderers()), { timeout: 10_000 }).toBe(n);
}

test('GPU<->CPU toggles leave exactly ONE live WebGL renderer, not N', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  // Observable accounting, never inference: WebGLFractalRenderer increments on
  // construction and decrements in destroy().
  await expectLiveRenderers(page, 1);

  for (let i = 0; i < 5; i++) {
    await page.uncheck('#webglRender');
    // Toggling to CPU must actually release the context, not just drop the ref.
    await expectLiveRenderers(page, 0);
    await page.check('#webglRender');
    await expectLiveRenderers(page, 1);
    await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
    // A leaked context must not be reported as a failure, and the toggle must
    // stay where the user put it.
    await expect(page.locator('#appMessage')).toBeHidden();
    await expect(page.locator('#webglRender')).toBeChecked();
  }

  // Release the last one: the count must return to zero, i.e. neither the
  // renderer nor the (browser-capped) GL context is leaked.
  await page.uncheck('#webglRender');
  await expectLiveRenderers(page, 0);

  expect(pageErrors).toEqual([]);
});

test('renderWebGL with a torn-down renderer does not throw', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  // Force the degraded path, then call the raw renderer entry point again: the
  // old code early-returned (blank canvas) and threw on a null renderer.
  await page.evaluate(() => window.__fv.forceFallback());
  await page.evaluate(() => window.__fv.renderWebGL());

  await expect(page.locator('#appMessage')).toBeVisible();
  await expect(page.locator('#appMessage')).toContainText(/CPU/i);
  expect(pageErrors).toEqual([]);
});

test('the last-resort error net surfaces an uncaught error instead of freezing', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  // Both shapes of escape: an uncaught exception and a rejected promise.
  await page.evaluate(() => {
    setTimeout(() => { throw new Error('S1 error-net sentinel'); }, 0);
  });
  await expect(page.locator('#appMessage')).toBeVisible();
  await expect(page.locator('#appMessage')).toContainText(/S1 error-net sentinel/);

  await page.evaluate(() => {
    Promise.reject(new Error('S1 rejection sentinel'));
  });
  await expect(page.locator('#appMessage')).toContainText(/S1 rejection sentinel/);

  // The renderer must still be alive and painting after the net caught these.
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  expect(pageErrors.length).toBeGreaterThan(0); // the page errors were REAL
});
