// @ts-check
const { test, expect } = require('@playwright/test');

// Pixels belonging to the fractal set are rendered black; everything outside it
// gets a palette colour. This distinguishes "the set is on screen" from "a stale,
// far-too-zoomed image", which is the CPU-mode symptom B3 produced.
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

test('renders without uncaught errors (B1: dead element IDs crashed the app)', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('/');

  // #renderTime is only written after a successful render, and every render call
  // sits below the old crash site (app.js threw at line 181, on a null element).
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  await expect(page.locator('#fractalCanvasWebGL')).toBeVisible();
  const buffer = await page.locator('#fractalCanvasWebGL').evaluate((c) => [c.width, c.height]);
  expect(buffer[0]).toBeGreaterThan(100);
  expect(buffer[1]).toBeGreaterThan(100);

  expect(pageErrors).toEqual([]);
});

test('saved-locations modal opens and closes (B1: the modal IDs are wired up)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  await page.click('#loadLocationBtn');
  await expect(page.locator('#loadLocationModal')).toBeVisible();
  await expect(page.locator('#savedLocationsList')).toContainText('No locations saved yet');
  await page.click('#closeLoadLocationModal');
  await expect(page.locator('#loadLocationModal')).toBeHidden();
});

test('Space puts the 3D canvas on screen (B2: it rendered below the fold)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const threeCanvas = page.locator('body > canvas:not([id])'); // appended by three.js
  await page.keyboard.press('Space');
  await expect(page.locator('#info')).toBeHidden();
  await expect(threeCanvas).toBeVisible();

  const rect = await threeCanvas.evaluate((c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(rect.x).toBe(0);
  expect(rect.y).toBe(0);
  expect(rect.width).toBeGreaterThan(100);
  expect(rect.height).toBeGreaterThan(100);

  await page.keyboard.press('Space');
  await expect(page.locator('#info')).toBeVisible();
});

test('CPU mode recalculates once the startup zoom animation settles (B3)', async ({ page }) => {
  // There is no CPU-by-default switch in the app, so switch to CPU as early as
  // possible. The checkbox handler starts a calculation at the *current* animation
  // scale, and the animation itself never recalculates, so a correct final image
  // can only come from the recalculation when the animation settles.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.uncheck('#webglRender');

  const zoom = await page.locator('#info').textContent();
  const zoomValue = Number(/Zoom: ([\d.]+)/.exec(zoom ?? '')?.[1] ?? 'NaN');
  expect(
    zoomValue,
    `the startup animation had already settled before CPU mode was selected (info: ${zoom})`,
  ).toBeLessThan(0.25);

  // A full view of the set has tens of thousands of black pixels; the stale,
  // over-zoomed image this bug produced has a handful.
  await expect.poll(() => countSetPixels(page), { timeout: 30_000 }).toBeGreaterThan(20_000);
});
