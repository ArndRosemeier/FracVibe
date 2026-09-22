// @ts-check
// COARSE-TO-FINE GPU REFINEMENT — the owner's request, verbatim:
//
//   "Deep zooms seem to work well on webgpu. They get slow of course and thats
//    where the coarse to fine rendering should come in. Rendering that does not
//    block further zoom. Can do that for any depth, it just wont be noticable at
//    lower depths."
//
// THREE THINGS ARE PINNED HERE, and each has its FAILING BASELINE measured in the
// SAME pin through the SAME code path:
//
//  1. A deep render produces MORE THAN ONE applied frame, the levels are ordered
//     coarse -> fine, and each level is genuinely CHEAPER than the final one
//     (it rasterises 1/step^2 of the fragments). The final level is byte-for-byte
//     the frame the pre-refinement build drew, so refinement trades total time for
//     perceived responsiveness and changes NOTHING about the picture.
//  2. A view change DURING refinement is honoured immediately: the superseded chain
//     abandons its remaining levels instead of burning GPU time on a view nobody
//     will see, and the FIRST visible response to the wheel is a coarse frame
//     rather than a full-resolution pass.
//  3. At SHALLOW depths the refinement is invisible (owner: "it just wont be
//     noticable at lower depths") — the final frame is identical, so this is not
//     "fixed", it is expected.
//
// THE FAILING BASELINE. `__fv.setGpuSchedule([1])` drives the PRE-CHANGE schedule
// through the SAME renderer, the SAME scheduler and the SAME shader: exactly one
// full-resolution pass and no second level. Against it:
//  * assertion 1 fails by construction — there is one applied frame, the chain has
//    one level, `gpuPasses` advances by one and there is no coarse level to see;
//  * assertion 2 fails MEASURABLY — the single pass is atomic, so a view change
//    cannot be honoured at a level boundary, `passesSkippedOnAbandon` stays 0, and
//    the wheel's first visible response costs a FULL pass (measured below, against
//    the step-8 level the shipped schedule shows).
//  * assertion 3 cannot fail either way — that is the point: the final frame is the
//    same frame in both arms.
//
// The counters are the existing ones (`fullImagePasses` keeps its DECISIONS row 59
// meaning: FULL-RESOLUTION passes only) plus `gpuPasses`/`gpuChainLog`, because a
// coarse level is NOT a full image and redefining the full-image count to make the
// first assertion easy would corrupt the render-time readout's meaning.
const { test, expect } = require('@playwright/test');

test.use({ viewport: { width: 64, height: 48 } });

const PROBE_CENTRE = { centerX: -0.743643887037151, centerY: 0.13182590420533 };
const DEEP_SCALE = 1e-15; // the P1 depth: deep enough that a full pass is expensive

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderSource()), { timeout: 10_000 })
    .not.toBe(null);
}

// Both lanes idle, confirmed across a macrotask. The CPU lane runs a background job
// from startup, and its FINAL frame re-renders through the GPU path
// (`applyWorkerFrame` -> `setData` -> `render`), so a pin that counts GPU passes must
// let that land first or it will count a pass nobody asked for. `jobToken` and
// `gpuJobToken` are the app's own idle observables for the two lanes.
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

// Per-level evidence, measured from the REAL canvas after each applied level: the
// FNV-1a hash of the whole RGBA readback (did the content change?), and two
// content metrics that say WHICH WAY it changed. `uniform8` is the fraction of
// 8x8 canvas blocks whose pixels are all identical: a step-8 NEAREST upscale makes
// that exactly 1.0 (each source texel covers an 8x8 block), and a full-resolution
// frame makes it ~0. `zeroRun` is the fraction of horizontally adjacent pixels with
// an equal red channel — high for a blocky frame, low for a detailed one, so it
// must fall monotonically as the chain refines.
const MEASURE_LEVEL = `(info) => {
  const canvas = document.getElementById('fractalCanvasWebGL');
  const gl = canvas.getContext('webgl');
  const W = canvas.width, H = canvas.height;
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  let same = 0, tot = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x + 1 < W; x++) {
    tot++; if (buf[(y * W + x) * 4] === buf[(y * W + x + 1) * 4]) same++;
  }
  let uni = 0, blocks = 0;
  for (let by = 0; by + 8 <= H; by += 8) for (let bx = 0; bx + 8 <= W; bx += 8) {
    blocks++;
    const c0 = buf[((by * W) + bx) * 4];
    let ok = true;
    for (let y = by; y < by + 8 && ok; y++) for (let x = bx; x < bx + 8; x++) {
      if (buf[(y * W + x) * 4] !== c0) { ok = false; break; }
    }
    if (ok) uni++;
  }
  return { step: info.step, ms: info.ms, levelIndex: info.levelIndex, hash: h >>> 0,
    zeroRun: same / tot, uniform8: blocks ? uni / blocks : 0,
    width: info.width, height: info.height };
}`;

