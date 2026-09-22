// @ts-check
// S3 / kernel truth (B5 + P1) — one parameterised kernel, one type/palette table,
// one iteration cap, shared by the render worker, the main thread (2D and the 3D
// heightmap) and the fragment shader.
//
// The three pins:
//   1. at maxIter = the cap, the GPU and the CPU render the same set. Before S3
//      the slider allowed 2000 while the shader looped to a hardcoded 1024, so
//      every pixel needing more than 1024 iterations was coloured as escaped;
//      this pin is a large, structured pixel difference when that returns.
//   2. the slider's `max`, the kernel's cap and the shader's templated loop bound
//      are ONE number, so the UI cannot offer what the renderers do not honour.
//   3. for every supported fractal type and palette, the CPU and the GPU agree
//      on a sampled grid, so the type/palette index maps cannot drift apart.
//
// Harness style is the existing one (tests/smoke.spec.js, tests/zoom-clamp.spec.js,
// tests/worker-lifecycle.spec.js): the real app in the real browser, observed
// through the frozen `window.__fv` surface, with the startup animation allowed to
// settle before any pixel is judged. No second fixture set is built.
//
// The comparison is close, not pixel-identical: the CPU kernel samples pixel
// CORNERS while a fragment shader samples fragment CENTERS, so a thin band along
// the set boundary can flip. The thresholds below are stated, and the landing
// report records what a deliberately broken shader bound measured (docs/DECISIONS.md
// row 15).
const { test, expect } = require('@playwright/test');

// A small viewport keeps the at-the-cap CPU render fast; the pins are about the
// iteration cap and the index maps, not about resolution.
test.use({ viewport: { width: 420, height: 315 } });

// 32 x 32 = 1024 sampled pixels per image: dense enough that the inside/outside
// disagreement estimate is stable, sparse enough to stay "a sample" and cheap.
const SAMPLE_N = 32;
const EXPECTED_TYPES = ['mandelbrot', 'julia', 'burningship', 'tricorn'];
const EXPECTED_SCHEMES = ['rainbow', 'fire', 'ocean', 'grayscale', 'viridis'];

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
}

async function waitIdle(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv.jobToken()), { timeout: 60_000 })
    .toBe(null);
}

async function kernelTables(page) {
  return page.evaluate(() => ({
    types: window.__fv.fractalTypes(),
    schemes: window.__fv.colorSchemes(),
  }));
}

// --- pin 2 ---------------------------------------------------------------------

test('S3 pin 2: slider max, kernel cap and shader loop bound are ONE constant', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  // The renderer is built one macrotask after startup; poll rather than read it
  // synchronously (the same convention tests/webgl-fallback.spec.js uses).
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderMaxIter()), { timeout: 10_000 })
    .not.toBe(null);

  const measured = await page.evaluate(() => {
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    return {
      sliderMaxAttr: slider.getAttribute('max'),
      sliderMaxProp: slider.max,
      cap: window.__fv.maxIterCap,
      shaderMaxIter: window.__fv.shaderMaxIter(),
      loopBounds: window.__fv.shaderLoopBounds(),
    };
  });
  console.log(
    `[S3 pin2] cap=${measured.cap} sliderAttr=${measured.sliderMaxAttr} ` +
    `shader=${measured.shaderMaxIter} loops=${JSON.stringify(measured.loopBounds)}`,
  );

  expect(measured.cap).toBeGreaterThan(0);
  // The UI cannot offer more than the renderers honour: the slider's bound IS the
  // kernel constant (it is not restated in index.html).
  expect(Number(measured.sliderMaxAttr), 'slider max attribute').toBe(measured.cap);
  expect(Number(measured.sliderMaxProp), 'slider max property').toBe(measured.cap);
  // GLSL ES 1.00 needs a constant loop bound, so the cap is templated in; this is
  // the value actually placed in `#define MAX_ITER`.
  expect(measured.shaderMaxIter, 'the value templated into #define MAX_ITER').toBe(measured.cap);
  // Four loop sites (Julia, Burning Ship, Tricorn, Mandelbrot) and every one of
  // them bound to the define — never to a literal that can drift from the cap.
  expect(measured.loopBounds).toHaveLength(4);
  expect(measured.loopBounds).toEqual(['MAX_ITER', 'MAX_ITER', 'MAX_ITER', 'MAX_ITER']);

  // ...and the slider genuinely reaches the cap and stores exactly it.
  const reached = await page.evaluate(() => {
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    slider.value = slider.max;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return { slider: Number(slider.value), stored: window.__fv.maxIter() };
  });
  expect(reached.slider).toBe(measured.cap);
  expect(reached.stored).toBe(measured.cap);
  expect(pageErrors).toEqual([]);
});

