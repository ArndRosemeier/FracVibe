// public/capabilities.js — the capability LADDER's detector.
//
// THE ONE JOB. `docs/STATE.md` NORTH-STAR (owner, 2026-09-21) makes the renderer a
// CAPABILITY LADDER: WebGPU (compute) > WebGL + OES_texture_float (the perturbation
// lane) > WebGL without float textures (plain float32, shallow) > CPU with WASM SIMD.
// Nothing may be dispatched from a guess about the machine, so this file answers ONE
// question with MEASUREMENTS: what does THIS machine actually expose?
//
// THE TRAP THIS FILE EXISTS TO ENCODE (measured on this host, 2026-09-21 — it cost
// three probe attempts before it was spotted, see docs/STATE.md `MEASURED ... WebGPU
// availability`):
//
//     `navigator.gpu !== undefined` IS NOT SUFFICIENT TO SELECT THE WEBGPU TIER.
//
// On this host `navigator.gpu` is PRESENT in a secure context and
// `navigator.gpu.requestAdapter()` returns **null** — the API is exposed, there is
// simply no hardware adapter. A naive `if (navigator.gpu)` feature test therefore
// selects WebGPU on a machine that cannot run it. And a secure context is required:
// on `about:blank` (`window.isSecureContext === false`) `navigator.gpu` is
// `undefined` ENTIRELY.
//
// So `webgpu` has THREE states, never a boolean:
//
//     'absent'                 — no navigator.gpu at all (or no requestAdapter)
//     'api-present-no-adapter' — navigator.gpu exists, requestAdapter() gave null
//     'adapter-available'      — an adapter was GRANTED and its info is reported
//
// `selectTier(report)` refuses to look at `navigator.gpu` at all: it selects the
// WebGPU tier ONLY from the awaited `webgpu.status === 'adapter-available'`. That is
// the pin in tests/webgpu-feasibility.spec.js.
//
// WHY NO `import` AND NO `export` (the dual-consumption pattern, docs/DECISIONS.md
// row 14): a file with no import/export statement is simultaneously a valid classic
// script and a valid ES module, so ONE source serves an `importScripts` worker, a
// `<script src>` load and an ES-module side-effect import (public/colorSchemes.js is
// the named-export wrapper, and public/capabilitiesModule.js is this file's). It
// publishes exactly one frozen global, `globalThis.FractalCapabilities`.
//
// dependency-free, in the style of public/fractalKernel.js: no imports, no build
// step, no dependencies. Everything is feature-TESTED, never assumed — including
// WASM SIMD, which is validated against a real module rather than sniffed.
(function (global) {
  'use strict';

  var PROBE_VERSION = '1';

  // The three-state WebGPU vocabulary. A boolean here is the defect this file
  // documents, so the strings are exported and used everywhere instead.
  var WEBGPU_STATUS = Object.freeze({
    ABSENT: 'absent',
    API_PRESENT_NO_ADAPTER: 'api-present-no-adapter',
    ADAPTER_AVAILABLE: 'adapter-available'
  });

  // The tier names `selectTier` returns, best-capability first (NORTH-STAR order).
  var TIERS = Object.freeze({
    WEBGPU: 'webgpu',
    WEBGL_PERTURBATION: 'webgl-perturbation',
    WEBGL_PLAIN: 'webgl-plain',
    CPU: 'cpu'
  });

  // The device limits that matter for the reason WebGPU is a tier ABOVE WebGL here:
  // the orbit is a THROUGHPUT resource whose WebGL home is a texture capped at
  // MAX_TEXTURE_SIZE (8192 on this host), while WebGPU carries it in a STORAGE
  // BUFFER whose size is bounded by these. The probe measures the real numbers.
  var LIMIT_NAMES = [
    'maxTextureDimension2D',
    'maxStorageBufferBindingSize',
    'maxBufferSize',
    'maxComputeWorkgroupStorageSize',
    'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupSizeX',
    'maxComputeWorkgroupsPerDimension'
  ];

  function num(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }

  function isSecureContext(scope) {
    if (typeof scope.isSecureContext === 'boolean') return scope.isSecureContext;
    return null;
  }

  // A detached canvas, used and then released. Nothing here touches the live DOM or
  // the app's canvases.
  function newCanvas(scope) {
    try {
      if (typeof scope.document !== 'undefined'
        && scope.document
        && typeof scope.document.createElement === 'function') {
        return scope.document.createElement('canvas');
      }
    } catch (_) { /* a hostile/absent document is simply "no canvas" */ }
    return null;
  }

  // Free a probe context so the detector cannot eat one of the page's limited GL
  // context slots. Best effort: losing the context is not required for the report.
  function releaseContext(gl) {
    if (!gl || typeof gl.getExtension !== 'function') return;
    try {
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose && typeof lose.loseContext === 'function') lose.loseContext();
    } catch (_) { /* nothing to release */ }
  }

  function readGLInfo(gl, out, tag) {
    try {
      out[tag + 'MaxTextureSize'] = num(gl.getParameter(gl.MAX_TEXTURE_SIZE), 0);
      out[tag + 'MaxRenderbufferSize'] = num(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 0);
      if (out[tag + 'MaxTextureSize'] > out.maxTextureSize) {
        out.maxTextureSize = out[tag + 'MaxTextureSize'];
      }
    } catch (_) { /* a context that cannot answer is a zero */ }
  }

  // --- WebGL: the tier BELOW WebGPU, and today's shipped GPU lane ----------------
  // `public/webglFractal.js:94` asks for `'webgl'` (WebGL1) and its perturbation
  // lane is gated on `OES_texture_float` (`webglFractal.js:115`), so the report
  // answers for WebGL1 specifically (`oesTextureFloat`) AND for WebGL2 separately.
  // MAX_TEXTURE_SIZE is reported because it is exactly the hard cap on the orbit
  // (`webglFractal.js:116`: `maxOrbitWidth = min(MAX_TEXTURE_SIZE, MAX_ITER)`).
  function probeWebGL(scope) {
    var out = {
      webgl2: false,
      webgl1: false,
      oesTextureFloat: false,
      maxTextureSize: 0,
      webgl2MaxTextureSize: 0,
      webgl1MaxTextureSize: 0,
      webgl2ExtColorBufferFloat: false,
      webgl1OesTextureFloat: false,
      vendor: null,
      renderer: null
    };

    var c2 = newCanvas(scope);
    if (c2) {
      var gl2 = null;
      try { gl2 = c2.getContext('webgl2'); } catch (_) { gl2 = null; }
      if (gl2) {
        out.webgl2 = true;
        readGLInfo(gl2, out, 'webgl2');
        try {
          out.webgl2ExtColorBufferFloat = !!gl2.getExtension('EXT_color_buffer_float');
          var dbg = gl2.getExtension('WEBGL_debug_renderer_info');
          if (dbg) {
            out.vendor = gl2.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
            out.renderer = gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          }
        } catch (_) { /* optional details */ }
        // WebGL2 makes float texture sampling core; the LEGACY extension object is
        // typically absent there, so report "float orbit transport possible" for
        // WebGL2 from EXT_color_buffer_float and keep the legacy name for WebGL1.
        out.oesTextureFloat = out.oesTextureFloat || out.webgl2ExtColorBufferFloat;
        releaseContext(gl2);
      }
    }

    // A canvas whose webgl2 request failed still yields a WebGL1 context, but use a
    // fresh canvas so the two probes cannot influence each other.
    var c1 = newCanvas(scope);
    if (c1) {
      var gl1 = null;
      try { gl1 = c1.getContext('webgl') || c1.getContext('experimental-webgl'); } catch (_) { gl1 = null; }
      if (gl1) {
        out.webgl1 = true;
        readGLInfo(gl1, out, 'webgl1');
        try {
          out.webgl1OesTextureFloat = !!gl1.getExtension('OES_texture_float');
          if (out.webgl1OesTextureFloat) out.oesTextureFloat = true;
          var dbg1 = gl1.getExtension('WEBGL_debug_renderer_info');
          if (dbg1 && !out.renderer) {
            out.vendor = gl1.getParameter(dbg1.UNMASKED_VENDOR_WEBGL);
            out.renderer = gl1.getParameter(dbg1.UNMASKED_RENDERER_WEBGL);
          }
        } catch (_) { /* optional details */ }
        releaseContext(gl1);
      }
    }

    return out;
  }

  // --- WASM SIMD: FEATURE-TESTED, never assumed ---------------------------------
  // The canonical `v128`-returning module. `WebAssembly.validate` returns false for
  // it on an engine without SIMD, and the 0xFD opcode prefix makes it a real test
  // rather than a UA sniff. Returns null when WebAssembly itself is absent.
  function probeWasmSimd(scope) {
    if (typeof scope.WebAssembly === 'undefined') return null;
    try {
      // (module (func (result v128) (i32x4.splat (i32.const 0))))
      var simdModule = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
      ]);
      if (typeof scope.WebAssembly.validate === 'function') {
        return !!scope.WebAssembly.validate(simdModule);
      }
      return null;
    } catch (_) {
      return false;
    }
  }

  // --- the synchronous half of the report ----------------------------------------
  // Everything that needs no await. Kept separate from `detect()` so a caller that
  // only wants MAX_TEXTURE_SIZE / core count does not have to await an adapter.
  function detectSync(scope) {
    var s = scope || global;
    var navigator = s.navigator || {};
    var webgl = probeWebGL(s);
    var wasmSimd = probeWasmSimd(s);
    return {
      probeVersion: PROBE_VERSION,
      secureContext: isSecureContext(s),
      hardwareConcurrency: num(navigator.hardwareConcurrency, null),
      // The ladder rungs below WebGPU, measured.
      webgl2: webgl.webgl2,
      webgl1: webgl.webgl1,
      oesTextureFloat: webgl.oesTextureFloat,
      maxTextureSize: webgl.maxTextureSize,
      webgl: webgl,
      // The CPU rung's multipliers, measured.
      wasm: typeof s.WebAssembly !== 'undefined',
      wasmSimd: wasmSimd,
      sharedArrayBuffer: typeof s.SharedArrayBuffer !== 'undefined',
      crossOriginIsolated: (typeof s.crossOriginIsolated === 'boolean') ? s.crossOriginIsolated : null,
      // `navigator.gpu` PRESENCE, recorded separately and deliberately: it is a
      // fact about the API surface, NOT a verdict about this machine.
      hasNavigatorGpu: !!(navigator && navigator.gpu),
      offscreenCanvas: typeof s.OffscreenCanvas !== 'undefined'
    };
  }

  function adapterInfoOf(adapter) {
    try {
      var src = adapter && adapter.info;
      if (!src && adapter && typeof adapter.requestAdapterInfo === 'function') return null;
      if (!src) return null;
      return {
        vendor: src.vendor == null ? null : String(src.vendor),
        architecture: src.architecture == null ? null : String(src.architecture),
        device: src.device == null ? null : String(src.device),
        description: src.description == null ? null : String(src.description)
      };
    } catch (_) {
      return null;
    }
  }

  function limitsOf(adapter) {
    var out = {};
    try {
      var limits = adapter && adapter.limits;
      if (!limits) return out;
      for (var i = 0; i < LIMIT_NAMES.length; i++) {
        var name = LIMIT_NAMES[i];
        if (typeof limits[name] === 'number') out[name] = limits[name];
      }
    } catch (_) { /* a limits-less adapter is still an adapter */ }
    return out;
  }

  function featuresOf(adapter) {
    try {
      if (!adapter || !adapter.features || typeof adapter.features.forEach !== 'function') return [];
      var list = [];
      adapter.features.forEach(function (f) { list.push(String(f)); });
      return list.sort();
    } catch (_) {
      return [];
    }
  }

  // --- the ASYNC half: the adapter request, AWAITED ------------------------------
  // This is the function that encodes the trap. It never throws: a rejection is a
  // recorded reason with the status `api-present-no-adapter` (the API exists, the
  // machine did not grant one), which is the state this host is in by default.
  async function detectWebGPU(scope) {
    var s = scope || global;
    var navigator = s.navigator || {};
    var gpu = navigator.gpu;
    var base = { present: false, adapter: null, adapterInfo: null, features: [], limits: {}, reason: null };
    if (!gpu) {
      base.reason = 'navigator.gpu is undefined'
        + (isSecureContext(s) === false ? ' (and the context is NOT secure — a secure context such as http://127.0.0.1 is required)' : '');
      base.status = WEBGPU_STATUS.ABSENT;
      return base;
    }
    base.present = true;
    if (typeof gpu.requestAdapter !== 'function') {
      base.status = WEBGPU_STATUS.ABSENT;
      base.reason = 'navigator.gpu exposes no requestAdapter()';
      return base;
    }
    var adapter = null;
    try {
      adapter = await gpu.requestAdapter();
    } catch (err) {
      adapter = null;
      base.reason = 'requestAdapter() rejected: ' + (err && err.message ? err.message : String(err));
    }
    if (!adapter) {
      base.status = WEBGPU_STATUS.API_PRESENT_NO_ADAPTER;
      if (!base.reason) {
        base.reason = 'navigator.gpu is present but requestAdapter() returned null — '
          + 'the API is exposed and NO ADAPTER was granted (no hardware adapter, or the GPU is '
          + 'blocklisted/disabled). `navigator.gpu !== undefined` is NOT sufficient to choose '
          + 'the WebGPU tier.';
      }
      return base;
    }
    base.adapter = {
      isFallbackAdapter: !!(adapter.isFallbackAdapter),
      // `info` is the current spec surface; `requestAdapterInfo()` was the older
      // async one. Both are read, and either may be empty on some builds.
      info: adapterInfoOf(adapter)
    };
    if (!base.adapter.info && typeof adapter.requestAdapterInfo === 'function') {
      try { base.adapter.info = await adapter.requestAdapterInfo(); } catch (_) { /* none */ }
    }
    base.adapterInfo = base.adapter.info;
    base.features = featuresOf(adapter);
    base.limits = limitsOf(adapter);
    base.status = WEBGPU_STATUS.ADAPTER_AVAILABLE;
    return base;
  }

  // --- the report, and the ONLY legitimate way to pick a tier --------------------
  async function detect(scope) {
    var s = scope || global;
    var report = detectSync(s);
    report.webgpu = await detectWebGPU(s);
    return report;
  }

  // `selectTier` reads the AWAITED report and nothing else. It does NOT consult
  // `navigator.gpu` — that presence check is exactly the trap this file encodes.
  function selectTier(report) {
    if (!report) return TIERS.CPU;
    var gpu = report.webgpu;
    if (gpu && gpu.status === WEBGPU_STATUS.ADAPTER_AVAILABLE) return TIERS.WEBGPU;
    if (report.webgl2 || report.webgl1) {
      return report.oesTextureFloat ? TIERS.WEBGL_PERTURBATION : TIERS.WEBGL_PLAIN;
    }
    return TIERS.CPU;
  }

  global.FractalCapabilities = Object.freeze({
    PROBE_VERSION: PROBE_VERSION,
    WEBGPU_STATUS: WEBGPU_STATUS,
    TIERS: TIERS,
    detect: detect,
    detectSync: detectSync,
    detectWebGPU: detectWebGPU,
    selectTier: selectTier,
    // Exposed so a caller (and the spec) can compute "how many orbit samples does
    // this machine's storage buffer allow" without restating the element size.
    storageBufferOrbitCapacity: function (report) {
      var limits = (report && report.webgpu && report.webgpu.limits) || {};
      var bytes = num(limits.maxStorageBufferBindingSize, 0);
      // one reference-orbit sample is a vec2<f32> = 8 bytes in the probe's layout.
      return bytes > 0 ? Math.floor(bytes / 8) : 0;
    }
  });
})(typeof self !== 'undefined' ? self : globalThis);