// --- pin 1: the chain, its cost ordering, and the final frame -------------------

test('REFINE pin 1: a deep render applies a coarse-to-fine chain whose levels are genuinely cheaper, and the final frame is the pre-refinement image', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);
  await quiesce(page);

  const out = await page.evaluate(async ({ centre, scale, measureSrc }) => {
    const fv = window.__fv;
    // The level metric runs in the page (the pass hook is a page-side callback), so
    // one body is shared by every measurement rather than restated per arm.
    const measure = (0, eval)(measureSrc); // eslint-disable-line no-eval
    const levels = [];
    fv.setDeepView({ ...centre, scale });
    await fv.whenRenderSettled();
    const orbitBefore = fv.orbitComputations();
    const fullBefore = fv.fullImagePasses();
    const gpuBefore = fv.gpuPasses();
    fv.setGpuPassHook((info) => levels.push(measure(info)));
    fv.renderWebGL();
    // The FIRST level is applied synchronously: at this point the canvas already
    // shows a coarse image of the new view, and no FULL-resolution pass has run.
    const syncFullDelta = fv.fullImagePasses() - fullBefore;
    const syncGpuDelta = fv.gpuPasses() - gpuBefore;
    const syncLevels = levels.length;
    const tokenMid = fv.gpuJobToken();
    await fv.whenRenderSettled();
    fv.setGpuPassHook(null);
    // Captured HERE, before the baseline arm runs, so the counters describe the
    // shipped chain alone.
    const fullDelta = fv.fullImagePasses() - fullBefore;
    const gpuDelta = fv.gpuPasses() - gpuBefore;
    const orbitDelta = fv.orbitComputations() - orbitBefore;
    const afterToken = fv.gpuJobToken();
    const chain = fv.gpuChainLog().slice(-1)[0];
    // Read the canvas AFTER the settle — the same readback a pixel pin performs —
    // so "the final frame survives the await" is measured rather than assumed.
    const canvas = document.getElementById('fractalCanvasWebGL');
    const gl = canvas.getContext('webgl');
    const afterBuf = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, afterBuf);
    let afterHash = 0x811c9dc5;
    for (let i = 0; i < afterBuf.length; i++) { afterHash ^= afterBuf[i]; afterHash = Math.imul(afterHash, 0x01000193) >>> 0; }

    // The FAILING BASELINE: the pre-change schedule, same view, same code path.
    fv.setGpuSchedule([1]);
    const baseLevels = [];
    fv.setGpuPassHook((info) => baseLevels.push(measure(info)));
    const baseGpuBefore = fv.gpuPasses();
    const baseFullBefore = fv.fullImagePasses();
    fv.renderWebGL();
    const baseSyncGpu = fv.gpuPasses() - baseGpuBefore;
    const baseSyncFull = fv.fullImagePasses() - baseFullBefore;
    const baseTokenSync = fv.gpuJobToken(); // null: nothing left to refine or abandon
    await fv.whenRenderSettled();
    fv.setGpuPassHook(null);
    const baseChain = fv.gpuChainLog().slice(-1)[0];
    const baseBuf = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, baseBuf);
    let baseHash = 0x811c9dc5;
    for (let i = 0; i < baseBuf.length; i++) { baseHash ^= baseBuf[i]; baseHash = Math.imul(baseHash, 0x01000193) >>> 0; }
    fv.setGpuSchedule([8, 4, 2, 1]);

    return {
      W: canvas.width, H: canvas.height, cap: fv.maxIter(), lane: fv.usePerturbation(),
      levels, syncFullDelta, syncGpuDelta, syncLevels, tokenMid,
      afterToken, afterHash: afterHash >>> 0,
      chain: { schedule: chain.schedule, fullImageMs: chain.fullImageMs, totalMs: chain.totalMs },
      orbitDelta, fullDelta, gpuDelta,
      base: { levels: baseLevels, chain: { schedule: baseChain.schedule, fullImageMs: baseChain.fullImageMs },
        syncGpu: baseSyncGpu, syncFull: baseSyncFull, tokenSync: baseTokenSync, hash: baseHash >>> 0 },
    };
  }, { centre: PROBE_CENTRE, scale: DEEP_SCALE, measureSrc: MEASURE_LEVEL });

  console.log('[REFINE pin1] ' + out.W + 'x' + out.H + ' cap=' + out.cap + ' lane=' + out.lane
    + ' levels=' + out.levels.map((l) => `${l.step}:${l.ms.toFixed(1)}ms/${l.width}x${l.height}`).join(' ')
    + ' zeroRun=' + out.levels.map((l) => l.zeroRun.toFixed(3)).join('>')
    + ' uniform8=' + out.levels.map((l) => l.uniform8.toFixed(3)).join('>'));
  console.log('[REFINE pin1] total=' + out.chain.totalMs.toFixed(1) + 'ms fullImage=' + out.chain.fullImageMs.toFixed(1)
    + 'ms baseline=[1] fullImage=' + out.base.chain.fullImageMs.toFixed(1) + 'ms');

  // NON-VACUITY: a real deep lane, a canvas whose blocks divide evenly (so the
  // step-8 upscale is exactly 8x8 blocks), and a chain that really has levels.
  expect(out.lane, 'the deep perturbation lane must be the one drawn').toBe(true);
  expect(out.W % 8, 'the canvas width must divide by the coarsest step').toBe(0);
  expect(out.H % 8, 'the canvas height must divide by the coarsest step').toBe(0);
  expect(out.levels.length, 'the shipped schedule has several levels').toBeGreaterThan(1);

  // (2) MORE THAN ONE APPLIED FRAME. The coarsest level is already on screen when
  // `renderWebGL()` returns; the FULL-resolution counter is still 0 at that point,
  // which is what proves the first frame was a COARSE one and not the final image.
  expect(out.syncLevels, 'the first level is applied synchronously').toBe(1);
  expect(out.syncGpuDelta, 'and it counts as a pass').toBe(1);
  expect(out.syncFullDelta, 'but NOT as a full-resolution pass').toBe(0);
  expect(out.tokenMid, 'a chain is in flight after the first level').not.toBe(null);
  expect(out.fullDelta, 'exactly one full-resolution pass per render').toBe(1);
  expect(out.gpuDelta, 'more than one applied frame per render').toBeGreaterThan(1);
  expect(out.gpuDelta, 'every level of the chain was applied').toBe(out.levels.length);
  expect(out.afterToken, 'the chain is finished').toBe(null);
  expect(out.chain.schedule.length, 'the chain really ran the shipped schedule').toBe(out.levels.length);

  // (1) COARSER -> FINER: the levels are the shipped 8/4/2/1, the content is
  // different at each level, and the blockiness falls monotonically.
  expect(out.levels.map((l) => l.step)).toEqual(out.chain.schedule);
  expect(new Set(out.levels.map((l) => l.hash)).size, 'coarse and fine frames are visibly different')
    .toBe(out.levels.length);
  // ITER-CAP: `zeroRun`/`uniform8` are COLOUR-sameness metrics, and D1 defines the
  // palette parameter as t = v/cap, so a larger auto budget COMPRESSES the hue span of
  // the same escape values at a fixed view. Measured here: the 64x48 final frame's
  // uniform-8x8 fraction is 0.896 at cap 15360 (0.958 at cap 8192 at 1e-8), where the
  // pre-change cap 7680 spanned the palette further. "Less blocky as it refines" is
  // therefore asserted as a MONOTONE NON-INCREASING uniform-8 fraction with a STRICTLY
  // finer final frame — the structural statement — rather than an absolute
  // colour-variation threshold tied to the old cap. The strongest user-visible
  // statement (the final frame IS the single-pass image, byte for byte) is asserted
  // separately below and is unchanged.
  expect(out.levels[0].uniform8, 'the step-8 frame is 8x8 blocks all the way').toBe(1);
  for (let i = 1; i < out.levels.length; i++) {
    expect(out.levels[i].uniform8, `level ${out.levels[i].step} must not be more blocky than ${out.levels[i - 1].step}`)
      .toBeLessThanOrEqual(out.levels[i - 1].uniform8);
  }
  expect(out.levels[out.levels.length - 1].uniform8, 'the final frame must be strictly finer than the coarsest')
    .toBeLessThan(out.levels[0].uniform8);
  expect(out.levels[0].zeroRun, 'the coarse frame is dominated by equal neighbours').toBeGreaterThan(0.7);
  expect(out.levels[out.levels.length - 1].zeroRun, 'the final frame must not be more blocky than the coarsest')
    .toBeLessThanOrEqual(out.levels[0].zeroRun);

  // (1b) EACH LEVEL IS GENUINELY CHEAPER — structurally, by the number of fragments
  // it rasterises (1/step^2), and corroborated by the measured ms.
  for (let i = 1; i < out.levels.length; i++) {
    const a = out.levels[i - 1], b = out.levels[i];
    expect(a.width * a.height, `level ${a.step} must rasterise fewer fragments than level ${b.step}`)
      .toBeLessThan(b.width * b.height);
  }
  expect(out.levels[out.levels.length - 1].ms, 'the final pass is measurably the most expensive')
    .toBeGreaterThan(out.levels[0].ms);
  expect(out.chain.fullImageMs, 'the full-image time is the final level\'s time')
    .toBeCloseTo(out.levels[out.levels.length - 1].ms, 3);
  // The readback after the settle IS the final level's frame: the drawing buffer
  // survives the await (the settle resolves in a microtask of the final pass).
  expect(out.afterHash, 'the frame read after the await is the full-resolution frame')
    .toBe(out.levels[out.levels.length - 1].hash);

  // (1c) THE REFINEMENT REUSES THE ORBIT. Four draws of one view must not rebuild
  // the reference orbit: this is the "extra passes within one view are cheap"
  // property the slice relies on, counted rather than assumed.
  expect(out.orbitDelta, 'the refinement must not rebuild the reference orbit').toBeLessThanOrEqual(1);

  // (1d) THE FINAL FRAME IS THE PRE-REFINEMENT FRAME, byte for byte. The [1]
  // baseline is the old build's single full-resolution pass through the same code.
  expect(out.base.levels.length, 'the baseline has exactly one level').toBe(1);
  expect(out.base.syncGpu, 'the baseline is one atomic pass').toBe(1);
  expect(out.base.syncFull, 'which is a full-resolution pass').toBe(1);
  expect(out.base.tokenSync, 'and leaves nothing in flight: no remainder to abandon').toBe(null);
  expect(out.base.hash, 'the refined final frame IS the pre-refinement frame, byte for byte')
    .toBe(out.afterHash);

  expect(pageErrors).toEqual([]);
});

