// @ts-check
// S6 / hygiene — three pins, each of which goes RED when its behaviour breaks:
//
//   1. NO app console output during a scripted interaction. Before S6 four
//      `[FractalMouse]` console.logs sat on the hottest paths (every mousedown,
//      every wheel tick, every view-change render).
//   2. NO alert / confirm / prompt is ever CALLED, while BOTH paths that used to
//      use one stay usable: the save/naming flow (was `window.prompt`) and the
//      GPU zoom-cap offer (was `window.confirm`), whose cap must still apply
//      whichever answer the user gives — or none at all.
//   3. The four dead files are GONE and nothing serves or fetches them
//      (`recursiveFractalVibe.js`, `recursiveFractalLetter.js`,
//      `splashMandelbrotCurve.js`, `styles/fractSplashFractalText.css`).
//
// These drive the REAL UI: the save pin clicks `#saveLocationBtn` and fills the
// real input, the cap pin calls the same `setScale` path the wheel uses and
// clicks the offer's real buttons. No second fixture surface is introduced.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

// The app is served from `public/`; the spec files live one level up.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEAD_FILES = [
  'recursiveFractalVibe.js',
  'recursiveFractalLetter.js',
  'splashMandelbrotCurve.js',
  'styles/fractSplashFractalText.css',
];

// --- pin 1: zero app console output -------------------------------------------
//
// THE FILTER, and why a stopped app cannot satisfy it: every call to a console
// method is recorded at the console object itself, together with the URL of the
// script that made it (`Error().stack`), BEFORE app.js runs. The assertion is
// "no recorded call came from a URL containing `app.js`". It therefore cannot be
// satisfied by an app that never started — a stopped app produces no calls at
// all, which is why this test ALSO asserts that the app ran (the startup
// animation settled and a real render completed). The script-URL filter is what
// keeps the pin from being an assertion about the browser's own chatter: a
// violation is a message the app's own source emitted, whatever console method
// it used and whatever text it carried. The control run (one `console.log`
// re-added to app.js) turns this test RED.
test('S6 pin: a scripted interaction produces ZERO app console output', async ({ page }) => {
  await page.addInitScript(() => {
    window.__fvConsoleCalls = [];
    ['log', 'info', 'debug', 'warn', 'error', 'trace', 'assert'].forEach((level) => {
      const original = console[level];
      if (typeof original !== 'function') return;
      console[level] = function (...args) {
        let url = '';
        try { url = String(new Error().stack || ''); } catch (_) { url = ''; }
        window.__fvConsoleCalls.push({ level, url, text: args.map(String).join(' ') });
        return original.apply(console, args);
      };
    });
  });
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  // Proof the app RAN, not that it was silent because it was dead:
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  await expect
    .poll(async () => page.evaluate(() => window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);

  // The scripted interaction: startup -> pan -> zoom -> GPU/CPU toggle -> open
  // and close the locations modal. Every step is the app's real path.
  const canvas = page.locator('#fractalCanvasWebGL');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('#fractalCanvasWebGL has no box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 8 }); // pan
  await page.mouse.up();
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, i % 2 === 0 ? 400 : -400); // zoom in / out
    await page.waitForTimeout(50);
  }
  await page.uncheck('#webglRender'); // GPU -> CPU
  await page.check('#webglRender');   // CPU -> GPU
  await page.click('#loadLocationBtn');        // open the locations modal
  await expect(page.locator('#loadLocationModal')).toBeVisible();
  await page.click('#closeLoadLocationModal'); // close it
  await expect(page.locator('#loadLocationModal')).toBeHidden();
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  const result = await page.evaluate(() => {
    const calls = window.__fvConsoleCalls || [];
    // The app's own source is served as `.../app.js`; `three.module.js`,
    // `fractalViewer.js` and the browser's own messages have other URLs and are
    // deliberately NOT part of this pin (removing three.js's warnings is not
    // this slice's job and they are not the app's instrumentation).
    const fromApp = calls.filter((c) => c.url.indexOf('app.js') !== -1);
    return {
      total: calls.length,
      fromApp,
      renderTime: (document.getElementById('renderTime') || {}).textContent || '',
    };
  });

  expect(
    result.fromApp,
    'app.js console output during the scripted interaction',
  ).toEqual([]);
  // Non-vacuity, in the OTHER direction: the app clearly produced a render, so
  // "zero console output" is not "nothing happened".
  expect(result.renderTime).toMatch(/Render: [\d.]+ ms/);
});

