// @ts-check
// ANIMATION CHAIN STORM — the owner's report, verbatim:
//
//   "Sometimes when i land on a spot there is bouncing, rendering the same spot
//    again from scratch."
//
// THE DEFECT, MEASURED. The startup animation drives `viewer.setView` once per
// ~16 ms frame (`public/app.js` animateZoom). That path reaches the GPU through the
// re-pointed `viewer.render` -> `renderFractal` -> `renderWebGL`, and the
// REFINE slice (2026-09-22) made `renderWebGL` start a coarse-to-fine CHAIN. A
// chain per frame is a storm by construction: its coarsest level is drawn
// synchronously, the level boundary yields a macrotask, and the next animation
// frame arrives before the chain can converge. The dispatcher measured it in a
// real browser as 263 GPU passes across 110 view generations with 109 abandoned.
//
// THE FIX (the mechanism this pin holds). The app already keeps the state that
// says "the animation is still driving the view": `zoomAnimationSettled`
// (`app.js` completion branch, exposed as `__fv.animationSettled()`). While that
// state is false a view change costs exactly ONE full-resolution pass — the
// pre-refinement single-pass behaviour — and starts NO chain. The chain runs once
// when the view SETTLES, in the animation's own completion branch.
//
// WHAT IS PINNED, each with its failing baseline measured in the SAME pin through
// the SAME code path (`__fv.setScale` -> the real render path):
//
//  1. An animation-like sequence of view changes starts ZERO refinement chains,
//     applies exactly ONE pass per frame, and leaves nothing in flight. THE
//     FAILING BASELINE is the same sequence with the settled state set — which is
//     precisely what the pre-fix build did unconditionally: one chain per view
//     change, most of them superseded.
//  2. The chain DOES run exactly once when the view settles, and it is the real
//     shipped coarse-to-fine schedule that ends at full resolution.
//  3. The real STARTUP animation itself owes exactly one chain — not one per
//     frame. This is the dispatcher's own reproduction, measured on the real
//     animation rather than on a script.
//
// `window.__fv.setAnimationSettled` is TEST-ONLY and is guarded for in the script:
// against the PRE-FIX build it is absent, the sequence runs with the app settled,
// and assertion 1 fails for the RIGHT reason (chains per frame), not on a missing
// hook.
const { test, expect } = require('@playwright/test');

// The startup animation's own range: the default view (~183) down to `target` 3.
const ANIM_START = 183;
const ANIM_TARGET = 3;
const FRAMES = 24;
const FRAME_MS = 16;

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__fv.shaderSource()), { timeout: 10_000 })
    .not.toBe(null);
}

// Both lanes idle across a macrotask: the CPU lane runs a background job from
// startup and its final frame re-renders through the GPU path.
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

// --- pin 1: an animation-like sequence starts no chain; the fitted one does -----