// --- pin 1 ---------------------------------------------------------------------
//
// ITER-CAP: this pin renders a CPU AND a GPU frame at `maxIter = the cap`, and the
// cap is now 100000 (was 8192) — ~12x the work per pixel, on a view that is
// deliberately interior-heavy so most pixels run the FULL budget. A small viewport
// keeps the same comparison (every pixel, CPU vs GPU, at the cap) affordable; the
// pin's contract is the bound at the cap, not the resolution.

test.describe('S3 pin 1 at the raised cap', () => {
  test.use({ viewport: { width: 96, height: 72 } });

  test('S3 pin 1 (B5): at maxIter = the cap, GPU and CPU render the same set', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);

  // A view that is largely INSIDE the set, so the B5 failure (the shader stopping
  // at its bound and colouring interior pixels as escaped) is a large fraction of
  // the image rather than a thin boundary band.
  await page.evaluate(() => window.__fv.setScale(0.5));

  // CPU first, at the slider's maximum (= the cap).
  await page.uncheck('#webglRender');
  await waitIdle(page);
  const cap = await page.evaluate(() => window.__fv.maxIterCap);
  const started = await page.evaluate((capValue) => {
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    // Capture the job counter BEFORE the change starts a job, or the poll below
    // asks for a job that will never start.
    const before = window.__fv.jobCount();
    slider.value = String(capValue);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after: window.__fv.jobCount(), sliderValue: Number(slider.value) };
  }, cap);
  expect(started.sliderValue, 'the slider must reach the cap').toBe(cap);
  expect(started.after, 'changing the slider must start a job').toBeGreaterThan(started.before);
  await expect
    .poll(
      () => page.evaluate((before) => window.__fv.jobCount() > before && window.__fv.jobToken() === null, started.before),
      { timeout: 60_000 },
    )
    .toBe(true);
  expect(await page.evaluate(() => window.__fv.maxIter()), 'the CPU job ran at the cap').toBe(cap);

  // Freeze the CPU image before the GPU replaces the visible canvas.
  await page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height);
    window.__cpuCapture = { w: c.width, h: c.height, data: new Uint8Array(img.data) };
  });

  // The GPU, same view and same cap. COARSE-TO-FINE: `renderWebGL` applies the
  // coarsest refinement level synchronously and refines from there, so the readback
  // awaits `whenRenderSettled()` — which resolves in the same task as the
  // FULL-RESOLUTION draw — and the drawing buffer is still intact (no
  // preserveDrawingBuffer needed).
  await page.check('#webglRender');
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  await expect.poll(() => page.evaluate(() => window.__fv.liveRenderers()), { timeout: 10_000 }).toBe(1);

  const metrics = await page.evaluate(async () => {
    window.__fv.renderWebGL();
    await window.__fv.whenRenderSettled();
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
    const gl = canvas.getContext('webgl');
    if (!gl) return { error: 'no webgl context' };
    const w = canvas.width, h = canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const cpu = window.__cpuCapture;
    if (!cpu || cpu.w !== w || cpu.h !== h) return { error: `size mismatch ${cpu && cpu.w}x${cpu && cpu.h} vs ${w}x${h}` };
    let sumAbs = 0, big = 0, cpuSum = 0, gpuSum = 0, cpuBlack = 0;
    const n = w * h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ci = (y * w + x) * 4;
        const gi = ((h - 1 - y) * w + x) * 4; // readPixels origin is bottom-left
        const dr = Math.abs(cpu.data[ci] - px[gi]);
        const dg = Math.abs(cpu.data[ci + 1] - px[gi + 1]);
        const db = Math.abs(cpu.data[ci + 2] - px[gi + 2]);
        sumAbs += dr + dg + db;
        if (Math.max(dr, dg, db) > 48) big++;
        cpuSum += cpu.data[ci] + cpu.data[ci + 1] + cpu.data[ci + 2];
        gpuSum += px[gi] + px[gi + 1] + px[gi + 2];
        if (cpu.data[ci] + cpu.data[ci + 1] + cpu.data[ci + 2] < 30) cpuBlack++;
      }
    }
    return {
      w, h, cap: window.__fv.maxIter(),
      meanAbs: sumAbs / (n * 3),
      bigFrac: big / n,
      cpuBlackFrac: cpuBlack / n,
      cpuSum, gpuSum,
    };
  });
  expect(metrics.error).toBeUndefined();
  console.log(
    `[S3 pin1] ${metrics.w}x${metrics.h} maxIter=${metrics.cap} meanAbs=${metrics.meanAbs.toFixed(3)} ` +
    `bigFrac=${metrics.bigFrac.toFixed(4)} cpuBlackFrac=${metrics.cpuBlackFrac.toFixed(3)}`,
  );

  // The comparison must be between two real renders, in a view that actually
  // contains set interior (otherwise the B5 signal would be absent).
  expect(metrics.cpuSum).toBeGreaterThan(0);
  expect(metrics.gpuSum).toBeGreaterThan(0);
  expect(metrics.cpuBlackFrac, 'the view must contain real set interior').toBeGreaterThan(0.05);

  // STATED THRESHOLDS. Measured on this host; the landing report records the
  // deliberately-broken shader bound that must (and did) exceed them.
  expect(metrics.meanAbs, 'mean per-channel |CPU - GPU| (0-255)').toBeLessThan(6);
  expect(metrics.bigFrac, 'fraction of pixels off by more than 48').toBeLessThan(0.06);
  expect(pageErrors).toEqual([]);
  });
});

