// @ts-check
// PAN-FROZEN — the owner's report and instruction, verbatim:
//
//   "Panning in deep zoom does not really work. Please do NOT render while panning.
//    Just move the image thats there and start rendering when the mouse gets off."
//
// THE DEFECT, MEASURED. Before this slice `FractalViewer.onMouseMove` ran
// `panView(...)` and then `this.render()`, and `app.js`'s view-change path
// re-rendered the GPU lane on EVERY drag event. At depth each of those is a full
// coarse->fine chain (with the current cap, hundreds of ms), so a deep pan queued
// render upon render — the reported symptom. The mousemove is delivered TWICE per
// event over the canvas (`FractalViewer.setupEvents` binds `window` and
// `attachFractalMouseEvents` binds the canvas), which doubles it again.
//
// THE FIX (the mechanism this pin holds). While a PAN gesture owns the view — a
// mouse drag, or a one-finger touch drag — the last COMPLETED frame is moved by a
// CSS-pixel compositor transform on the canvas the gesture arrived on, and NO
// render work starts (no chain, no single pass, no CPU job). On release the normal
// view-change path runs EXACTLY ONCE, at the final view, and the frozen layer is
// released only when a completed frame is actually drawn (`setData` for the CPU
// lane, `renderWebGL` for the GPU lane) — so the panned image stays where the user
// left it until a real frame covers the whole canvas.
//
// WHAT IS PINNED HERE, each with its FAILING BASELINE measured in the SAME pin
// through the SAME handlers (`window.__fv.setPanFreeze(false)` restores the
// pre-change behaviour: one render per mousemove, no frozen frame):
//
//  1. A real mouse drag at a DEEP view starts ZERO chains and applies ZERO GPU
//     passes while `panning()` is true; the view really moved; and exactly ONE
//     render starts on mouse-up. The baseline renders per mousemove.
//  2. The frozen frame is a translated layer that tracks the pointer EXACTLY (the
//     same pixel-per-pointer-pixel rule `panView` documents) and is marked as NOT
//     settled; the single render on release covers the whole canvas and clears it.
//  3. The CPU lane obeys the same contract: no job starts while dragging, exactly
//     one on mouse-up, and the frozen layer is released by the first completed
//     frame (`setData`).
//  4. A one-finger TOUCH drag obeys it too.
//
// ZOOM is deliberately NOT pinned here as changed: the wheel/pinch paths and the
// startup animation keep the REFINE/ANIM-REFINE behaviour, and their own pins
// (`tests/gpu-refine.spec.js`, `tests/anim-refine.spec.js`,
// `tests/touch-input.spec.js`) are the no-regression evidence.
const { test, expect } = require('@playwright/test');

// Small because every release renders a real deep frame; the mouse maths does not
// depend on the pixel count.
test.use({ viewport: { width: 420, height: 320 } });

const PROBE_CENTRE = { centerX: -0.743643887037151, centerY: 0.13182590420533 };
// Deep enough to be the perturbation lane (below ITER_BUDGET_MIN_SCALE = 1e-4, where
// a full pass is far more expensive than a move) while a CSS-pixel drag is still
// LARGER than the float64 centre's own ULP (~1.1e-16 near |c| ~ 0.74). At 1e-15 a
// 14 px move is ~4.4e-17, i.e. sub-ULP, so the float64 centre cannot move at all —
// a real depth property, not this slice's subject.
const DEEP_SCALE = 1e-8;

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderSource()), { timeout: 10_000 })
    .not.toBe(null);
}