// --- pin 2: a view change during refinement -------------------------------------

test('REFINE pin 2: a wheel during refinement abandons the rest of the chain at once, where the single-pass baseline cannot', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);
  await quiesce(page);

  const out = await page.evaluate(async ({ centre, scale }) => {
    const fv = window.__fv;
    const canvas = document.getElementById('fractalCanvasWebGL');
    const originalSchedule = fv.gpuSchedule().slice();

    // ONE arm. `wheelDuringRefinement` dispatches a REAL wheel event on the WebGL
    // canvas from inside the pass hook — i.e. at exactly the moment the refinement
    // is between two levels, which is the user's "I zoomed mid-render" case.
    const run = async (schedule) => {
      fv.setGpuSchedule(schedule);
      fv.setDeepView({ ...centre, scale });
      await fv.whenRenderSettled();
      const before = fv.gpuChains();
      const scaleBefore = fv.getView().scale;
      let fired = 0;
      // The chain's OWN generation is taken from the hook payload: the wheel is
      // dispatched from inside the first level, so by the time `renderWebGL()`
      // returns the token already belongs to the chain the wheel started.
      let originalGen = null;
      let hadRemainder = false;
      fv.setGpuPassHook((info) => {
        if (info.levelIndex === 0 && fired === 0) {
          fired = 1;
          originalGen = info.generation;
          hadRemainder = info.schedule.length > 1;
          canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
        }
      });
      fv.renderWebGL();
      const tokenAfterWheel = fv.gpuJobToken();
      await fv.whenRenderSettled();
      fv.setGpuPassHook(null);
      const after = fv.gpuChains();
      const log = fv.gpuChainLog();
      const original = log.filter((c) => c.generation === originalGen).slice(-1)[0] || null;
      // The cost of a FULL pass for THIS view: the last COMPLETED chain's
      // full-resolution level. The superseded chain never reached one (that is the
      // point), so its own `fullImageMs` is 0 and cannot be the reference.
      const completed = log.filter((c) => c.completed && c.fullImageMs > 0);
      const finalChainFullMs = completed.length ? completed[completed.length - 1].fullImageMs : null;
      return {
        schedule, fired, originalGen, tokenAfterWheel, hadRemainder, scaleBefore, scaleAfter: fv.getView().scale,
        wheelMs: fv.wheelToFirstFrameMs(),
        finalChainFullMs,
        deltaAbandoned: after.abandoned - before.abandoned,
        deltaSkipped: after.passesSkipped - before.passesSkipped,
        originalApplied: original ? original.passesApplied : null,
        originalSkipped: original ? original.passesSkipped : null,
        originalAbandoned: original ? original.abandoned : null,
        originalCompleted: original ? original.completed : null,
        originalFullMs: original ? original.fullImageMs : null,
        originalLevels: original ? original.levels.length : null,
      };
    };

    const shipped = await run(originalSchedule);
    const baseline = await run([1]);
    fv.setGpuSchedule(originalSchedule);
    return { shipped, baseline, originalSchedule };
  }, { centre: PROBE_CENTRE, scale: DEEP_SCALE });

  console.log('[REFINE pin2] shipped  : applied=' + out.shipped.originalApplied
    + ' skipped=' + out.shipped.originalSkipped + ' abandoned=' + out.shipped.originalAbandoned
    + ' wheel->firstFrame=' + (out.shipped.wheelMs == null ? 'null' : out.shipped.wheelMs.toFixed(1)) + 'ms');
  console.log('[REFINE pin2] baseline : applied=' + out.baseline.originalApplied
    + ' skipped=' + out.baseline.originalSkipped + ' abandoned=' + out.baseline.originalAbandoned
    + ' wheel->firstFrame=' + (out.baseline.wheelMs == null ? 'null' : out.baseline.wheelMs.toFixed(1)) + 'ms');

  // NON-VACUITY: both arms really fired the wheel from INSIDE the refinement, and
  // the wheel really changed the view (so "the new view is on screen" is not a
  // statement about an unchanged one).
  for (const arm of [out.shipped, out.baseline]) {
    expect(arm.fired, 'the wheel must really have been dispatched during refinement').toBe(1);
    expect(arm.scaleAfter, 'the wheel really changed the view').not.toBe(arm.scaleBefore);
  }
  // The shipped arm has a chain in flight after its first level; the BASELINE does
  // NOT — its one full-resolution pass completed synchronously, which is exactly why
  // it cannot abandon anything (asserted as the failure below, not merely claimed).
  expect(out.shipped.tokenAfterWheel, 'the wheel left its own chain in flight').not.toBe(null);
  expect(out.shipped.originalGen, 'the superseded chain is identified').not.toBe(null);
  expect(out.baseline.tokenAfterWheel, 'the baseline completed its pass synchronously: nothing in flight').toBe(null);
  expect(out.shipped.hadRemainder, 'the shipped arm had levels left to abandon').toBe(true);

  // THE PIN: the superseded chain applied its first level and NOTHING else — the
  // remaining levels are skipped, counted, and never reach the GPU.
  expect(out.shipped.originalApplied, 'the superseded chain stops after its first level').toBe(1);
  expect(out.shipped.originalAbandoned, 'and is recorded as abandoned').toBe(true);
  expect(out.shipped.originalCompleted, 'it never reached its final level').toBe(false);
  expect(out.shipped.originalSkipped, 'the rest of the chain is skipped').toBe(out.originalSchedule.length - 1);
  expect(out.shipped.deltaSkipped, 'the skip is real GPU time not spent').toBeGreaterThanOrEqual(out.originalSchedule.length - 1);
  expect(out.shipped.deltaAbandoned, 'a supersede really happened').toBeGreaterThanOrEqual(1);
  // ...and the FIRST VISIBLE RESPONSE was a coarse level, not a full pass.
  expect(out.shipped.wheelMs, 'the wheel-to-first-frame latency is measured').not.toBe(null);
  expect(out.shipped.finalChainFullMs, 'a completed chain reports its full-image cost').not.toBe(null);
  expect(out.shipped.wheelMs, 'the response is a coarse level, far cheaper than the full pass')
    .toBeLessThan(out.shipped.finalChainFullMs);

  // THE FAILING BASELINE, measured in the same pin through the same code: with a
  // single full-resolution pass there is no level boundary, so NOTHING can be
  // abandoned, `passesSkippedOnAbandon` cannot move, and the wheel's first visible
  // response is a FULL pass.
  expect(out.baseline.hadRemainder, 'the baseline has no remainder to abandon').toBe(false);
  expect(out.baseline.originalApplied, 'the baseline applied its one pass').toBe(1);
  expect(out.baseline.originalAbandoned, 'and was never abandoned — it cannot be').toBe(false);
  expect(out.baseline.originalCompleted, 'because its one pass ran to completion before anything could stop it').toBe(true);
  expect(out.baseline.originalSkipped, 'and nothing was skipped').toBe(0);
  expect(out.baseline.deltaSkipped, 'the baseline saves no GPU time on a supersede').toBe(0);
  expect(out.baseline.wheelMs, 'the baseline wheel-to-first-frame is measured too').not.toBe(null);
  // The contrast IS the claim: the shipped first response is a coarse level, the
  // baseline's is the full image.
  expect(out.shipped.wheelMs * 2, 'the shipped first response must be at least 2x faster than the baseline\'s')
    .toBeLessThan(out.baseline.wheelMs);

  expect(pageErrors).toEqual([]);
});

