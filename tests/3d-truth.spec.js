// @ts-check
// S5 / B8 — 3D truth. Two independent guarantees:
//
//   1. A colour change (offset or scheme) rewrites the geometry's `color`
//      attribute and NEVER re-evaluates the fractal. Observed by a counted
//      heightmap-evaluation counter, never inferred from pixels or frame time.
//   2. The rewrite is CORRECT: the colour attribute after an offset tick equals
//      the kernel palette applied to the heights that are actually on the mesh.
//
// The harness style is tests/smoke.spec.js's: drive the real app in the real
// browser through `window.__fv`, never a second fixture set.
const { test, expect } = require('@playwright/test');

// The palette returns integers 0-255 and the attribute stores float32, so the
// only difference a correct build can show is float32 rounding. 1/255 ≈ 0.0039
// is stated here as the tolerance and is ~4 orders of magnitude above the
// measured residual.
const PALETTE_TOLERANCE = 1 / 255;

async function waitForStartup(page) {
  await expect
    .poll(async () => page.evaluate(() => window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
}

// Enter 3D mode through the REAL key path (Space) and wait until init() has
// built the first mesh. `threeDReady()` is false while init() is in flight.
async function enter3D(page) {
  await page.keyboard.press('Space');
  await expect
    .poll(async () => page.evaluate(() => window.__fv.threeDReady()), { timeout: 30_000 })
    .toBe(true);
}

test('a colour-cycle tick performs ZERO fractal evaluations', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitForStartup(page);
  await enter3D(page);

  // The app disables colour cycling at startup (app.js sets
  // `cycleColorsCheckbox.checked = false`), so turn it on through the REAL
  // checkbox — the same control the user drives — and let the real loop tick.
  const before = await page.evaluate(() => ({
    calls: window.__fv.heightmapCalls(),
    ticks: window.__fv.colorCycleTicks(),
    offset: window.__fv.colorOffset3D(),
    vertices: window.__fv.terrainVertexCount(),
  }));
  expect(before.vertices, 'a real mesh must exist').toBeGreaterThan(0);
  expect(before.calls, 'building the mesh evaluates the fractal once').toBeGreaterThan(0);
  await page.check('#cycleColors');

  // Non-vacuous: the REAL loop must tick several more times AND move the 3D
  // colour offset. Without the second poll a stopped cycle would also leave the
  // evaluation count untouched and the pin would pass on a dead build.
  await expect
    .poll(async () => page.evaluate(() => window.__fv.colorCycleTicks()), { timeout: 20_000 })
    .toBeGreaterThan(before.ticks + 3);
  await expect
    .poll(async () => page.evaluate(() => window.__fv.colorOffset3D()), { timeout: 20_000 })
    .not.toBe(before.offset);

  // Let the cycle keep running for a settle window before judging, so the claim
  // is "the count does not advance while cycling", not "it had not advanced yet".
  await page.waitForTimeout(250);

  const after = await page.evaluate(() => ({
    calls: window.__fv.heightmapCalls(),
    ticks: window.__fv.colorCycleTicks(),
  }));
  expect(after.ticks, 'the colour ticks were real').toBeGreaterThan(before.ticks);
  // B8: colour ticks changed the colours, not the fractal.
  expect(after.calls - before.calls).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('an offset tick rewrites the colour attribute to the palette values for the SAME heights', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitForStartup(page);
  await enter3D(page);

  // Freeze the colour state: stop the real cycle (its change handler resets the
  // offset to 0), then set a known scheme through the REAL setters. Without
  // this, the running cycle would overwrite the offset between the sample and
  // the assertion.
  await page.uncheck('#cycleColors');

  const OFF = 0.37;
  const check = await page.evaluate((off) => {
    window.__fv.set3DColorScheme('viridis');
    window.__fv.set3DColorOffset(0);

    const range = window.__fv.terrainHeightRange();
    const count = range.count;
    // A deterministic spread of vertices, endpoints and interior alike.
    const indices = [];
    for (let k = 0; k < 64; k++) indices.push(Math.floor((k + 0.5) * count / 64));

    const before = window.__fv.sample3DTerrain(indices);
    const callsBefore = window.__fv.heightmapCalls();
    window.__fv.set3DColorOffset(off);
    const callsAfter = window.__fv.heightmapCalls();
    const after = window.__fv.sample3DTerrain(indices);

    const scheme = window.__fv.colorScheme3D();
    const palette = globalThis.FractalKernel.paletteFunction(scheme);
    const span = range.max - range.min + 1e-6;

    let maxDiff = 0;
    let maxChange = 0;
    const worst = [];
    for (let i = 0; i < indices.length; i++) {
      const z = after[i].z;
      const h = (z - range.min) / span;
      const t = (h + off) % 1;
      const rgb = palette(t);
      const exp = { r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 };
      const diff = Math.max(
        Math.abs(after[i].r - exp.r),
        Math.abs(after[i].g - exp.g),
        Math.abs(after[i].b - exp.b)
      );
      const change = Math.max(
        Math.abs(after[i].r - before[i].r),
        Math.abs(after[i].g - before[i].g),
        Math.abs(after[i].b - before[i].b)
      );
      maxDiff = Math.max(maxDiff, diff);
      maxChange = Math.max(maxChange, change);
      if (worst.length < 3 || diff > worst[0].diff) {
        worst.push({ vertex: indices[i], h, actual: after[i], expected: exp, diff });
        worst.sort((a, b) => b.diff - a.diff);
        worst.length = Math.min(worst.length, 3);
      }
    }
    return {
      scheme,
      range,
      sampled: indices.length,
      maxDiff,
      maxChange,
      worst,
      callsBefore,
      callsAfter,
    };
  }, OFF);

  // The heights are not constant, so the palette comparison is not degenerate.
  expect(check.range.max - check.range.min).toBeGreaterThan(0);
  expect(check.scheme).toBe('viridis');
  // The offset tick actually repainted: a build that dropped the colour rewrite
  // would leave every sampled channel identical.
  expect(check.maxChange, `worst channel change ${check.maxChange}`).toBeGreaterThan(0.05);
  // The repaint is correct: every sampled channel equals the kernel palette for
  // the vertex's OWN height (read back from the position attribute), within the
  // stated float32 tolerance.
  expect(check.maxDiff, `worst mismatch ${JSON.stringify(check.worst)}`).toBeLessThanOrEqual(PALETTE_TOLERANCE);
  // And the colour rewrite evaluated the fractal zero times.
  expect(check.callsAfter - check.callsBefore).toBe(0);
  expect(pageErrors).toEqual([]);
});