async function quiesce(page) {
  await page.evaluate(async () => {
    const idle = () => window.__fv.jobToken() === null && window.__fv.gpuJobToken() === null;
    for (let i = 0; i < 1000; i++) {
      if (idle()) {
        await new Promise((r) => setTimeout(r, 20));
        if (idle()) return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the renderer never went idle');
  });
}

// A point that really lands on the named canvas (the `#controls` panel sits above
// it at the top-left, so a fixed point would be at the mercy of the panel's size).
async function freePoint(page, canvasId) {
  const pt = await page.evaluate((id) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const cands = [[0.8, 0.8], [0.62, 0.85], [0.88, 0.5], [0.5, 0.88], [0.7, 0.6]];
    for (const [fx, fy] of cands) {
      const x = Math.round(vw * fx), y = Math.round(vh * fy);
      const el = document.elementFromPoint(x, y);
      if (el && el.id === id) return { x, y };
    }
    return null;
  }, canvasId);
  expect(pt, `a point on #${canvasId} must be reachable (the controls panel covers the rest)`).not.toBe(null);
  return pt;
}

// The shared scripted drag: `down`, `moves.length` real mousemoves, `up`. Returns
// what the app reported after every move so the assertions read the app's own state
// rather than the test's intent.
async function scriptedDrag(page, start, moves) {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const afterDown = await page.evaluate(() => ({
    panning: window.__fv.panning(),
    frozen: window.__fv.panFrozen(),
  }));
  const samples = [];
  for (const [dx, dy] of moves) {
    await page.mouse.move(start.x + dx, start.y + dy);
    samples.push(await page.evaluate(() => {
      const c = document.getElementById('fractalCanvasWebGL');
      const c2 = document.getElementById('fractalCanvas');
      const active = (c && c.style.display !== 'none') ? c : c2;
      return {
        panning: window.__fv.panning(),
        frozen: window.__fv.panFrozen(),
        translate: window.__fv.panTranslate(),
        moves: window.__fv.panFrozenMoves(),
        passes: window.__fv.gpuPasses(),
        started: window.__fv.gpuChains().started,
        fullPasses: window.__fv.fullImagePasses(),
        jobCount: window.__fv.jobCount(),
        token: window.__fv.gpuJobToken(),
        jobToken: window.__fv.jobToken(),
        view: window.__fv.getView(),
        transform: active ? active.style.transform : null,
        marker: active ? active.dataset.fvPanFrozen || null : null,
      };
    }));
  }
  return { afterDown, samples };
}

// --- pin 1: a deep mouse drag — the owner's instruction, with its baseline ------

test('PAN-FROZEN pin 1: a deep mouse drag starts NO render while dragging and exactly ONE on mouse-up; the pre-change baseline renders per mousemove', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);
  await quiesce(page);

  const MOVES = [[14, 10], [28, 20], [42, 30], [56, 40]];

  // ---- ARM 1: the shipped freeze -------------------------------------------------
  await page.evaluate(({ centre, scale }) => window.__fv.setDeepView({ ...centre, scale }), {
    centre: PROBE_CENTRE, scale: DEEP_SCALE,
  });
  await page.evaluate(() => window.__fv.whenRenderSettled());
  await quiesce(page);

  // Count any pass that runs while `panning()` is true, from inside the real pass
  // hook: this is the "while dragging is true" assertion stated on the effect, not
  // on a counter read between events.
  await page.evaluate(() => { window.__panPasses = 0; window.__fv.setGpuPassHook(() => { if (window.__fv.panning()) window.__panPasses++; }); });

  const before = await page.evaluate(() => ({
    view: window.__fv.getView(),
    passes: window.__fv.gpuPasses(),
    started: window.__fv.gpuChains().started,
    full: window.__fv.fullImagePasses(),
    jobs: window.__fv.jobCount(),
    renderText: document.getElementById('renderTime').textContent,
  }));

  const start = await freePoint(page, 'fractalCanvasWebGL');
  const { afterDown, samples } = await scriptedDrag(page, start, MOVES);

  expect(afterDown.panning, 'a mousedown on the canvas begins a PAN').toBe(true);
  expect(afterDown.frozen, 'no frame is frozen before the first move').toBe(false);

  const last = samples[samples.length - 1];
  const panPasses = await page.evaluate(() => window.__panPasses);
  const renderTextDuringDrag = await page.evaluate(() => document.getElementById('renderTime').textContent);

  // THE PIN (frozen arm): while the drag owns the view, NOTHING renders.
  for (const s of samples) {
    expect(s.panning, 'every move is seen as a pan').toBe(true);
    expect(s.passes, 'zero GPU passes while dragging').toBe(before.passes);
    expect(s.started, 'zero chains started while dragging').toBe(before.started);
    expect(s.token, 'no GPU chain in flight while dragging').toBe(null);
    expect(s.jobToken, 'no CPU job in flight while dragging').toBe(null);
    expect(s.jobCount, 'no CPU job started while dragging').toBe(before.jobs);
  }
  expect(panPasses, 'the pass hook saw no pass while panning was true').toBe(0);
  expect(last.frozen, 'the last completed frame is now a frozen layer').toBe(true);
  expect(last.view.centerX, 'the view really moved in x').not.toBe(before.view.centerX);
  expect(last.view.centerY, 'the view really moved in y').not.toBe(before.view.centerY);
  expect(last.transform, 'the frozen frame is moved by a compositor transform').toContain('translate(');
  expect(last.marker, 'the frozen frame is marked NOT settled').toBe('1');
  expect(renderTextDuringDrag, 'the render-time readout does not claim a render during the drag')
    .toBe(before.renderText);

  // The translate tracks the pointer EXACTLY: the same pixel-per-pointer-pixel rule
  // `panView` documents, in CSS pixels.
  for (let i = 0; i < samples.length; i++) {
    expect(samples[i].translate.x, `move ${i}: x tracks the pointer exactly`).toBe(MOVES[i][0]);
    expect(samples[i].translate.y, `move ${i}: y tracks the pointer exactly`).toBe(MOVES[i][1]);
  }

  // THE ONE RENDER ON MOUSE-UP, started synchronously by the release (the chain's
  // first level runs inside `renderWebGL`).
  await page.mouse.up();
  const afterUp = await page.evaluate(() => ({
    panning: window.__fv.panning(),
    started: window.__fv.gpuChains().started,
    token: window.__fv.gpuJobToken(),
    transform: document.getElementById('fractalCanvasWebGL').style.transform,
  }));
  expect(afterUp.panning, 'the release ends the pan').toBe(false);
  expect(afterUp.started - before.started, 'exactly ONE render chain starts on mouse-up').toBe(1);
  expect(afterUp.token, 'and it is the chain in flight').not.toBe(null);
  await page.evaluate(() => window.__fv.whenRenderSettled());
  // The normal view-change path ALSO starts a CPU job (pre-existing: the CPU lane's
  // final frame re-renders through the GPU path). At the deep view it is a slow
  // render and is not this pin's subject, so it is cancelled rather than waited on.
  await page.evaluate(() => window.__fv.cancelJob());
  const after = await page.evaluate(() => ({
    full: window.__fv.fullImagePasses(),
    frozen: window.__fv.panFrozen(),
    moves: window.__fv.panFrozenMoves(),
    commits: window.__fv.panCommits(),
    transform: document.getElementById('fractalCanvasWebGL').style.transform,
    marker: document.getElementById('fractalCanvasWebGL').dataset.fvPanFrozen || null,
  }));
  expect(after.full - before.full, 'the single render covers the whole canvas').toBe(1);
  expect(after.frozen, 'a drawn frame releases the frozen layer').toBe(false);
  expect(after.transform, 'the compositor transform is cleared once a frame covers the canvas').toBe('');
  expect(after.marker, 'and the not-settled marker is gone').toBe(null);
  expect(after.commits, 'the commit is counted').toBeGreaterThanOrEqual(1);
  expect(after.moves, 'the drag really translated the frame').toBeGreaterThanOrEqual(MOVES.length);

  // ---- ARM 2: the FAILING BASELINE, same handlers, freeze off --------------------
  // `setPanFreeze(false)` restores exactly the pre-change code path (render +
  // view-change per mousemove), which is how the defect is measured in-pin rather
  // than asserted from the diff.
  await page.evaluate(() => { window.__panPasses = 0; window.__fv.setPanFreeze(false); });
  await page.evaluate(({ centre, scale }) => window.__fv.setDeepView({ ...centre, scale }), {
    centre: PROBE_CENTRE, scale: DEEP_SCALE,
  });
  await page.evaluate(() => window.__fv.whenRenderSettled());
  await quiesce(page);
  const base0 = await page.evaluate(() => ({
    passes: window.__fv.gpuPasses(),
    started: window.__fv.gpuChains().started,
  }));
  const baseStart = await freePoint(page, 'fractalCanvasWebGL');
  await scriptedDrag(page, baseStart, MOVES);
  const baseDuring = await page.evaluate(() => ({
    passes: window.__fv.gpuPasses(),
    started: window.__fv.gpuChains().started,
    panPasses: window.__panPasses,
    panning: window.__fv.panning(),
  }));
  await page.mouse.up();
  // The baseline started a CPU job per mousemove at a deep view; stop it before it
  // dominates the host (the defect, not the pin's subject).
  await page.evaluate(() => { window.__fv.cancelJob(); window.__fv.setPanFreeze(true); window.__fv.setGpuPassHook(null); });
  await quiesce(page);

  const baseStarted = baseDuring.started - base0.started;
  const basePasses = baseDuring.passes - base0.passes;
  console.log('[PAN pin1] frozen arm : moves=' + MOVES.length + ' chainsStarted=' + (afterUp.started - before.started)
    + ' passesWhilePanning=' + panPasses + ' passesDuringDrag=' + (last.passes - before.passes)
    + ' mouseUpFullPasses=1 fullDelta=' + (after.full - before.full));
  console.log('[PAN pin1] baseline   : moves=' + MOVES.length + ' chainsStarted=' + baseStarted
    + ' passesDuringDrag=' + basePasses + ' passesWhilePanning=' + baseDuring.panPasses
    + ' (the pre-change build; two listener deliveries per move)');

  // The contrast IS the defect: the freeze starts nothing, the baseline starts a
  // render per delivered mousemove (at least one per dispatched move).
  expect(baseDuring.panning, 'the baseline still reports a pan').toBe(true);
  expect(baseStarted, 'the pre-change baseline starts a chain per delivered mousemove').toBeGreaterThanOrEqual(MOVES.length);
  expect(basePasses, 'and applies a GPU pass per delivered mousemove').toBeGreaterThanOrEqual(MOVES.length);
  expect(baseDuring.panPasses, 'which really ran while panning was true').toBeGreaterThanOrEqual(MOVES.length);

  expect(pageErrors).toEqual([]);
});

