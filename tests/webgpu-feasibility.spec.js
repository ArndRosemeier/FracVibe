// @ts-check
// WEBGPU-GROUNDWORK — a FEASIBILITY experiment, not a backend.
//
// docs/STATE.md NORTH-STAR makes the renderer a CAPABILITY LADDER and names WebGPU
// (compute) as a candidate tier ABOVE WebGL. This spec answers the three questions
// the ladder needs answered before a later slice may wire WebGPU into the live
// dispatch, and it answers them with MEASUREMENTS on whatever machine runs it:
//
//   1. `public/capabilities.js` reports the three-state WebGPU status correctly, and
//      `selectTier` NEVER chooses the WebGPU tier from `navigator.gpu` presence —
//      only from an AWAITED `adapter-available`. That trap is measured, not
//      hypothetical (docs/STATE.md `MEASURED ... WebGPU availability`: on this host
//      `navigator.gpu` is PRESENT and `requestAdapter()` returns null).
//   2. A compute pass CAN carry an orbit in a storage buffer with MORE THAN 8192
//      entries (the WebGL orbit is a texture, capped at MAX_TEXTURE_SIZE = 8192 by
//      public/webglFractal.js:116), READ every index past 8192, and produce a real
//      escape-time FRAME that reads back as pixels.
//   3. ms/frame for the WebGPU compute path vs the shipped WebGL path on the SAME
//      view — both reported as SOFTWARE-adapter numbers (this host's WebGL and its
//      WebGPU adapter are both SwiftShader; docs/DECISIONS.md row 47), with no claim
//      about real hardware and no claim that WebGPU is faster.
//
// HOW TO RUN IT SO AN ADAPTER EXISTS. `navigator.gpu` present + no adapter is the
// DEFAULT state of this host's Chrome. The flag run uses a DEDICATED config under
// /tmp (never this repo's playwright.config.js, which is not ours to change):
//
//     npx playwright test --config /tmp/fv-webgpu.config.js
//
// with `--enable-unsafe-webgpu --enable-features=Vulkan,WebGPU`, which grants the
// `google / swiftshader` adapter. Under the NORMAL project config no adapter is
// granted, so tests 2 and 3 SKIP with this reason recorded — they never fail.
const { test, expect } = require('@playwright/test');

function isAdapterAvailable(report) {
  return !!(report && report.webgpu && report.webgpu.status === 'adapter-available');
}

function skipReason(report) {
  const gpu = (report && report.webgpu) || {};
  return 'WebGPU compute could not be exercised on this host: status='
    + (gpu.status || 'unknown')
    + (gpu.reason ? ' — ' + gpu.reason : '')
    + ' (launch Chrome with --enable-unsafe-webgpu --enable-features=Vulkan,WebGPU, '
    + 'e.g. npx playwright test --config /tmp/fv-webgpu.config.js)';
}

async function gotoAndLoadProbes(page) {
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: '/capabilities.js' });
  await page.addScriptTag({ url: '/webgpuProbe.js' });
}