// --- pin 2: no alert/confirm/prompt is ever CALLED ----------------------------
//
// All three are stubbed at init to RECORD the call and to return a safe value
// (`prompt` -> the caller's default, `confirm` -> false) so the flows continue
// even if the app still used one. Driving both retired paths must leave the
// record empty. Restoring `window.prompt` in the save path (the control) makes
// this test RED.
test('S6 pin: no alert/confirm/prompt is called; both non-modal flows stay usable', async ({ page }) => {
  await page.addInitScript(() => {
    window.__fvDialogs = [];
    const record = (kind) => (message) => {
      window.__fvDialogs.push({ kind, message: String(message) });
      if (kind === 'prompt') return '';              // safe value: accept the default
      if (kind === 'confirm') return false;          // safe value: decline
      return undefined;
    };
    window.alert = record('alert');
    window.confirm = record('confirm');
    window.prompt = record('prompt');
  });
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  // (a) the naming/save path, driven through the REAL buttons and input.
  await page.click('#saveLocationBtn');
  const panel = page.locator('#saveLocationPanel');
  await expect(panel).toBeVisible();
  const defaultName = await page.locator('#saveLocationName').inputValue();
  expect(defaultName).toContain('Location (');
  await page.fill('#saveLocationName', 'S6 named location');
  await page.click('#saveLocationConfirm');
  await expect(panel).toBeHidden();

  // The dialog contract is asserted FIRST, at the point the save flow runs, so
  // restoring `window.prompt` fails on the dialog call itself (the control) and
  // not merely on some later consequence of it.
  expect(
    await page.evaluate(() => window.__fvDialogs),
    'alert/confirm/prompt calls after the save path',
  ).toEqual([]);

  const afterSave = await page.evaluate(() => window.__fv.storedLocations());
  expect(afterSave.map((l) => l.name)).toEqual(['S6 named location']);

  // Cancellation is honoured: the panel opens, Cancel stores nothing.
  await page.click('#saveLocationBtn');
  await page.fill('#saveLocationName', 'discard me');
  await page.click('#saveLocationCancel');
  await expect(panel).toBeHidden();
  const afterCancel = await page.evaluate(() => window.__fv.storedLocations());
  expect(afterCancel.length).toBe(1);
  expect(afterCancel.map((l) => l.name)).toEqual(['S6 named location']);

  // (b) the GPU zoom-cap offer path. `setScale` is the same clamp entry point
  // the wheel uses; the cap must be applied even though nothing is answered.
  const capped = await page.evaluate(() => {
    window.__fv.setScale(1e-9);
    return window.__fv.getView().scale;
  });
  expect(capped).toBe(await page.evaluate(() => window.__fv.minScale));
  await expect(page.locator('#zoomCapOffer')).toBeVisible();
  // The user WAS asked (once), and the ask is not a dialog.
  expect(await page.evaluate(() => window.__fv.zoomCapPrompted())).toBe(true);
  // A further capped tick must not ask again.
  const again = await page.evaluate(() => {
    const seen = [];
    window.addEventListener('fv-zoom-limit', (e) => seen.push(e.detail));
    window.__fv.setScale(1e-9);
    return seen;
  });
  expect(again.map((d) => d.prompted)).toEqual([false]);

  // The offer's REAL "switch" answer: CPU mode, cap still applied.
  await page.click('#zoomCapSwitchToCpu');
  await expect(page.locator('#zoomCapOffer')).toBeHidden();
  expect(await page.isChecked('#webglRender')).toBe(false);
  expect(await page.evaluate(() => window.__fv.getView().scale)).toBe(
    await page.evaluate(() => window.__fv.minScale),
  );

  const dialogs = await page.evaluate(() => window.__fvDialogs);
  expect(dialogs, 'alert/confirm/prompt calls after BOTH paths').toEqual([]);
});

// The offer's OTHER answer (dismiss) is a separate concern: it must hide the
// offer, keep the cap, and never ask again — still with no dialog anywhere.
test('S6 pin: dismissing the zoom-cap offer keeps the cap and never asks again', async ({ page }) => {
  await page.addInitScript(() => {
    window.__fvDialogs = [];
    const record = (kind) => (message) => {
      window.__fvDialogs.push({ kind, message: String(message) });
      if (kind === 'prompt') return '';
      if (kind === 'confirm') return true; // even "yes" must not be consulted
      return undefined;
    };
    window.alert = record('alert');
    window.confirm = record('confirm');
    window.prompt = record('prompt');
  });
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);

  await page.evaluate(() => window.__fv.setScale(1e-9));
  await expect(page.locator('#zoomCapOffer')).toBeVisible();
  await page.click('#zoomCapDismiss');
  await expect(page.locator('#zoomCapOffer')).toBeHidden();

  const after = await page.evaluate(() => {
    const events = [];
    window.addEventListener('fv-zoom-limit', (e) => events.push(e.detail));
    window.__fv.setScale(1e-9);
    return {
      scale: window.__fv.getView().scale,
      minScale: window.__fv.minScale,
      promptedNow: window.__fv.zoomCapPrompted(),
      offeredNow: window.__fv.zoomCapOffered(),
      events,
      dialogs: window.__fvDialogs,
    };
  });
  expect(after.scale).toBe(after.minScale);           // the cap still applies
  expect(after.offeredNow).toBe(false);               // the offer did not come back
  expect(after.events.map((d) => d.prompted)).toEqual([false]); // and never asks again
  expect(after.dialogs).toEqual([]);
});