test('ANIM-REFINE pin 1: an animation-like view sequence costs ONE pass per frame and starts NO chain, where the pre-fix baseline starts a chain per frame', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitSettled(page);
  await quiesce(page);

  const out = await page.evaluate(async ({ start, target, frames, frameMs }) => {
    const fv = window.__fv;

    // ONE scripted animation-like sequence: `frames` view changes spaced as the
    // real animation spaces them, every one through the REAL render path.
    const runSequence = async (settled, label) => {
      // Put the app into the state under test through the app's own observable.
      // Against the pre-fix build the setter does not exist and this is a no-op —
      // the app is settled, i.e. the old unconditional chain-per-change behaviour.
      if (typeof fv.setAnimationSettled === 'function') fv.setAnimationSettled(settled);
      const c0 = fv.gpuChains();
      const p0 = fv.gpuPasses();
      const f0 = fv.fullImagePasses();
      const scale0 = fv.getView().scale;
      for (let i = 0; i < frames; i++) {
        fv.setScale(start - (start - target) * ((i + 1) / frames));
        await new Promise((r) => setTimeout(r, frameMs));
      }
      const c1 = fv.gpuChains();
      return {
        label,
        started: c1.started - c0.started,
        completed: c1.completed - c0.completed,
        abandoned: c1.abandoned - c0.abandoned,
        passesSkipped: c1.passesSkipped - c0.passesSkipped,
        gpuPasses: fv.gpuPasses() - p0,
        fullPasses: fv.fullImagePasses() - f0,
        token: fv.gpuJobToken(),
        scale0, scaleEnd: fv.getView().scale,
      };
    };

    // Reset to the animation's start through the real view path, and let it settle.
    fv.setDeepView({ scale: start });
    await fv.whenRenderSettled();

    // ARM 1 — THE FIX: the animation is DRIVING the view.
    const anim = await runSequence(false, 'animation-driven');

    // Assertion 2's evidence: when the view SETTLES the chain must run once.
    if (typeof fv.setAnimationSettled === 'function') fv.setAnimationSettled(true);
    const settleStarted0 = fv.gpuChains().started;
    const settleFull0 = fv.fullImagePasses();
    let syncLevels = 0;
    fv.setGpuPassHook(() => { syncLevels++; });
    fv.renderWebGL();
    const settleSyncLevels = syncLevels;
    await fv.whenRenderSettled();
    fv.setGpuPassHook(null);
    const settleChain = fv.gpuChainLog().slice(-1)[0];
    const settled = {
      chainsStarted: fv.gpuChains().started - settleStarted0,
      fullPasses: fv.fullImagePasses() - settleFull0,
      settleSyncLevels,
      chain: {
        schedule: settleChain.schedule,
        completed: settleChain.completed,
        abandoned: settleChain.abandoned,
        levels: settleChain.levels.map((l) => l.step),
      },
    };

    // ARM 2 — THE FAILING BASELINE: the same sequence with the view SETTLED, i.e.
    // exactly what the pre-fix build did on every animation frame.
    fv.setScale(start);
    await fv.whenRenderSettled();
    const storm = await runSequence(true, 'settled-baseline');
    await fv.whenRenderSettled();
    // Leave the app as the settled build: every later view change chains normally.
    if (typeof fv.setAnimationSettled === 'function') fv.setAnimationSettled(true);

    return { anim, settled, storm, frames };
  }, { start: ANIM_START, target: ANIM_TARGET, frames: FRAMES, frameMs: FRAME_MS });

  console.log('[ANIM-REFINE pin1] animation-driven: chainsStarted=' + out.anim.started
    + ' abandoned=' + out.anim.abandoned + ' passesSkipped=' + out.anim.passesSkipped
    + ' gpuPasses=' + out.anim.gpuPasses + ' fullPasses=' + out.anim.fullPasses
    + ' token=' + out.anim.token);
  console.log('[ANIM-REFINE pin1] settled baseline: chainsStarted=' + out.storm.started
    + ' abandoned=' + out.storm.abandoned + ' passesSkipped=' + out.storm.passesSkipped
    + ' gpuPasses=' + out.storm.gpuPasses + ' fullPasses=' + out.storm.fullPasses
    + ' completed=' + out.storm.completed);
  console.log('[ANIM-REFINE pin1] settled view: chainsStarted=' + out.settled.chainsStarted
    + ' fullPasses=' + out.settled.fullPasses + ' syncLevels=' + out.settled.settleSyncLevels
    + ' chain=[' + out.settled.chain.levels.join(',') + '] completed=' + out.settled.chain.completed);

  // NON-VACUITY: both sequence arms really drove the view across the animation's
  // range (so "no chain" is not a statement about an unchanged view).
  for (const arm of [out.anim, out.storm]) {
    expect(Math.abs(arm.scale0 - ANIM_START), `${arm.label}: the sequence starts at the animation's start`).toBeLessThan(1e-9);
    expect(arm.scaleEnd, `${arm.label}: the sequence ends at the animation's target`).toBeCloseTo(ANIM_TARGET, 6);
  }

  // (1) THE PIN: no chain per frame while the animation drives the view.
  expect(out.anim.started, 'an animation-driven view change must NOT start a refinement chain').toBe(0);
  expect(out.anim.completed, 'and none can complete, because none exists').toBe(0);
  expect(out.anim.abandoned, 'and none is abandoned').toBe(0);
  expect(out.anim.passesSkipped, 'and no GPU time is skipped').toBe(0);
  expect(out.anim.token, 'the animation leaves nothing in flight').toBe(null);
  // Each frame cost exactly ONE full-resolution pass — the pre-refinement
  // single-pass frame — and no chain level exists to draw a coarse frame.
  expect(out.anim.gpuPasses, 'exactly one GPU pass per animation frame').toBe(out.frames);
  expect(out.anim.fullPasses, 'and it is the FULL-resolution pass, not a coarse level').toBe(out.frames);

  // (1b) THE FAILING BASELINE, measured through the same path: the pre-fix build
  // started one chain per view change, and the storm is visible in the counters.
  expect(out.storm.started, 'the pre-fix baseline starts one chain PER animation frame').toBe(out.frames);
  expect(out.storm.abandoned, 'the storm abandons chains rather than converging').toBeGreaterThanOrEqual(1);
  expect(out.storm.passesSkipped, 'and the abandoned remainder is real GPU time not spent').toBeGreaterThanOrEqual(1);
  expect(out.storm.gpuPasses, 'the storm applies more than one pass per frame').toBeGreaterThan(out.frames);
  // The contrast IS the defect: the fix's chain count is 0, the baseline's is one
  // per frame with supersession.
  expect(out.anim.started * out.frames, 'the baseline starts an order of magnitude more chains').toBeLessThan(out.storm.started);

  // (2) THE CHAIN RUNS ONCE WHEN THE VIEW SETTLES, and it is the shipped schedule
  // ending at full resolution.
  expect(out.settled.chainsStarted, 'the settled view runs exactly one chain').toBe(1);
  expect(out.settled.chain.schedule, 'the shipped coarse-to-fine schedule').toEqual([8, 4, 2, 1]);
  expect(out.settled.chain.completed, 'and it completes').toBe(true);
  expect(out.settled.chain.abandoned, 'nothing supersedes it').toBe(false);
  expect(out.settled.chain.levels, 'the settled chain ends at full resolution').toEqual([8, 4, 2, 1]);
  expect(out.settled.settleSyncLevels, 'its first level is applied synchronously').toBe(1);
  expect(out.settled.fullPasses, 'exactly one full-resolution frame per settled view').toBe(1);

  expect(pageErrors).toEqual([]);
});