// --- pin 3 ---------------------------------------------------------------------

// The CPU image, sampled at SAMPLE_N x SAMPLE_N points, for each palette.
async function captureCpuSamples(page, schemes) {
  return page.evaluate(({ schemeNames, n }) => {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('colorScheme'));
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvas'));
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const out = {};
    for (const scheme of schemeNames) {
      select.value = scheme;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const data = ctx.getImageData(0, 0, w, h).data;
      const pts = [];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = Math.floor((i + 0.5) * w / n);
          const y = Math.floor((j + 0.5) * h / n);
          const k = (y * w + x) * 4;
          pts.push(data[k], data[k + 1], data[k + 2]);
        }
      }
      out[scheme] = pts;
    }
    return out;
  }, { schemeNames: schemes, n: SAMPLE_N });
}

// The GPU image, sampled at the SAME points (readPixels' origin is bottom-left,
// so the row is flipped to match the 2D canvas).
async function captureGpuSamples(page, schemes) {
  return page.evaluate(async ({ schemeNames, n }) => {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('colorScheme'));
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('fractalCanvasWebGL'));
    const gl = canvas.getContext('webgl');
    if (!gl) return { __error: 'no webgl context' };
    const w = canvas.width, h = canvas.height;
    const out = {};
    for (const scheme of schemeNames) {
      select.value = scheme;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      window.__fv.renderWebGL();
      // The FULL-RESOLUTION level of the refinement chain (see the note on pin 1).
      await window.__fv.whenRenderSettled();
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const pts = [];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = Math.floor((i + 0.5) * w / n);
          const yTop = Math.floor((j + 0.5) * h / n);
          const k = ((h - 1 - yTop) * w + x) * 4;
          pts.push(px[k], px[k + 1], px[k + 2]);
        }
      }
      out[scheme] = pts;
    }
    return out;
  }, { schemeNames: schemes, n: SAMPLE_N });
}

