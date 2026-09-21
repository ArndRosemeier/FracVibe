// @ts-check
// S1 / B4 — the canvas backing store is CSS size x devicePixelRatio, at startup
// and after a viewport resize, for both 2D canvases.
//
// Before S1 neither canvas consulted devicePixelRatio and #fractalCanvasWebGL was
// sized once, in CSS pixels, and never resized at all.
const { test, expect } = require('@playwright/test');

test.use({ deviceScaleFactor: 2 });

test('both canvases size their backing store to CSS size x 2 at dpr 2', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const measured = await page.evaluate(() => {
    const ids = ['fractalCanvas', 'fractalCanvasWebGL'];
    // The canvases are 100vw x 100vh; the CSS size is read from the viewport
    // because the inactive canvas is display:none and has a zero-sized box.
    const cssWidth = window.innerWidth;
    const cssHeight = window.innerHeight;
    return ids.map((id) => {
      const c = /** @type {HTMLCanvasElement} */ (document.getElementById(id));
      return {
        id,
        dpr: window.devicePixelRatio,
        cssWidth,
        cssHeight,
        bufferWidth: c.width,
        bufferHeight: c.height,
      };
    });
  });

  for (const c of measured) {
    expect(c.dpr, `${c.id}: the run must actually be at dpr 2`).toBe(2);
    expect(c.cssWidth, `${c.id}: CSS width`).toBeGreaterThan(100);
    expect(c.bufferWidth, `${c.id}: buffer width = cssWidth * 2`).toBe(Math.round(c.cssWidth * 2));
    expect(c.bufferHeight, `${c.id}: buffer height = cssHeight * 2`).toBe(Math.round(c.cssHeight * 2));
  }
});

test('a viewport resize moves the WebGL backing store with it', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  await page.setViewportSize({ width: 800, height: 600 });

  await expect
    .poll(async () => page.evaluate(() => {
      const c = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
      return { w: c.width, h: c.height };
    }), { timeout: 20_000 })
    .toEqual({ w: 1600, h: 1200 });

  // The resize path must also repaint and recompute, at the new resolution.
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  expect(pageErrors).toEqual([]);
});