// --- pin 2: the REAL startup animation owes exactly one chain -------------------

test('ANIM-REFINE pin 2: the real startup animation starts exactly ONE chain (the settled one), not one per frame', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  // Sample the chain counters from inside the page for the WHOLE animation. The
  // sampler is installed as soon as `__fv` exists (module scripts run before
  // DOMContentLoaded) and keeps the LAST value it saw before the animation settled.
  await page.waitForFunction(() => !!(window.__fv && window.__fv.gpuChains), null, { timeout: 15_000 });
  await page.evaluate(() => {
    window.__animSample = { started: 0, abandoned: 0, gpuPasses: 0, samples: 0, installedAt: performance.now(), settledObserved: false };
    const tick = () => {
      const c = window.__fv.gpuChains();
      window.__animSample.started = c.started;
      window.__animSample.abandoned = c.abandoned;
      window.__animSample.gpuPasses = window.__fv.gpuPasses();
      window.__animSample.samples++;
      if (window.__fv.animationSettled()) { window.__animSample.settledObserved = true; return; }
      setTimeout(tick, 0);
    };
    tick();
  });
  await waitSettled(page);
  await expect.poll(() => page.evaluate(() => window.__animSample.settledObserved), { timeout: 30_000 }).toBe(true);
  const sample = await page.evaluate(() => ({ ...window.__animSample, scale: window.__fv.getView().scale }));

  console.log('[ANIM-REFINE pin2] real startup animation: chainsStarted=' + sample.started
    + ' abandoned=' + sample.abandoned + ' gpuPasses=' + sample.gpuPasses
    + ' samples=' + sample.samples + ' settledScale=' + sample.scale);

  // NON-VACUITY: the sampler really ran DURING the animation (many samples) and the
  // animation really ran (it settled after moving the view off its start).
  expect(sample.samples, 'the sampler must observe the animation, not race it').toBeGreaterThan(3);
  expect(sample.settledObserved, 'the sampler must observe the settled state it stops on').toBe(true);
  expect(sample.scale, 'the animation must have reached its target').toBe(3);

  // THE PIN: the whole animation owes exactly ONE chain — the one started for the
  // SETTLED view. The pre-fix build starts ~one per frame (~100 over this
  // animation), which is the storm the owner saw as "bouncing".
  expect(sample.started, 'the animation must start exactly one chain, for the settled view').toBe(1);

  expect(pageErrors).toEqual([]);
});