for (const type of EXPECTED_TYPES) {
  test(`S3 pin 3: CPU and GPU agree on type + palette indices for ${type}`, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto('./', { waitUntil: 'domcontentloaded' });
    await waitSettled(page);

    const tables = await kernelTables(page);
    // The pin must cover EVERY type and palette the kernel supports, not a
    // convenient subset: if the tables grow, this fails until the pin grows too.
    expect(tables.types, 'the pin must cover every supported type').toEqual(EXPECTED_TYPES);
    expect(tables.schemes, 'the pin must cover every supported palette').toEqual(EXPECTED_SCHEMES);
    const schemes = tables.schemes;

    // CPU first, at a modest iteration count (this pin is about the index maps,
    // not the cap), with the type chosen through the real UI.
    await page.uncheck('#webglRender');
    await waitIdle(page);
    const before = await page.evaluate((typeName) => {
      const typeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('fractalType'));
      // Capture the job counter BEFORE the type change starts a job; otherwise the
      // poll below requires a job that has already been counted.
      const seen = window.__fv.jobCount();
      typeSelect.value = typeName;
      typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
      slider.value = '256';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return { seen, after: window.__fv.jobCount() };
    }, type);
    expect(before.after, 'changing the type/slider must start a job').toBeGreaterThan(before.seen);
    await expect
      .poll(
        () => page.evaluate((b) => window.__fv.jobCount() > b && window.__fv.jobToken() === null, before.seen),
        { timeout: 60_000 },
      )
      .toBe(true);

    const cpu = await captureCpuSamples(page, schemes);
    for (const scheme of schemes) {
      expect(cpu[scheme], `${type}/${scheme}: CPU samples`).toHaveLength(SAMPLE_N * SAMPLE_N * 3);
      expect(cpu[scheme].reduce((a, b) => a + b, 0), `${type}/${scheme}: CPU image is not blank`).toBeGreaterThan(0);
    }

    // Then the GPU, same view / type / maxIter — only the palette changes.
    await page.check('#webglRender');
    await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
    await expect.poll(() => page.evaluate(() => window.__fv.liveRenderers()), { timeout: 10_000 }).toBe(1);
    const gpu = await captureGpuSamples(page, schemes);
    expect(gpu.__error).toBeUndefined();

    const perScheme = [];
    for (const scheme of schemes) {
      const c = cpu[scheme];
      const g = gpu[scheme];
      expect(g, `${type}/${scheme}: GPU samples`).toHaveLength(c.length);
      expect(g.reduce((a, b) => a + b, 0), `${type}/${scheme}: GPU image is not blank`).toBeGreaterThan(0);
      let sumAbs = 0, xor = 0;
      const count = c.length / 3;
      for (let i = 0; i < c.length; i += 3) {
        sumAbs += Math.abs(c[i] - g[i]) + Math.abs(c[i + 1] - g[i + 1]) + Math.abs(c[i + 2] - g[i + 2]);
        // "Inside the set" is black in BOTH renderers (the palette cannot change
        // it), so this classification isolates the SHAPE — i.e. the type index.
        const cIn = (c[i] + c[i + 1] + c[i + 2]) < 30;
        const gIn = (g[i] + g[i + 1] + g[i + 2]) < 30;
        if (cIn !== gIn) xor++;
      }
      perScheme.push({ scheme, meanAbs: sumAbs / (count * 3), xorFrac: xor / count });
    }
    console.log(
      `[S3 pin3] type=${type} ` +
      perScheme.map((p) => `${p.scheme}=xor${p.xorFrac.toFixed(3)}/abs${p.meanAbs.toFixed(1)}`).join(' '),
    );

    // STATED THRESHOLDS. Measured on this host, sampled at 32x32. Correct build:
    // worst xorFrac 0.022 (burningship) and worst meanAbs 8.5 (julia/rainbow); the
    // residual is the half-pixel CPU-corner vs GPU-centre sampling difference.
    // Deliberately broken builds: a drifted TYPE index drives xorFrac to ~0.11,
    // and a drifted PALETTE index drives meanAbs to 39.5-97.0. Both control arms
    // are recorded in the landing report.
    for (const p of perScheme) {
      expect(p.xorFrac, `${type}/${p.scheme}: inside/outside disagreement (type index)`).toBeLessThan(0.06);
      expect(p.meanAbs, `${type}/${p.scheme}: mean per-channel |CPU-GPU| (palette index)`).toBeLessThan(20);
    }
    expect(pageErrors).toEqual([]);
  });
}