// --- pin 3: shallow depth — the refinement is invisible, as expected -------------

test('REFINE pin 3: at shallow depths the refinement is invisible — the final frame equals the single-pass build\'s, while the coarse level does not', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);
  await quiesce(page);

  const out = await page.evaluate(async (centre) => {
    const fv = window.__fv;
    const canvas = document.getElementById('fractalCanvasWebGL');
    const gl = canvas.getContext('webgl');
    const W = canvas.width, H = canvas.height;
    const hashNow = () => {
      const b = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b);
      let h = 0x811c9dc5;
      for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      return h >>> 0;
    };
    const rows = [];
    for (const scale of [3, 1e-4, 1e-8, 1.05e-4]) {
      // Arm 1: the shipped refinement chain. The FIRST level's pixels are captured
      // from inside the chain (before the final level), the final ones after.
      fv.setGpuSchedule([8, 4, 2, 1]);
      fv.setDeepView({ ...centre, scale });
      await fv.whenRenderSettled();
      let coarseHash = null;
      fv.setGpuPassHook((info) => { if (info.levelIndex === 0) coarseHash = hashNow(); });
      fv.renderWebGL();
      await fv.whenRenderSettled();
      fv.setGpuPassHook(null);
      const refinedHash = hashNow();
      // Arm 2: the PRE-CHANGE build — one full-resolution pass.
      fv.setGpuSchedule([1]);
      fv.setDeepView({ ...centre, scale });
      await fv.whenRenderSettled();
      fv.renderWebGL();
      await fv.whenRenderSettled();
      const plainHash = hashNow();
      rows.push({ scale: fv.getView().scale, coarseHash, refinedHash, plainHash, cap: fv.maxIter() });
    }
    fv.setGpuSchedule([8, 4, 2, 1]);
    return { W, H, rows };
  }, PROBE_CENTRE);

  for (const r of out.rows) {
    console.log(`[REFINE pin3] scale=${r.scale} cap=${r.cap} coarse=${r.coarseHash} refined=${r.refinedHash} singlePass=${r.plainHash}`);
  }
  expect(out.rows.length).toBe(4);
  for (const r of out.rows) {
    // NON-VACUITY: a real frame, and a coarse level that is genuinely a DIFFERENT
    // (coarser) image — otherwise "the final frames agree" would be vacuous.
    expect(r.coarseHash, `${r.scale}: the coarse level must be a real frame`).not.toBe(null);
    expect(r.coarseHash, `${r.scale}: the coarse level really differs from the final frame`)
      .not.toBe(r.refinedHash);
    // THE PIN (the owner's "it just wont be noticable at lower depths", stated
    // precisely): at these depths the refinement changes NOTHING about the final
    // image — it is byte-for-byte the single-pass build's frame.
    expect(r.refinedHash, `${r.scale}: the refined final frame must equal the single-pass frame`)
      .toBe(r.plainHash);
  }

  expect(pageErrors).toEqual([]);
});