// --- pin 3: the dead files are gone -------------------------------------------
//
// Both halves are asserted because they fail for DIFFERENT regressions: a file
// restored on disk (or re-tracked by git) fails the filesystem half, and a
// request that starts being served again fails the HTTP half. Neither half can
// pass by the app simply not using the file today.
test('S6 pin: the four dead files are not tracked, not on disk and not served', async ({ request }) => {
  const { execFileSync } = require('child_process');
  const repoRoot = path.join(__dirname, '..');
  for (const rel of DEAD_FILES) {
    // 1. not present in the published tree...
    expect(fs.existsSync(path.join(PUBLIC_DIR, rel)), `${rel} exists on disk`).toBe(false);
    // 2. ...and not tracked by git (a `git checkout` of an old tree cannot
    //    silently bring it back into the published directory).
    let tracked = true;
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', `public/${rel}`], {
        cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_) {
      tracked = false;
    }
    expect(tracked, `${rel} is still tracked by git`).toBe(false);
    // 3. ...and the dev server does not serve it (Express publishes `public/`).
    const res = await request.get(rel);
    expect(res.status(), `GET ${rel}`).toBe(404);
  }
});

// --- favicon -------------------------------------------------------------------
// The page declared NO icon, so the browser fell back to /favicon.ico at the HOST
// ROOT, which 404s (it belongs to the host, not to this app). That 404 showed up
// as a console error in every verification run and was chased twice as an app
// defect (docs/STATE.md TRAP). This pin holds the fix at each link in the chain:
// the app DECLARES the icon, the icon is REALLY served, and a browser really
// receives it. Declaration alone is the trap — `href="favicon.svg"` passes even
// if the file 404s, which is the exact shape of the bug being fixed.
test('pin: the app declares an icon and the browser really receives it', async ({ request, page }) => {
  // 1. index.html declares exactly one icon, with a RELATIVE href (this app is
  //    served from a subpath; a root-absolute href would 404 in production).
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const hrefs = [...html.matchAll(/<link[^>]*rel=["']icon["'][^>]*href=["']([^"']+)["']/g)].map((m) => m[1]);
  expect(hrefs.length, 'index.html must declare exactly one rel="icon"').toBe(1);
  expect(hrefs[0].startsWith('/'), `icon href must be relative, got ${hrefs[0]}`).toBe(false);
  expect(hrefs[0].includes('..')).toBe(false);

  // 2. the declared icon is on disk and is a real standalone SVG (no external
  //    font/image reference, which would silently fail when served as an icon).
  const iconPath = path.join(PUBLIC_DIR, hrefs[0]);
  expect(fs.existsSync(iconPath), `${hrefs[0]} is not on disk`).toBe(true);
  const svg = fs.readFileSync(iconPath, 'utf8');
  expect(svg.includes('<svg')).toBe(true);
  expect(svg).not.toMatch(/<image\b|xlink:href|@font-face/);

  // 3. it is really SERVED by the app server, at the declared URL.
  const res = await request.get(hrefs[0]);
  expect(res.status(), `GET ${hrefs[0]}`).toBe(200);
  expect((res.headers()['content-type'] || '').toLowerCase()).toContain('svg');

  // 4. and a REAL browser receives it: load the page and watch the network. This
  //    is the step that distinguishes "declared" from "delivered" — and the step
  //    that would have caught the original host-root 404.
  const seen = [];
  page.on('response', (r) => {
    if (/favicon/.test(r.url())) seen.push({ status: r.status(), url: r.url(), type: r.headers()['content-type'] || '' });
  });
  await page.goto('./');
  await page.waitForFunction(() => window.__fv && typeof window.__fv.orbitFrame === 'function', null, { timeout: 30_000 });
  await expect.poll(() => seen.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(seen.some((s) => s.status === 200), `icon responses: ${JSON.stringify(seen)}`).toBe(true);
  expect(seen.some((s) => s.status >= 400), `a favicon request failed: ${JSON.stringify(seen)}`).toBe(false);
});