// --- pin 2: the CPU lane obeys the same contract --------------------------------

test('PAN-FROZEN pin 2: the CPU lane starts no job while dragging, exactly one on mouse-up, and its frozen layer is released by the first completed frame', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);
  await quiesce(page);

  // The manual CPU lane (DECISIONS 106's "no crossover" is intact: this is the
  // user's own checkbox, not an automatic switch).
  await page.uncheck('#webglRender');
  await expect(page.locator('#fractalCanvas')).toBeVisible();
  await page.evaluate(() => window.__fv.setView({ ...window.__fv.getView(), scale: 0.25 }));
  await quiesce(page);

  const MOVES = [[18, 12], [36, 24], [54, 36]];
  const before = await page.evaluate(() => ({
    view: window.__fv.getView(),
    jobs: window.__fv.jobCount(),
    commits: window.__fv.panCommits(),
  }));

  const start = await freePoint(page, 'fractalCanvas');
  const { afterDown, samples } = await scriptedDrag(page, start, MOVES);
  expect(afterDown.panning).toBe(true);

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    expect(s.panning, 'one finger/mouse drag on the 2D canvas is a pan').toBe(true);
    expect(s.jobCount, 'no CPU job starts while dragging').toBe(before.jobs);
    expect(s.jobToken, 'and none is in flight').toBe(null);
    expect(s.frozen, 'the 2D frame is frozen').toBe(true);
    expect(s.translate.x, `move ${i}: the 2D frame tracks the pointer exactly`).toBe(MOVES[i][0]);
    expect(s.translate.y, `move ${i}: and in y`).toBe(MOVES[i][1]);
    expect(s.transform, 'the 2D canvas carries the transform').toContain('translate(');
    expect(s.marker, 'and is marked not settled').toBe('1');
  }

  await page.mouse.up();
  const afterUp = await page.evaluate(() => ({
    jobs: window.__fv.jobCount(),
    frozen: window.__fv.panFrozen(),
    token: window.__fv.jobToken(),
    view: window.__fv.getView(),
  }));
  expect(afterUp.jobs - before.jobs, 'exactly one CPU job starts on mouse-up').toBe(1);
  expect(afterUp.token, 'it is in flight').not.toBe(null);
  expect(afterUp.view.centerX, 'at the final panned view').not.toBe(before.view.centerX);

  // The frozen layer survives the release: only the first completed frame
  // (`applyWorkerFrame` -> `viewer.setData`) may clear it — that is what stops the
  // image snapping back to the pre-pan position while the worker computes.
  await expect.poll(() => page.evaluate(() => window.__fv.panFrozen()), { timeout: 60_000 }).toBe(false);
  await quiesce(page);
  const after = await page.evaluate(() => ({
    commits: window.__fv.panCommits(),
    transform: document.getElementById('fractalCanvas').style.transform,
    marker: document.getElementById('fractalCanvas').dataset.fvPanFrozen || null,
  }));
  expect(after.commits, 'the CPU frame committed the frozen pan').toBeGreaterThan(before.commits);
  expect(after.transform, 'the transform is cleared by the commit').toBe('');
  expect(after.marker, 'and the marker is gone').toBe(null);

  expect(pageErrors).toEqual([]);
});