// --- pin 4: the cost curve ------------------------------------------------------

test('REFINE pin 4: the cost curve — ms to the first useful frame and ms to the final frame at several depths', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);
  await quiesce(page);

  const curve = await page.evaluate(async (centre) => {
    const fv = window.__fv;
    fv.setGpuSchedule([8, 4, 2, 1]);
    const rows = [];
    // Shallow first, deepest last: `setDeepView` starts no CPU job, so the
    // iteration budget is the view's own for every row.
    for (const scale of [3, 1e-4, 1e-8, 1e-15, 1e-30, 1e-40]) {
      fv.setDeepView({ ...centre, scale });
      const t0 = performance.now();
      fv.renderWebGL();
      // The first level is applied synchronously by `renderWebGL`, so this is the
      // ms the user waits for SOMETHING of the new view.
      const firstFrameMs = performance.now() - t0;
      await fv.whenRenderSettled();
      const totalMs = performance.now() - t0;
      const chain = fv.gpuChainLog().slice(-1)[0];
      rows.push({
        scale: fv.getView().scale, cap: fv.maxIter(), lane: fv.usePerturbation(),
        firstFrameMs, totalMs, fullImageMs: chain.fullImageMs,
        levels: chain.levels.map((l) => ({ step: l.step, ms: l.ms, w: l.width, h: l.height })),
      });
    }
    return rows;
  }, PROBE_CENTRE);

  console.log('[REFINE pin4] ms to first frame / ms to final (full image) / whole chain, 64x48, SwiftShader:');
  for (const r of curve) {
    console.log(`[REFINE pin4]   scale=${r.scale.toExponential(0)} cap=${r.cap} lane=${r.lane ? 'deep' : 'plain'} `
      + `first=${r.firstFrameMs.toFixed(2)}ms final=${r.fullImageMs.toFixed(1)}ms chain=${r.totalMs.toFixed(1)}ms `
      + `levels=[${r.levels.map((l) => `${l.step}:${l.ms.toFixed(1)}`).join(',')}]`);
  }

  expect(curve.length).toBe(6);
  for (const r of curve) {
    // Every row is a real chain: several levels, and the first useful frame is
    // cheaper than the final one — that IS the trade the owner asked for. At
    // SHALLOW depths the two are the same order of magnitude (owner: "it just wont
    // be noticable at lower depths"), so the strict factor is required only where a
    // depth actually makes a full pass expensive.
    expect(r.levels.length, `${r.scale}: the chain must have several levels`).toBeGreaterThan(1);
    if (r.scale <= 1e-8) {
      expect(r.firstFrameMs * 3, `${r.scale}: the first frame must be far cheaper than the full pass`)
        .toBeLessThan(r.fullImageMs);
    } else {
      expect(r.firstFrameMs, `${r.scale}: the first frame must never cost more than the full pass`)
        .toBeLessThanOrEqual(r.fullImageMs);
    }
    expect(r.fullImageMs, `${r.scale}: the full image must be the last level's cost`)
      .toBeCloseTo(r.levels[r.levels.length - 1].ms, 3);
    // The first visible frame is the step-8 level, not some full pass in disguise.
    expect(r.levels[0].step, `${r.scale}: the first level must be the coarsest`).toBe(8);
  }
  // The curve is monotone in depth (a deeper view costs more), which is the shape
  // the reported numbers have to have to be believable.
  const deep = curve[curve.length - 1], shallow = curve[0];
  expect(deep.fullImageMs, 'a deep full image must cost more than a shallow one')
    .toBeGreaterThan(shallow.fullImageMs);

  expect(pageErrors).toEqual([]);
});
