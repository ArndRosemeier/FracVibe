// public/webgpuProbe.js — a WebGPU FEASIBILITY experiment, not a renderer.
//
// WHY IT EXISTS. docs/STATE.md NORTH-STAR makes the renderer a capability ladder and
// names WebGPU (compute) as a candidate tier ABOVE WebGL. The three reasons it is
// genuinely better HERE, in order:
//
//   1. NO `MAX_TEXTURE_SIZE` CEILING ON THE ORBIT. The WebGL orbit travels as a
//      TEXTURE, so `public/webglFractal.js:116` is
//          maxOrbitWidth = min(MAX_TEXTURE_SIZE, MAX_ITER)
//      — a hard cap tied to a texture limit (8192 on this host). WebGPU carries the
//      orbit in a STORAGE BUFFER, whose size is bounded by `maxStorageBufferBindingSize`
//      / `maxBufferSize` (device limits, reported below). This probe ALLOCATES an
//      orbit larger than 8192, READS it in a compute pass at indices past 8192, and
//      verifies the read-back byte-for-byte.
//   2. REAL COMPUTE SHADERS. A proper loop with workgroup dispatch, and no GLSL ES
//      1.00 `#define`-templated loop-bound constraint (webglFractal.js has to
//      template `MAX_ITER` into the fragment source because GLSL ES 1.00 requires a
//      constant loop bound). The loop bound here is a UNIFORM.
//   3. EXPLICIT `f32` ARITHMETIC and a cleaner path to the exponent-carrying delta
//      coordinate (P2 measured the wall as the `float dcx = ... * u_scale` UNDERFLOW
//      at ~2e-38 — a RANGE wall, not a mantissa wall; docs/DECISIONS.md row 42).
//
// WHAT IT DOES NOT CLAIM. No performance superiority. On THIS host Chrome's WebGPU
// adapter is `google / swiftshader` — a SOFTWARE adapter, exactly like this host's
// WebGL — so every millisecond this probe reports is a software number and says
// nothing about real hardware (docs/DECISIONS.md row 47). The probe reports numbers;
// it never asserts that WebGPU is faster.
//
// DELIBERATELY NOT WIRED IN. Nothing imports this file, `public/app.js` does not
// mention it, and the live dispatch is untouched. Wiring a WebGPU backend into the
// ladder is a LATER slice (docs/RENDERER-CONTRACT.md §6). This file is the evidence
// that the tier is reachable on this host and that the two WebGPU-specific wins are
// real.
//
// dependency-free, in the style of public/fractalKernel.js: no imports, one frozen
// global `globalThis.FractalWebGPUProbe`. It reads `globalThis.FractalCapabilities`
// if the detector is loaded, but does not require it.
(function (global) {
  'use strict';

  var PROBE_VERSION = '1';
  // The WebGL texture ceiling this host measures (docs/STATE.md `MEASURED ... WebGPU
  // availability`; webglFractal.js:116). Named here so the comparison is explicit.
  var WEBGL_TEXTURE_CAP = 8192;
  // One reference-orbit sample in this probe's layout is vec2<f32> = 8 bytes.
  var ORBIT_SAMPLE_BYTES = 8;

  // ---------------------------------------------------------------------------
  // The reference orbit: the float64 orbit of the view centre (exactly the
  // recurrence public/webglFractal.js:599-607 uses). The float64 copy is kept for
  // the independent reference; the float32 copy is what goes to the GPU (the
  // transport P1 measured exact with NEAREST float textures, and which a storage
  // buffer carries the same way).
  // ---------------------------------------------------------------------------
  function buildReferenceOrbit(centerX, centerY, count) {
    var f64 = new Float64Array(count * 2);
    var f32 = new Float32Array(count * 2);
    var x = 0, y = 0;
    for (var k = 0; k < count; k++) {
      f64[k * 2] = x;
      f64[k * 2 + 1] = y;
      f32[k * 2] = Math.fround(x);
      f32[k * 2 + 1] = Math.fround(y);
      var xt = x * x - y * y + centerX;
      y = 2 * x * y + centerY;
      x = xt;
    }
    return { f64: f64, f32: f32 };
  }

  // ---------------------------------------------------------------------------
  // WGSL. The perturbed iteration is the SAME recurrence and the SAME two
  // mechanisms the shipped GLSL uses (webglFractal.js:158-244):
  //
  //   z_0 = 0,  z_{n+1} = 2 Z_m z_n + z_n^2 + dc   (dc = pixel offset from centre)
  //   REBASING  — when |Z_m + z| < |z|, z <- Z_m + z and m <- 0
  //   RESCALING — z = S*w, dc = S*d, S renormalised every 256 iterations
  //
  // Pixel centres use the CPU kernel's y-down convention
  // (`fractalKernel.js:434-441` pixelToCoord), so the frame is directly comparable
  // with a JS reference rather than with a vertically flipped GL readback.
  // ---------------------------------------------------------------------------
  var PERTURB_WGSL = [
    'struct Params {',
    '  centerX: f32, centerY: f32, scale: f32, aspect: f32,',
    '  width: u32, height: u32, maxIter: u32, orbitW: u32,',
    '};',
    '',
    '@group(0) @binding(0) var<storage, read> orbit: array<vec2<f32>>;',
    '@group(0) @binding(1) var<storage, read_write> escapeOut: array<u32>;',
    '@group(0) @binding(2) var<storage, read_write> indexOut: array<u32>;',
    '@group(0) @binding(3) var<storage, read_write> pixOut: array<u32>;',
    '@group(0) @binding(4) var<uniform> params: Params;',
    '',
    'const BAILOUT_SQ: f32 = 4.0;',
    // 1 / ln(BAILOUT_SQ), the SAME constant the kernel and the GLSL use (D1).
    'const SMOOTH_LOG_BAILOUT: f32 = 0.7213475204444817;',
    '',
    '// The kernel\'s rainbow palette (public/fractalKernel.js:69-80), on the SAME t.',
    'fn rainbow(t: f32) -> vec3<f32> {',
    '  let a = (1.0 - t) * 4.0;',
    '  let fl = floor(a);',
    '  let X = i32(fl);',
    '  let Y = a - fl;',
    '  if (X == 0) { return vec3<f32>(0.0, Y, 1.0); }',
    '  if (X == 1) { return vec3<f32>(0.0, 1.0, 1.0 - Y); }',
    '  if (X == 2) { return vec3<f32>(Y, 1.0, 0.0); }',
    '  if (X == 3) { return vec3<f32>(1.0, 1.0 - Y, 0.0); }',
    '  return vec3<f32>(1.0, 0.0, 0.0);',
    '}',
    '',
    'fn pack8(c: vec3<f32>) -> u32 {',
    '  let r = u32(round(clamp(c.r, 0.0, 1.0) * 255.0));',
    '  let g = u32(round(clamp(c.g, 0.0, 1.0) * 255.0));',
    '  let b = u32(round(clamp(c.b, 0.0, 1.0) * 255.0));',
    '  return r | (g << 8u) | (b << 16u) | (255u << 24u);',
    '}',
    '',
    '@compute @workgroup_size(8, 8)',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
    '  if (gid.x >= params.width || gid.y >= params.height) { return; }',
    '  let wF = f32(params.width);',
    '  let hF = f32(params.height);',
    '  let dcx = (f32(gid.x) + 0.5 - wF * 0.5) * params.scale / wF * params.aspect;',
    '  let dcy = (f32(gid.y) + 0.5 - hF * 0.5) * params.scale / hF;',
    '  var dzx = dcx;',
    '  var dzy = dcy;',
    '  var ddx = dcx;',
    '  var ddy = dcy;',
    '  var S = 1.0;',
    '  var x = 0.0;',
    '  var y = 0.0;',
    '  var er2 = 0.0;',
    '  var n = params.maxIter;',
    '  var m: u32 = 0u;',
    '  var maxIndex: u32 = 0u;',
    '  for (var i: u32 = 0u; i < params.maxIter; i = i + 1u) {',
    '    let om = min(m, params.orbitW - 1u);',
    '    maxIndex = max(maxIndex, om);',
    '    let Z = orbit[om];',
    '    let Z2 = Z.x * Z.x + Z.y * Z.y;',
    '    let nwx = 2.0 * (Z.x * dzx - Z.y * dzy) + S * (dzx * dzx - dzy * dzy) + ddx;',
    '    let nwy = 2.0 * (Z.x * dzy + Z.y * dzx) + S * (2.0 * dzx * dzy) + ddy;',
    '    dzx = nwx;',
    '    dzy = nwy;',
    '    m = m + 1u;',
    '    let om2 = min(m, params.orbitW - 1u);',
    '    maxIndex = max(maxIndex, om2);',
    '    let Z2v = orbit[om2];',
    '    x = Z2v.x + S * dzx;',
    '    y = Z2v.y + S * dzy;',
    '    er2 = x * x + y * y;',
    '    // REBASING, on the same absorbed magnitude the shipped GLSL uses.',
    '    let zd2 = S * S * (dzx * dzx + dzy * dzy);',
    '    if (er2 < zd2) {',
    '      dzx = x / S;',
    '      dzy = y / S;',
    '      m = 0u;',
    '    }',
    '    if (er2 > BAILOUT_SQ) { n = i + 1u; break; }',
    '    // RESCALING every 256 iterations, S a power of two (exact in f32).',
    '    if ((i % 256u) == 0u) {',
    '      let mag = S * sqrt(dzx * dzx + dzy * dzy);',
    '      if (mag > 0.0 && mag < 3.0e38) {',
    '        let newS = exp2(floor(log2(mag) + 0.5));',
    '        let f = S / newS;',
    '        dzx = dzx * f;',
    '        dzy = dzy * f;',
    '        ddx = ddx * f;',
    '        ddy = ddy * f;',
    '        S = newS;',
    '      }',
    '    }',
    '  }',
    '  // The smooth value: the SAME expression as fractalKernel.js:270-276 and the',
    '  // GLSL (webglFractal.js:340-342); the inside case is exactly maxIter (black).',
    '  var smoothV = f32(params.maxIter);',
    '  if (n < params.maxIter) {',
    '    smoothV = f32(n) + 1.0 - log2(log(er2) * SMOOTH_LOG_BAILOUT);',
    '    if (!(smoothV < f32(params.maxIter))) { smoothV = f32(params.maxIter); }',
    '  }',
    '  let idx = gid.y * params.width + gid.x;',
    '  escapeOut[idx] = n;',
    '  indexOut[idx] = maxIndex;',
    '  if (n < params.maxIter) {',
    '    pixOut[idx] = pack8(rainbow(smoothV / f32(params.maxIter)));',
    '  } else {',
    '    pixOut[idx] = pack8(vec3<f32>(0.0, 0.0, 0.0));',
    '  }',
    '}'
  ].join('\n');

  // The storage-ceiling pass: one thread per orbit entry reads `orbit[k]` and writes
  // it back unchanged. Launching it over the WHOLE orbit and verifying the read-back
  // byte-for-byte is a direct proof that indices PAST 8192 are addressable and
  // correct in a compute pass — no inference from an early escape.
  var CEILING_WGSL = [
    'struct Params {',
    '  centerX: f32, centerY: f32, scale: f32, aspect: f32,',
    '  width: u32, height: u32, maxIter: u32, orbitW: u32,',
    '};',
    '@group(0) @binding(0) var<storage, read> orbit: array<vec2<f32>>;',
    '@group(0) @binding(1) var<storage, read_write> ceilingOut: array<vec2<f32>>;',
    '@group(0) @binding(2) var<uniform> params: Params;',
    '',
    '@compute @workgroup_size(64)',
    'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
    '  if (gid.x >= params.orbitW) { return; }',
    '  let Z = orbit[gid.x];',
    '  ceilingOut[gid.x] = Z;',
    '}'
  ].join('\n');

  async function readBuffer(device, src, byteLength) {
    var staging = device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    var enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, byteLength);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    var range = staging.getMappedRange();
    var copy = new Uint8Array(range.byteLength);
    copy.set(new Uint8Array(range));
    staging.unmap();
    staging.destroy();
    return copy;
  }

  function limitsSnapshot(limits, names) {
    var out = {};
    if (!limits) return out;
    for (var i = 0; i < names.length; i++) {
      if (typeof limits[names[i]] === 'number') out[names[i]] = limits[names[i]];
    }
    return out;
  }

  var LIMIT_NAMES = [
    'maxTextureDimension2D',
    'maxStorageBufferBindingSize',
    'maxBufferSize',
    'maxComputeWorkgroupStorageSize',
    'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupSizeX',
    'maxComputeWorkgroupsPerDimension'
  ];

  var DEFAULTS = {
    width: 96,
    height: 96,
    // The P1 probe's centre: a point on the boundary whose frame is structured
    // at depth, so the escape-time frame is not a degenerate constant.
    centerX: -0.743643887037151,
    centerY: 0.13182590420533,
    scale: 1e-12,
    maxIter: 8192,
    orbitWidth: 0,           // 0 => maxIter + 1
    runCeiling: true,
    ceilingWidth: 0,         // 0 => orbitWidth (must be > 8192 to prove the point)
    timingFrames: 0,
    keepArrays: true
  };

  async function runProbe(options) {
    var o = Object.assign({}, DEFAULTS, options || {});
    var width = Math.max(1, o.width | 0);
    var height = Math.max(1, o.height | 0);
    var maxIter = Math.max(1, o.maxIter | 0);
    var orbitWidth = o.orbitWidth > 0 ? (o.orbitWidth | 0) : (maxIter + 1);
    var orbit = buildReferenceOrbit(o.centerX, o.centerY, orbitWidth);
    var result = {
      ok: false,
      probeVersion: PROBE_VERSION,
      width: width,
      height: height,
      maxIter: maxIter,
      scale: o.scale,
      centerX: o.centerX,
      centerY: o.centerY,
      orbitWidth: orbitWidth,
      webglTextureCap: WEBGL_TEXTURE_CAP,
      reason: null,
      messages: [],
      validationErrors: []
    };
    if (!global.navigator || !global.navigator.gpu) {
      result.reason = 'navigator.gpu is undefined (no WebGPU API / not a secure context)';
      return result;
    }
    var adapter = null;
    try {
      adapter = await global.navigator.gpu.requestAdapter();
    } catch (err) {
      result.reason = 'requestAdapter() rejected: ' + (err && err.message ? err.message : String(err));
      return result;
    }
    if (!adapter) {
      result.reason = 'requestAdapter() returned null — API present, NO ADAPTER granted';
      return result;
    }
    var adapterInfo = adapter.info || null;
    if (!adapterInfo && typeof adapter.requestAdapterInfo === 'function') {
      try { adapterInfo = await adapter.requestAdapterInfo(); } catch (_) { adapterInfo = null; }
    }
    result.adapterInfo = adapterInfo ? {
      vendor: adapterInfo.vendor == null ? null : String(adapterInfo.vendor),
      architecture: adapterInfo.architecture == null ? null : String(adapterInfo.architecture),
      device: adapterInfo.device == null ? null : String(adapterInfo.device),
      description: adapterInfo.description == null ? null : String(adapterInfo.description)
    } : null;
    result.adapterIsFallback = !!adapter.isFallbackAdapter;
    result.adapterLimits = limitsSnapshot(adapter.limits, LIMIT_NAMES);
    var device = null;
    try {
      device = await adapter.requestDevice();
    } catch (err) {
      result.reason = 'requestDevice() rejected: ' + (err && err.message ? err.message : String(err));
      return result;
    }
    result.deviceLimits = limitsSnapshot(device.limits, LIMIT_NAMES);
    result.storageOrbitCapacity = Math.floor(
      ((device.limits && device.limits.maxStorageBufferBindingSize) || 0) / ORBIT_SAMPLE_BYTES);

    device.addEventListener('uncapturederror', function (ev) {
      try { result.validationErrors.push(String(ev.error && (ev.error.message || ev.error))); }
      catch (_) { result.validationErrors.push('unknown uncaptured error'); }
    });

    try {
      // --- shader modules, with compilation info reported ---------------------
      var perturbModule = device.createShaderModule({ code: PERTURB_WGSL });
      var ceilingModule = device.createShaderModule({ code: CEILING_WGSL });
      for (var mi = 0; mi < 2; mi++) {
        var mod = mi === 0 ? perturbModule : ceilingModule;
        if (typeof mod.getCompilationInfo === 'function') {
          var ci = await mod.getCompilationInfo();
          for (var mj = 0; mj < ci.messages.length; mj++) {
            var m = ci.messages[mj];
            result.messages.push((mi === 0 ? 'perturb' : 'ceiling') + ' ' + m.type + ': ' + m.message
              + ' @' + m.lineNum + ':' + m.linePos);
          }
        }
      }

      var perturbPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: perturbModule, entryPoint: 'main' }
      });
      var ceilingPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: ceilingModule, entryPoint: 'main' }
      });

      var orbitBytes = orbitWidth * ORBIT_SAMPLE_BYTES;
      var pixelBytes = width * height * 4;
      var orbitBuf = device.createBuffer({
        size: orbitBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      var escapeBuf = device.createBuffer({
        size: pixelBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      var indexBuf = device.createBuffer({
        size: pixelBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      var pixBuf = device.createBuffer({
        size: pixelBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      var paramsBuf = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      var paramsData = new ArrayBuffer(32);
      var pf = new Float32Array(paramsData);
      var pu = new Uint32Array(paramsData);
      pf[0] = o.centerX;
      pf[1] = o.centerY;
      pf[2] = o.scale;
      pf[3] = width / height;
      pu[4] = width;
      pu[5] = height;
      pu[6] = maxIter;
      pu[7] = orbitWidth;
      device.queue.writeBuffer(paramsBuf, 0, paramsData);

      var t0 = performance.now();
      device.queue.writeBuffer(orbitBuf, 0, orbit.f32);
      await device.queue.onSubmittedWorkDone();
      result.orbitUploadMs = performance.now() - t0;

      var perturbBind = device.createBindGroup({
        layout: perturbPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: orbitBuf } },
          { binding: 1, resource: { buffer: escapeBuf } },
          { binding: 2, resource: { buffer: indexBuf } },
          { binding: 3, resource: { buffer: pixBuf } },
          { binding: 4, resource: { buffer: paramsBuf } }
        ]
      });

      function encodePerturb() {
        var enc = device.createCommandEncoder();
        var pass = enc.beginComputePass();
        pass.setPipeline(perturbPipeline);
        pass.setBindGroup(0, perturbBind);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        return enc.finish();
      }

      var t1 = performance.now();
      device.queue.submit([encodePerturb()]);
      await device.queue.onSubmittedWorkDone();
      result.perturbMs = performance.now() - t1;

      // --- the readback: pixels, escape indices, max orbit index --------------
      var pixBytes = await readBuffer(device, pixBuf, pixelBytes);
      var escBytes = await readBuffer(device, escapeBuf, pixelBytes);
      var idxBytes = await readBuffer(device, indexBuf, pixelBytes);
      var pixels = new Uint8ClampedArray(pixBytes.buffer, pixBytes.byteOffset, pixBytes.byteLength);
      var escape = new Uint32Array(escBytes.buffer, escBytes.byteOffset, width * height);
      var maxIndex = new Uint32Array(idxBytes.buffer, idxBytes.byteOffset, width * height);

      // --- the storage-buffer ceiling proof -----------------------------------
      // The pass reads `orbit[k]` for EVERY k up to ceilingWidth-1 and writes it
      // back, and the read-back is compared to the input BYTE-FOR-BYTE. The buffer
      // it scans is a SYNTHETIC ramp (`vec2(k, k/2)`), deliberately: the naming
      // proof then reads exact finite values (`index 8192 -> [8192, 4096]`) instead
      // of whatever a chaotic orbit happens to hold there (a 20000-iteration orbit
      // of a boundary point is NaN past its escape), and byte equality of NaN is not
      // a statement anyone can eyeball. The REAL 20001-entry orbit is the buffer the
      // perturbed pass reads (below), so both facts are covered.
      if (o.runCeiling) {
        var ceilingWidth = o.ceilingWidth > 0 ? (o.ceilingWidth | 0) : orbitWidth;
        var ramp = new Float32Array(ceilingWidth * 2);
        for (var rk = 0; rk < ceilingWidth; rk++) {
          ramp[rk * 2] = Math.fround(rk);
          ramp[rk * 2 + 1] = Math.fround(rk * 0.5);
        }
        var rampBuf = device.createBuffer({
          size: ceilingWidth * ORBIT_SAMPLE_BYTES,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(rampBuf, 0, ramp);
        var ceilingBuf = device.createBuffer({
          size: ceilingWidth * ORBIT_SAMPLE_BYTES,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        pu[7] = ceilingWidth;
        device.queue.writeBuffer(paramsBuf, 0, paramsData);
        var ceilingBind = device.createBindGroup({
          layout: ceilingPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: rampBuf } },
            { binding: 1, resource: { buffer: ceilingBuf } },
            { binding: 2, resource: { buffer: paramsBuf } }
          ]
        });
        var t2 = performance.now();
        var cenc = device.createCommandEncoder();
        var cpass = cenc.beginComputePass();
        cpass.setPipeline(ceilingPipeline);
        cpass.setBindGroup(0, ceilingBind);
        cpass.dispatchWorkgroups(Math.ceil(ceilingWidth / 64));
        cpass.end();
        device.queue.submit([cenc.finish()]);
        await device.queue.onSubmittedWorkDone();
        result.ceilingMs = performance.now() - t2;
        var cBytes = await readBuffer(device, ceilingBuf, ceilingWidth * ORBIT_SAMPLE_BYTES);
        var cBack = new Float32Array(cBytes.buffer, cBytes.byteOffset, ceilingWidth * 2);
        var rampBytes = new Uint8Array(ramp.buffer);
        var mismatch = 0;
        var firstMismatch = -1;
        // BYTE equality: catches a NaN/±0 payload difference that `!==` would call a
        // mismatch and `Object.is` would call equal, either way for the wrong reason.
        for (var kb = 0; kb < cBytes.length; kb++) {
          if (cBytes[kb] !== rampBytes[kb]) {
            mismatch++;
            if (firstMismatch < 0) firstMismatch = kb;
          }
        }
        var realNonFinite = 0;
        for (var q = 0; q < orbitWidth * 2; q++) {
          if (!isFinite(orbit.f32[q])) realNonFinite++;
        }
        result.ceiling = {
          entries: ceilingWidth,
          bytes: ceilingWidth * ORBIT_SAMPLE_BYTES,
          mismatch: mismatch,
          firstMismatch: firstMismatch,
          lastIndexRead: ceilingWidth - 1,
          aboveTextureCap: ceilingWidth - 1 > WEBGL_TEXTURE_CAP,
          // The exact f32 words at the first index past the WebGL texture cap, so
          // the proof names the value rather than only a count.
          sampleAt8192: [cBack[WEBGL_TEXTURE_CAP * 2], cBack[WEBGL_TEXTURE_CAP * 2 + 1]],
          expectedAt8192: [Math.fround(WEBGL_TEXTURE_CAP), Math.fround(WEBGL_TEXTURE_CAP * 0.5)],
          sampleAtLast: [cBack[(ceilingWidth - 1) * 2], cBack[(ceilingWidth - 1) * 2 + 1]],
          expectedAtLast: [Math.fround(ceilingWidth - 1), Math.fround((ceilingWidth - 1) * 0.5)],
          realOrbitEntries: orbitWidth,
          realOrbitNonFiniteWords: realNonFinite
        };
        // restore the perturb params for any later use
        pu[7] = orbitWidth;
        device.queue.writeBuffer(paramsBuf, 0, paramsData);
      }

      // --- the frame, and a canvas round trip ---------------------------------
      var stats = summariseEscape(escape, maxIndex, width, height, maxIter);
      var readback = paintAndReadBack(pixels, width, height);
      // A JS float64 reference for the SAME pixel centres, computed from the SAME
      // recurrence (float64, rebasing, rescaling) — the independent check that the
      // compute pass really computed an escape-time frame.
      var ref = referenceFrame(orbit.f64, orbitWidth, o, width, height, maxIter);

      // --- timing -------------------------------------------------------------
      if (o.timingFrames > 0) {
        var n = Math.min(60, Math.max(1, o.timingFrames | 0));
        device.queue.submit([encodePerturb()]);
        await device.queue.onSubmittedWorkDone();
        var t3 = performance.now();
        for (var f = 0; f < n; f++) {
          device.queue.submit([encodePerturb()]);
          await device.queue.onSubmittedWorkDone();
        }
        result.timingMsPerFrame = (performance.now() - t3) / n;
        result.timingFrames = n;
      }

      result.ok = true;
      result.escapeStats = stats;
      result.canvasReadback = readback;
      if (o.keepArrays !== false) {
        result.orbitF64 = orbit.f64;
        result.orbitF32 = orbit.f32;
        result.escape = escape;
        result.maxIndex = maxIndex;
        result.pixels = pixels;
        result.referenceEscape = ref.escape;
        result.referenceInside = ref.inside;
      }
      result.escapeVsReference = compareFrames(escape, ref.escape, ref.inside, maxIter);
    } catch (err) {
      result.reason = 'probe threw: ' + (err && err.message ? err.message : String(err));
      result.stack = err && err.stack ? String(err.stack) : null;
    }
    try { device.destroy(); } catch (_) { /* best effort */ }
    return result;
  }

  // A per-pixel float64 reference: the same delta recurrence, the same rebasing and
  // rescaling rules, from the EXACT float64 orbit. This is deliberately a
  // restatement of the algorithm — it is the measurement, not the code under test.
  function referenceFrame(orbitF64, orbitWidth, o, width, height, maxIter) {
    var aspect = width / height;
    var escape = new Uint32Array(width * height);
    var inside = new Uint8Array(width * height);
    for (var py = 0; py < height; py++) {
      var dcy = (py + 0.5 - height * 0.5) * o.scale / height;
      for (var px = 0; px < width; px++) {
        var dcx = (px + 0.5 - width * 0.5) * o.scale / width * aspect;
        var dzx = dcx, dzy = dcy, ddx = dcx, ddy = dcy;
        var S = 1.0, x = 0.0, y = 0.0, er2 = 0.0;
        var n = maxIter, m = 0;
        for (var i = 0; i < maxIter; i++) {
          var om = Math.min(m, orbitWidth - 1);
          var Zx = orbitF64[om * 2], Zy = orbitF64[om * 2 + 1];
          var nwx = 2 * (Zx * dzx - Zy * dzy) + S * (dzx * dzx - dzy * dzy) + ddx;
          var nwy = 2 * (Zx * dzy + Zy * dzx) + S * (2 * dzx * dzy) + ddy;
          dzx = nwx; dzy = nwy;
          m++;
          var om2 = Math.min(m, orbitWidth - 1);
          var X = orbitF64[om2 * 2], Y = orbitF64[om2 * 2 + 1];
          x = X + S * dzx; y = Y + S * dzy;
          er2 = x * x + y * y;
          var zd2 = S * S * (dzx * dzx + dzy * dzy);
          if (er2 < zd2) { dzx = x / S; dzy = y / S; m = 0; }
          if (er2 > 4.0) { n = i + 1; break; }
          if ((i % 256) === 0) {
            var mag = S * Math.sqrt(dzx * dzx + dzy * dzy);
            if (mag > 0 && mag < 3.0e38) {
              var newS = Math.pow(2, Math.floor(Math.log2(mag) + 0.5));
              var f = S / newS;
              dzx *= f; dzy *= f; ddx *= f; ddy *= f; S = newS;
            }
          }
        }
        escape[py * width + px] = n;
        inside[py * width + px] = (n >= maxIter) ? 1 : 0;
      }
    }
    return { escape: escape, inside: inside };
  }

  function compareFrames(gpuEscape, refEscape, refInside, maxIter) {
    var n = gpuEscape.length;
    var mis = 0, sumAbs = 0, maxAbs = 0, bothEscaped = 0, agreeWithin1 = 0;
    for (var i = 0; i < n; i++) {
      var g = gpuEscape[i];
      var r = refEscape[i];
      var gInside = g >= maxIter ? 1 : 0;
      if (gInside !== refInside[i]) mis++;
      if (!gInside && !refInside[i]) {
        bothEscaped++;
        var d = Math.abs(g - r);
        sumAbs += d;
        if (d > maxAbs) maxAbs = d;
        if (d <= 1) agreeWithin1++;
      }
    }
    return {
      pixels: n,
      misclassified: mis,
      misclassifiedFrac: mis / n,
      bothEscaped: bothEscaped,
      meanAbsIndexDelta: bothEscaped ? sumAbs / bothEscaped : 0,
      maxAbsIndexDelta: maxAbs,
      agreeWithin1Frac: bothEscaped ? agreeWithin1 / bothEscaped : 0
    };
  }

  function summariseEscape(escape, maxIndex, width, height, maxIter) {
    var inside = 0, escaped = 0, beyond8192 = 0, maxEscape = 0, maxOrbitIndex = 0;
    var distinct = new Set();
    for (var i = 0; i < escape.length; i++) {
      var n = escape[i];
      if (n >= maxIter) inside++; else {
        escaped++;
        distinct.add(n);
        if (n > maxEscape) maxEscape = n;
        if (n > WEBGL_TEXTURE_CAP) beyond8192++;
      }
      if (maxIndex[i] > maxOrbitIndex) maxOrbitIndex = maxIndex[i];
    }
    return {
      pixels: width * height,
      inside: inside,
      escaped: escaped,
      distinctEscapeValues: distinct.size,
      maxEscape: maxEscape,
      escapedBeyond8192: beyond8192,
      maxOrbitIndexRead: maxOrbitIndex
    };
  }

  // putImageData -> getImageData: proves the read-back bytes are real, displayable
  // pixels, and that they survive the canvas round trip. The statistics are taken
  // from the READ-BACK bytes, not from the storage buffer.
  function paintAndReadBack(pixels, width, height) {
    var canvas = global.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(width, height);
    img.data.set(pixels);
    ctx.putImageData(img, 0, 0);
    var back = ctx.getImageData(0, 0, width, height).data;
    var distinct = new Set();
    var nonBlack = 0;
    var checksum = 0;
    for (var i = 0; i < back.length; i += 4) {
      distinct.add((back[i] << 16) | (back[i + 1] << 8) | back[i + 2]);
      if (back[i] || back[i + 1] || back[i + 2]) nonBlack++;
      checksum = (checksum + back[i] * 3 + back[i + 1] * 5 + back[i + 2] * 7) % 2147483647;
    }
    return {
      width: width,
      height: height,
      distinctColors: distinct.size,
      nonBlackPixels: nonBlack,
      nonBlackFrac: nonBlack / (width * height),
      checksum: checksum,
      sampleTopLeft: [back[0], back[1], back[2], back[3]],
      sampleCentre: (function () {
        var c = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
        return [back[c], back[c + 1], back[c + 2], back[c + 3]];
      })()
    };
  }

  global.FractalWebGPUProbe = Object.freeze({
    PROBE_VERSION: PROBE_VERSION,
    WEBGL_TEXTURE_CAP: WEBGL_TEXTURE_CAP,
    ORBIT_SAMPLE_BYTES: ORBIT_SAMPLE_BYTES,
    PERTURB_WGSL: PERTURB_WGSL,
    CEILING_WGSL: CEILING_WGSL,
    buildReferenceOrbit: buildReferenceOrbit,
    runProbe: runProbe
  });
})(typeof self !== 'undefined' ? self : globalThis);