// ---------------------------------------------------------------------------
// 1 · capability-detection SEMANTICS (runs everywhere, adapter or not)
// ---------------------------------------------------------------------------
test('capability detector: navigator.gpu presence is NOT adapter availability', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await gotoAndLoadProbes(page);

  const out = await page.evaluate(async () => {
    const C = globalThis.FractalCapabilities;
    const report = await C.detect();
    // selectTier is driven with SYNTHETIC reports whose ONLY difference is the
    // awaited adapter verdict, so the trap is tested independently of this host.
    const stub = (status) => ({
      webgl2: true, webgl1: true, oesTextureFloat: true,
      webgpu: { status },
    });
    return {
      report,
      // the raw fact this spec exists to keep separate from the verdict
      navigatorGpuPresent: typeof navigator.gpu !== 'undefined',
      tiers: {
        fromAbsent: C.selectTier(stub(C.WEBGPU_STATUS.ABSENT)),
        fromNoAdapter: C.selectTier(stub(C.WEBGPU_STATUS.API_PRESENT_NO_ADAPTER)),
        fromAdapter: C.selectTier(stub(C.WEBGPU_STATUS.ADAPTER_AVAILABLE)),
        fromNothing: C.selectTier(null),
      },
      // a machine with NO WebGL and no adapter must land on the CPU rung
      cpuTier: C.selectTier({ webgl2: false, webgl1: false, oesTextureFloat: false, webgpu: { status: C.WEBGPU_STATUS.ADAPTER_AVAILABLE } }),
    };
  });

  // The capability report from THIS machine, verbatim, so the numbers are on the
  // record rather than paraphrased.
  console.log('[capabilities] ' + JSON.stringify(out.report));
  console.log('[capabilities] navigatorGpuPresent=' + out.navigatorGpuPresent
    + ' status=' + out.report.webgpu.status
    + ' tiers=' + JSON.stringify(out.tiers)
    + ' cpuTierWithAdapter=' + out.cpuTier);

  // The three-state vocabulary: never a boolean.
  expect(['absent', 'api-present-no-adapter', 'adapter-available']).toContain(out.report.webgpu.status);
  // `present` and the verdict are DIFFERENT facts and must be reported separately.
  expect(out.report.hasNavigatorGpu).toBe(out.navigatorGpuPresent);
  expect(out.report.webgpu.present).toBe(out.navigatorGpuPresent);
  expect(out.report.webgpu.status).toBe(
    out.navigatorGpuPresent
      ? (isAdapterAvailable(out.report) ? 'adapter-available' : 'api-present-no-adapter')
      : 'absent',
  );
  // An adapter, when granted, must name itself (the ladder's dispatch wants it).
  if (isAdapterAvailable(out.report)) {
    expect(out.report.webgpu.adapterInfo).not.toBeNull();
    expect(['maxStorageBufferBindingSize', 'maxBufferSize'].some(
      (k) => typeof out.report.webgpu.limits[k] === 'number',
    )).toBe(true);
  }

  // THE TRAP, pinned: presence does NOT select the WebGPU tier; an awaited adapter
  // does. `api-present-no-adapter` must fall through to the WebGL rung, NOT WebGPU.
  expect(out.tiers.fromAbsent).not.toBe('webgpu');
  expect(out.tiers.fromNoAdapter).not.toBe('webgpu');
  expect(out.tiers.fromNoAdapter).toBe('webgl-perturbation');
  expect(out.tiers.fromAdapter).toBe('webgpu');
  expect(out.tiers.fromNothing).toBe('cpu');

  // The rest of the ladder's rungs are REPORTED, and the values are the right type
  // (a feature test that throws or returns a string would be a defect here).
  expect(typeof out.report.secureContext).toBe('boolean');
  expect(typeof out.report.webgl1).toBe('boolean');
  expect(typeof out.report.webgl2).toBe('boolean');
  expect(typeof out.report.oesTextureFloat).toBe('boolean');
  expect(typeof out.report.wasmSimd === 'boolean' || out.report.wasmSimd === null).toBe(true);
  expect(typeof out.report.sharedArrayBuffer).toBe('boolean');
  expect(Number.isInteger(out.report.maxTextureSize)).toBe(true);
  expect(out.report.maxTextureSize).toBeGreaterThan(0);
  if (out.report.hardwareConcurrency !== null) {
    expect(out.report.hardwareConcurrency).toBeGreaterThan(0);
  }
  // A WebGL-capable host must have reported the texture ceiling this whole slice is
  // about; a host with NO WebGL reports 0 and the ladder falls to CPU.
  if (out.report.webgl1 || out.report.webgl2) {
    expect(out.report.maxTextureSize).toBeGreaterThanOrEqual(4096);
  }
  expect(pageErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// 2 · the compute experiment: storage-buffer orbit > 8192, real pixels
// ---------------------------------------------------------------------------
test('WebGPU compute: a storage-buffer orbit past 8192 and a real escape-time frame', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await gotoAndLoadProbes(page);

  const outcome = await page.evaluate(async () => {
    const C = globalThis.FractalCapabilities;
    const report = await C.detect();
    if (!(report.webgpu && report.webgpu.status === C.WEBGPU_STATUS.ADAPTER_AVAILABLE)) {
      return { ran: false, report };
    }
    const probe = globalThis.FractalWebGPUProbe;
    // TWO perturbed configurations, because they answer two different questions:
    //
    //  * `frame` — a boundary centre at depth, the escape-time frame. It measures
    //    the frame against a float64 perturbation reference.
    //  * `longOrbit` — a centre INSIDE the set (the main cardioid), where the
    //    reference orbit never escapes, so the perturbed loop's reference index `m`
    //    runs all the way to `maxIter`. That is the only way the PERTURBED pass
    //    itself addresses orbit entries past 8192: rebasing resets `m`, and when the
    //    reference orbit escapes (the `frame` case) `m` is bounded by that escape
    //    index, so the perturbed pass there reads only ~3000 entries however deep
    //    the view is. Both facts are reported, neither is asserted from the other.
    const frame = await probe.runProbe({
      width: 96,
      height: 96,
      maxIter: 20000,          // past the app's 8192 cap — the orbit MUST be longer
      orbitWidth: 20001,       // > 8192 texture cap; ceiling pass scans all of it
      scale: 1e-12,
      runCeiling: true,
      keepArrays: false,
    });
    if (!frame.ok) {
      return {
        ran: true,
        report,
        failed: true,
        reason: frame.reason,
        messages: frame.messages,
        validationErrors: frame.validationErrors,
      };
    }
    const longOrbit = await probe.runProbe({
      width: 32,
      height: 32,
      centerX: -0.5,           // a point INSIDE the main cardioid: never escapes
      centerY: 0,
      scale: 1e-3,
      maxIter: 20000,
      orbitWidth: 20001,
      runCeiling: false,
      keepArrays: false,
    });
    return {
      ran: true,
      report,
      failed: false,
      summary: {
        adapterInfo: frame.adapterInfo,
        adapterIsFallback: frame.adapterIsFallback,
        deviceLimits: frame.deviceLimits,
        adapterLimits: frame.adapterLimits,
        storageOrbitCapacity: frame.storageOrbitCapacity,
        webglTextureCap: frame.webglTextureCap,
        orbitWidth: frame.orbitWidth,
        orbitBytes: frame.orbitWidth * probe.ORBIT_SAMPLE_BYTES,
        maxIter: frame.maxIter,
        perturbMs: frame.perturbMs,
        ceilingMs: frame.ceilingMs,
        orbitUploadMs: frame.orbitUploadMs,
        ceiling: frame.ceiling,
        escapeStats: frame.escapeStats,
        canvasReadback: frame.canvasReadback,
        escapeVsReference: frame.escapeVsReference,
        messages: frame.messages,
        validationErrors: frame.validationErrors,
        longOrbit: longOrbit.ok ? {
          ok: true,
          maxOrbitIndexRead: longOrbit.escapeStats.maxOrbitIndexRead,
          inside: longOrbit.escapeStats.inside,
          pixels: longOrbit.escapeStats.pixels,
          maxEscape: longOrbit.escapeStats.maxEscape,
        } : { ok: false, reason: longOrbit.reason },
      },
    };
  });

  test.skip(!outcome.ran, skipReason(outcome.report));
  if (outcome.failed) {
    throw new Error('probe failed: ' + outcome.reason
      + ' | messages=' + JSON.stringify(outcome.messages)
      + ' | validation=' + JSON.stringify(outcome.validationErrors));
  }
  const s = outcome.summary;
  console.log('[webgpu] adapter=' + JSON.stringify(s.adapterInfo)
    + ' fallback=' + s.adapterIsFallback
    + ' maxStorageBufferBindingSize=' + s.deviceLimits.maxStorageBufferBindingSize
    + ' maxBufferSize=' + s.deviceLimits.maxBufferSize
    + ' orbitSamplesAllowed=' + s.storageOrbitCapacity
    + ' | webgl MAX_TEXTURE_SIZE cap=' + s.webglTextureCap);
  console.log('[webgpu] orbit entries=' + s.orbitWidth + ' (' + s.orbitBytes + ' B)'
    + ' ceiling entries=' + s.ceiling.entries + ' mismatch=' + s.ceiling.mismatch
    + ' lastIndexRead=' + s.ceiling.lastIndexRead
    + ' sampleAt8192=' + JSON.stringify(s.ceiling.sampleAt8192)
    + ' sampleAtLast=' + JSON.stringify(s.ceiling.sampleAtLast)
    + ' realOrbitNonFiniteWords=' + s.ceiling.realOrbitNonFiniteWords);
  console.log('[webgpu] frame escapeStats=' + JSON.stringify(s.escapeStats));
  console.log('[webgpu] canvas readback=' + JSON.stringify(s.canvasReadback));
  console.log('[webgpu] escapeVsReference=' + JSON.stringify(s.escapeVsReference));
  console.log('[webgpu] longOrbit(inside-set centre)=' + JSON.stringify(s.longOrbit));
  console.log('[webgpu] shader messages=' + JSON.stringify(s.messages)
    + ' validationErrors=' + JSON.stringify(s.validationErrors));

  // (a) THE STORAGE-BUFFER CEILING. The device limit is READ, the orbit is LONGER
  // than the WebGL texture cap, and the compute pass READ AND RETURNED every entry
  // including the last one — byte-for-byte, not sampled.
  expect(s.deviceLimits.maxStorageBufferBindingSize).toBeGreaterThan(s.webglTextureCap * 8);
  expect(s.orbitWidth).toBeGreaterThan(s.webglTextureCap);
  expect(s.ceiling.entries).toBe(s.orbitWidth);
  expect(s.ceiling.aboveTextureCap).toBe(true);
  expect(s.ceiling.lastIndexRead).toBeGreaterThan(s.webglTextureCap);
  expect(s.ceiling.mismatch).toBe(0);
  expect(s.ceiling.firstMismatch).toBe(-1);
  // The value AT index 8192 (the first index a WebGL texture cannot hold) is named,
  // so the proof is a value and not merely a count. Same at the last index.
  expect(s.ceiling.sampleAt8192).toEqual(s.ceiling.expectedAt8192);
  expect(s.ceiling.sampleAtLast).toEqual(s.ceiling.expectedAtLast);
  // ...and the PERTURBED pass itself addresses entries past 8192 (see the
  // `longOrbit` note above: this needs a reference orbit that does not escape).
  expect(s.longOrbit.ok).toBe(true);
  expect(s.longOrbit.pixels).toBe(1024);
  expect(s.longOrbit.inside).toBe(1024);
  expect(s.longOrbit.maxOrbitIndexRead).toBeGreaterThan(s.webglTextureCap);

  // (b) A REAL ESCAPE-TIME FRAME. Not degenerate: many distinct escape values and
  // escaped pixels, and — the non-vacuity clause — the float64 perturbation
  // reference computed from the SAME recurrence agrees with the GPU.
  expect(s.escapeStats.escaped).toBeGreaterThan(1000);
  expect(s.escapeStats.distinctEscapeValues).toBeGreaterThan(100);
  expect(s.escapeVsReference.misclassifiedFrac).toBeLessThan(0.005);
  expect(s.escapeVsReference.meanAbsIndexDelta).toBeLessThan(20);

  // (c) PIXELS WERE READ BACK. The statistics come from `getImageData` after
  // `putImageData`, i.e. from the bytes the canvas actually holds, not from the
  // storage buffer.
  expect(s.canvasReadback.distinctColors).toBeGreaterThan(50);
  expect(s.canvasReadback.nonBlackPixels).toBeGreaterThan(1000);
  expect(s.canvasReadback.nonBlackFrac).toBeGreaterThan(0.1);
  expect(s.canvasReadback.checksum).toBeGreaterThan(0);

  // A shader that did not compile would leave validation/compile messages; a clean
  // run has none. (Warnings would be visible here rather than silently ignored.)
  expect(s.validationErrors).toEqual([]);
  expect(s.messages).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// 3 · the measurement: ms/frame, WebGPU compute vs the shipped WebGL lane
// ---------------------------------------------------------------------------
test('measurement: ms/frame WebGPU compute vs WebGL on the SAME view (software adapters)', async ({ page }) => {
  test.setTimeout(300_000);
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await gotoAndLoadProbes(page);

  const outcome = await page.evaluate(async () => {
    const C = globalThis.FractalCapabilities;
    const report = await C.detect();
    if (!(report.webgpu && report.webgpu.status === C.WEBGPU_STATUS.ADAPTER_AVAILABLE)) {
      return { ran: false, report };
    }
    const probe = globalThis.FractalWebGPUProbe;
    // ONE view, both lanes. 1e-8 is below the deep-lane threshold so the shipped
    // WebGL renderer runs its REAL perturbation lane (not its plain shallow loop),
    // which is the like-for-like comparison against the WebGPU perturbed pass.
    const view = { centerX: -0.743643887037151, centerY: 0.13182590420533, scale: 1e-8 };
    const W = 160, H = 120, CAP = 2048, FRAMES = 5;

    const gpu = await probe.runProbe({
      width: W, height: H, centerX: view.centerX, centerY: view.centerY,
      scale: view.scale, maxIter: CAP, orbitWidth: CAP + 1,
      runCeiling: false, timingFrames: FRAMES, keepArrays: false,
    });
    if (!gpu.ok) return { ran: true, gpuFailed: true, reason: gpu.reason, report };

    // The SHIPPED WebGL renderer, instantiated directly from its ES module so the
    // app's own state cannot affect the measurement.
    let glMs = null, glError = null, usePerturbation = null, orbitSource = null, glFrames = 0;
    try {
      const mod = await import('/webglFractal.js');
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      document.body.appendChild(canvas);
      const renderer = new mod.WebGLFractalRenderer(canvas);
      const gl = renderer.gl;
      const probePixel = new Uint8Array(4);
      // `gl.finish()` alone is NOT a completion barrier here: ANGLE/SwiftShader
      // returned in 0.02 ms/frame with it, which is a CPU-submission number. A 1x1
      // readPixels forces the frame to completion, the same way the WebGPU side's
      // `queue.onSubmittedWorkDone()` does.
      const renderOnce = () => {
        renderer.render(view, CAP, 0, 0, undefined);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probePixel);
      };
      renderOnce();   // warm-up: builds/uses the orbit
      usePerturbation = renderer.usePerturbation;
      orbitSource = renderer.orbitSource;
      const t0 = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        renderOnce();
        glFrames++;
      }
      glMs = (performance.now() - t0) / FRAMES;
      renderer.destroy();
      canvas.remove();
    } catch (err) {
      glError = String(err && err.message ? err.message : err);
    }
    return {
      ran: true,
      gpuFailed: false,
      report,
      view: { ...view, width: W, height: H, maxIter: CAP, frames: FRAMES },
      webgpu: { msPerFrame: gpu.timingMsPerFrame, frames: gpu.timingFrames, perturbMs: gpu.perturbMs, orbitUploadMs: gpu.orbitUploadMs },
      webgl: { msPerFrame: glMs, frames: glFrames, error: glError, usePerturbation, orbitSource },
      escapeStats: gpu.escapeStats,
      messages: gpu.messages,
      validationErrors: gpu.validationErrors,
      limits: {
        maxStorageBufferBindingSize: gpu.deviceLimits && gpu.deviceLimits.maxStorageBufferBindingSize,
        maxBufferSize: gpu.deviceLimits && gpu.deviceLimits.maxBufferSize,
        webglTextureCap: gpu.webglTextureCap,
      },
    };
  });

  test.skip(!outcome.ran, skipReason(outcome.report));
  if (outcome.gpuFailed) throw new Error('WebGPU timing probe failed: ' + outcome.reason);

  console.log('[timing] view=' + JSON.stringify(outcome.view)
    + ' limits=' + JSON.stringify(outcome.limits)
    + ' escapeStats=' + JSON.stringify(outcome.escapeStats));
  console.log('[timing] SOFTWARE ADAPTERS (this host: SwiftShader for BOTH lanes; '
    + 'these numbers say NOTHING about real hardware): webgpu='
    + outcome.webgpu.msPerFrame.toFixed(2) + ' ms/frame (' + outcome.webgpu.frames + ' frames, perturbMs='
    + outcome.webgpu.perturbMs.toFixed(2) + ') vs webgl=' 
    + (outcome.webgl.msPerFrame === null ? 'unavailable' : outcome.webgl.msPerFrame.toFixed(2) + ' ms/frame')
    + ' glError=' + outcome.webgl.error + ' webglLane=' + outcome.webgl.usePerturbation + '/' + outcome.webgl.orbitSource);

  // Both lanes must have produced a REAL frame (a silently invalid pipeline would
  // otherwise still report a plausible ms/frame), and which one is faster is
  // deliberately NOT asserted — a software adapter is not evidence about hardware
  // (docs/DECISIONS.md row 47).
  expect(typeof outcome.webgpu.msPerFrame).toBe('number');
  expect(outcome.webgpu.msPerFrame).toBeGreaterThan(0);
  expect(outcome.escapeStats.escaped).toBeGreaterThan(100);
  expect(outcome.escapeStats.inside).toBeGreaterThan(0);
  expect(outcome.escapeStats.distinctEscapeValues).toBeGreaterThan(100);
  expect(outcome.validationErrors).toEqual([]);
  expect(outcome.messages).toEqual([]);
  if (outcome.webgl.error === null) {
    expect(outcome.webgl.msPerFrame).toBeGreaterThan(0);
    expect(outcome.webgl.usePerturbation).toBe(true);
    expect(outcome.webgl.frames).toBe(outcome.view.frames);
  }
  expect(pageErrors).toEqual([]);
});
