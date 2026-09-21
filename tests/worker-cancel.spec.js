// @ts-check
// WORKER-CANCEL — the owner's own reproduction, as an executable acceptance test.
//
// Symptom (reproduced by the owner and by the dispatcher): wheel-zooming from the
// default view into the CPU fallback lane showed, in `#appMessage`,
//   Error: Uncaught NetworkError: Failed to execute 'importScripts' on
//   'WorkerGlobalScope': The script at '…/fractalKernel.js' failed to load.
// and the canvas never recovered until the view changed.
//
// PROVEN firing site (instrumented run, 2026-09-21): `onWheel` →
// `startFractalCalculation` → `cancelJob` on every tick; `cancelJob` terminated the
// worker that had JUST been spawned, still inside its `importScripts`. The browser
// delivered the aborted load as an `error` event on the Worker; `terminateWorker`
// had already detached `w.onerror`, so nothing called `preventDefault()` and it
// escaped to `window.onerror` (`app.js` global net) — which is the ONLY producer of
// the `Error: <text>` banner with no `(file:line)` suffix. Measured before the fix:
// 44 worker error events, 44 window error events, 44 aborted `fractalKernel.js`
// requests. Playwright's `pageerror` sees NONE of them (that is why the owner's
// DevTools console was empty).
//
// The defect needs a worker to be terminated WHILE its `importScripts` is in
// flight. At local network speed that window is a few milliseconds, so the defect
// is invisible (measured: 0 aborts at ~5 ms, 44 aborts at 400 ms). A slow or busy
// network is exactly the owner's condition, so this spec DELAYS `fractalKernel.js`
// to make the window wide and deterministic instead of depending on host load.
const { test, expect } = require('@playwright/test');

// Delay every `fractalKernel.js` response. `cache-control: no-store` guarantees
// each Worker's `importScripts` really goes to the network (a cached response
// would close the window the defect lives in). The request may be aborted while
// the route is sleeping on a BROKEN build — that is the defect, so the continue is
// guarded rather than allowed to reject the route handler for the wrong reason.
async function delayKernel(page, ms) {
  await page.route('**/fractalKernel.js', async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    try {
      await route.continue({ headers: { ...route.request().headers(), 'cache-control': 'no-store' } });
    } catch (_) { /* the request was aborted while we held it: the RED state */ }
  });
}

async function settle(page) {
  await page.waitForFunction(() => window.__fv && window.__fv.animationSettled(), null, { timeout: 40_000 });
  await page.waitForFunction(() => window.__fv.jobToken() === null, null, { timeout: 40_000 }).catch(() => {});
}

test('WORKER-CANCEL: a real wheel-zoom into the CPU lane never aborts a kernel load, never shows the fatal banner, and keeps rendering', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  const failedKernelRequests = [];
  page.on('requestfailed', (req) => {
    if (/fractalKernel\.js/.test(req.url())) failedKernelRequests.push(req.url());
  });

  await delayKernel(page, 400);
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await settle(page);

  // Enter the CPU fallback lane exactly as the zoom-cap offer's "Switch to CPU"
  // does: uncheck the WebGL checkbox and fire its ONE change handler.
  await page.evaluate(() => {
    const cb = /** @type {HTMLInputElement} */ (document.getElementById('webglRender'));
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
  });
  await settle(page);
  // The setup can leave the informational "Zoom limit reached…" notice on screen;
  // clear it so the assertion below is about the wheel-zoom, nothing else.
  await page.evaluate(() => {
    const m = document.getElementById('appMessage');
    m.textContent = '';
    m.className = 'app-message';
    m.style.display = 'none';
  });

  const box = (await page.locator('#fractalCanvas').boundingBox());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await page.evaluate(() => window.__fv.appliedFrames());

  // The owner's interaction, tick for tick: ~48 wheel ticks at ~90 ms. The view
  // reaches the shipped GPU zoom cap and the CPU lane keeps getting superseded.
  for (let i = 0; i < 48; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(90);
  }

  // (1) The canvas keeps producing frames with NO view change: the job the last
  // tick started must reach a final frame on its own...
  await expect.poll(() => page.evaluate(() => window.__fv.jobToken()), { timeout: 40_000 }).toBe(null);
  // ...and the renderer must still apply frames for a fresh job (no freeze).
  const jobBefore = await page.evaluate(() => window.__fv.jobCount());
  await page.evaluate(() => window.__fv.runJob());
  await expect
    .poll(() => page.evaluate((id) => window.__fv.appliedFramesForJob(id), jobBefore + 1), { timeout: 40_000 })
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__fv.appliedFrames())).toBeGreaterThan(before);

  // (2) No fatal banner. The informational zoom-cap notice (which this app also
  // shows in the CPU lane) is allowed; an Error is not.
  const message = page.locator('#appMessage');
  const text = (await message.textContent()) || '';
  expect(text, 'the wheel-zoom must not surface a fatal error banner').not.toMatch(/Error|NetworkError|importScripts|failed to load/i);
  const cls = (await message.getAttribute('class')) || '';
  expect(cls, 'the message surface must not be the error level').not.toMatch(/error/i);

  // (3) We must never have killed a worker mid-load: every kernel load completes,
  // so not one `fractalKernel.js` request is aborted.
  expect(failedKernelRequests, 'no fractalKernel.js load may be aborted').toEqual([]);
  expect(pageErrors).toEqual([]);
});