// --- pin 3: touch panning obeys it too ------------------------------------------

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('PAN-FROZEN pin 3: a one-finger touch drag starts NO render while dragging and exactly ONE on release', async ({ page }) => {
    test.setTimeout(180_000);
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto('./', { waitUntil: 'domcontentloaded' });
    await waitSettled(page);
    await quiesce(page);

    const touch = async (cdp, type, points) => {
      await cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
      });
    };

    const start = await freePoint(page, 'fractalCanvasWebGL');
    const MOVES = [[20, 14], [40, 28], [60, 42]];
    const before = await page.evaluate(() => ({
      view: window.__fv.getView(),
      passes: window.__fv.gpuPasses(),
      started: window.__fv.gpuChains().started,
    }));

    const cdp = await page.context().newCDPSession(page);
    await touch(cdp, 'touchStart', [{ x: start.x, y: start.y, id: 1 }]);
    const samples = [];
    for (const [dx, dy] of MOVES) {
      await touch(cdp, 'touchMove', [{ x: start.x + dx, y: start.y + dy, id: 1 }]);
      samples.push(await page.evaluate(() => ({
        panning: window.__fv.panning(),
        frozen: window.__fv.panFrozen(),
        translate: window.__fv.panTranslate(),
        passes: window.__fv.gpuPasses(),
        started: window.__fv.gpuChains().started,
      })));
    }
    const last = samples[samples.length - 1];
    await touch(cdp, 'touchEnd', []);

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      expect(s.panning, 'a one-finger touch drag is a pan').toBe(true);
      expect(s.passes, 'zero GPU passes while touch-panning').toBe(before.passes);
      expect(s.started, 'zero chains started while touch-panning').toBe(before.started);
      expect(s.frozen, 'the touch pan freezes the frame').toBe(true);
      expect(s.translate.x, `touch move ${i}: x tracks the finger exactly`).toBe(MOVES[i][0]);
      expect(s.translate.y, `touch move ${i}: y tracks the finger exactly`).toBe(MOVES[i][1]);
    }
    expect(last.panning).toBe(true);

    const afterUp = await page.evaluate(() => ({
      panning: window.__fv.panning(),
      started: window.__fv.gpuChains().started,
      view: window.__fv.getView(),
    }));
    expect(afterUp.panning, 'lifting the finger ends the pan').toBe(false);
    expect(afterUp.started - before.started, 'exactly ONE render starts on touch release').toBe(1);
    expect(afterUp.view.centerX, 'the touch pan moved the view').not.toBe(before.view.centerX);

    // ZOOM on touch is untouched: a two-finger pinch still zooms (the full
    // contract, including the anchor, is pinned by tests/touch-input.spec.js).
    await page.evaluate(() => window.__fv.whenRenderSettled());
    await quiesce(page);
    const scaleBefore = (await page.evaluate(() => window.__fv.getView())).scale;
    await touch(cdp, 'touchStart', [{ x: 260, y: 160, id: 11 }, { x: 340, y: 160, id: 12 }]);
    await touch(cdp, 'touchMove', [{ x: 220, y: 160, id: 11 }, { x: 380, y: 160, id: 12 }]);
    await touch(cdp, 'touchEnd', []);
    await page.evaluate(() => window.__fv.whenRenderSettled());
    const scaleAfter = (await page.evaluate(() => window.__fv.getView())).scale;
    expect(scaleAfter, 'a two-finger pinch still zooms (touch ZOOM unchanged)').toBeLessThan(scaleBefore);

    expect(pageErrors).toEqual([]);
  });
});
