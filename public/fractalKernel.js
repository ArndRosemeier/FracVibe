// public/fractalKernel.js — THE fractal kernel.
//
// One source of truth for the iteration math, the iteration cap, the fractal-type
// table and the palette table. Everything that used to be a separate copy of this
// logic now reads it from here:
//
//   * the render worker           — `importScripts('fractalKernel.js')` (classic)
//   * the main thread (2D LUT)    — `import './fractalKernel.js'` via a side-effect
//   * the main thread (3D height) — the same import; `calculateHeightmap` below
//   * the fragment shader         — `webglFractal.js` templates this file's
//                                   constants and index tables into the GLSL
//                                   (GLSL ES 1.00 needs a constant loop bound,
//                                   so a uniform is not an option).
//
// WHY THERE IS NO `import` AND NO `export` IN THIS FILE (docs/DECISIONS.md row 14):
// the render worker is CLASSIC (`app.js` does `new Worker('fractalWorker.js')`),
// so its kernel must be loadable by `importScripts`, which cannot load an ES
// module. At the same time the main thread is ES-module-only. A file with no
// import/export statements is simultaneously a valid classic script and a valid
// ES module, so this ONE file serves both without a build step. It publishes
// exactly one frozen global, `globalThis.FractalKernel`.

(function () {
  'use strict';

  // --- the ONE iteration cap -------------------------------------------------
  // Every iteration bound in the app derives from this number and nothing else:
  // the slider's `max` attribute (app.js), the clamps in this kernel (worker chunk
  // and 3D heightmap), the shader's loop bound and the `u_maxIter` uniform clamp
  // (webglFractal.js). Before S3 the slider allowed 2000 while the shader looped
  // to a hardcoded 1024, so every pixel that needed more than 1024 iterations was
  // silently coloured as if it had escaped (finding B5).
  const MAX_ITER = 2000;
  const MIN_ITER = 1;
  const BAILOUT = 4;

  // --- the ONE fractal-type table --------------------------------------------
  // `index` is the shader's `u_fractalType`. `glsl` is the identifier that
  // webglFractal.js templates into the shader as `#define FT_<glsl> <index>`, so
  // the GLSL branch can never drift from this table. Order is owned HERE.
  const FRACTAL_TYPES = [
    { value: 'mandelbrot', label: 'Mandelbrot', index: 0, glsl: 'MANDELBROT' },
    { value: 'julia', label: 'Julia', index: 1, glsl: 'JULIA' },
    { value: 'burningship', label: 'Burning Ship', index: 2, glsl: 'BURNINGSHIP' },
    { value: 'tricorn', label: 'Tricorn', index: 3, glsl: 'TRICORN' }
  ];

  // --- the ONE palette table (names + implementations) -----------------------
  // t in [0,1], returns [r,g,b] in 0-255. These are the ONLY palette
  // implementations in the app; the GLSL keeps its own for the GPU (the one
  // documented exception), keyed off the `index`/`glsl` fields below.

  function rainbow(t) {
    const a = (1 - t) * 4;
    const X = Math.floor(a);
    const Y = Math.floor(255 * (a - X));
    switch (X) {
      case 0: return [0, Y, 255]; // blue->cyan
      case 1: return [0, 255, 255 - Y]; // cyan->green
      case 2: return [Y, 255, 0]; // green->yellow
      case 3: return [255, 255 - Y, 0]; // yellow->red
      default: return [255, 0, 0];
    }
  }

  function fire(t) {
    // Black -> red -> yellow -> white
    if (t < 0.33) return [Math.floor(255 * t * 3), 0, 0];
    if (t < 0.66) return [255, Math.floor(255 * (t - 0.33) * 3), 0];
    return [255, 255, Math.floor(255 * (t - 0.66) * 3)];
  }

  function ocean(t) {
    // Deep blue -> cyan -> white
    if (t < 0.5) return [0, Math.floor(255 * t * 2), Math.floor(128 + 127 * t * 2)];
    return [Math.floor(255 * (t - 0.5) * 2), 255, 255];
  }

  function grayscale(t) {
    const g = Math.floor(255 * t);
    return [g, g, g];
  }

  function viridis(t) {
    // Approximate viridis colormap
    const stops = [
      [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142],
      [33, 144, 141], [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37]
    ];
    const idx = Math.floor(t * (stops.length - 1));
    const frac = t * (stops.length - 1) - idx;
    if (idx >= stops.length - 1) return stops[stops.length - 1];
    const c0 = stops[idx], c1 = stops[idx + 1];
    return [
      Math.floor(c0[0] + (c1[0] - c0[0]) * frac),
      Math.floor(c0[1] + (c1[1] - c0[1]) * frac),
      Math.floor(c0[2] + (c1[2] - c0[2]) * frac)
    ];
  }

  const COLOR_SCHEMES = [
    { value: 'rainbow', label: 'Rainbow', index: 0, glsl: 'RAINBOW', fn: rainbow },
    { value: 'fire', label: 'Fire', index: 1, glsl: 'FIRE', fn: fire },
    { value: 'ocean', label: 'Ocean', index: 2, glsl: 'OCEAN', fn: ocean },
    { value: 'grayscale', label: 'Grayscale', index: 3, glsl: 'GRAYSCALE', fn: grayscale },
    { value: 'viridis', label: 'Viridis', index: 4, glsl: 'VIRIDIS', fn: viridis }
  ];

  // name -> function, the shape `fractalViewer.js` / `fractal3d.js` already use.
  const colorSchemes = {};
  COLOR_SCHEMES.forEach(function (s) { colorSchemes[s.value] = s.fn; });

  // --- the clamps: the ONE place an iteration count is bounded ----------------
  // The UI slider cannot exceed `MAX_ITER`, but a hostile or stale imported
  // location can carry any number, so every entry point clamps here.
  function clampMaxIter(value) {
    const n = Math.floor(Number(value));
    if (!isFinite(n)) return MIN_ITER;
    if (n < MIN_ITER) return MIN_ITER;
    if (n > MAX_ITER) return MAX_ITER;
    return n;
  }

  function findIndex(table, value) {
    for (let i = 0; i < table.length; ++i) {
      if (table[i].value === value) return table[i].index;
    }
    return table[0].index;
  }

  // The shader's `u_fractalType` for a type name.
  function indexForType(value) { return findIndex(FRACTAL_TYPES, value); }
  // The shader's `u_colorScheme` for a scheme name.
  function indexForColorScheme(value) { return findIndex(COLOR_SCHEMES, value); }
  // The palette function for a scheme name (2D and 3D CPU rendering).
  function paletteFunction(value) { return colorSchemes[value] || colorSchemes.rainbow; }

  // --- the iteration core -----------------------------------------------------
  // `px, py` are the point in the complex plane (already projected from the
  // pixel). For Julia the point is z0 and (jx, jy) is the constant c; for every
  // other type z0 = 0 and c = the point. Returns the iteration count; the return
  // value EQUALS maxIter exactly when the point never escaped (i.e. it is inside).
  function iteratePixel(type, px, py, maxIter, jx, jy) {
    let zx, zy, cx = px, cy = py;
    if (type === 'julia') {
      zx = px;
      zy = py;
      cx = jx;
      cy = jy;
    } else {
      zx = 0;
      zy = 0;
    }
    let iter = 0;
    while (iter < maxIter) {
      const zx2 = zx * zx, zy2 = zy * zy;
      if (zx2 + zy2 > BAILOUT) return iter;
      if (type === 'burningship') {
        zy = Math.abs(2 * zx * zy) + cy;
        zx = Math.abs(zx2 - zy2 + cx);
      } else if (type === 'tricorn') {
        zy = -2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
      } else {
        // Mandelbrot and Julia share the recurrence; only z0 / c differ.
        zy = 2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
      }
      ++iter;
    }
    return iter;
  }

  // Project a pixel to the complex plane. `view` is {centerX, centerY, scale}.
  function pixelToCoord(x, y, width, height, view) {
    const aspect = width / height;
    const scale = view.scale;
    const cx = view.centerX + (x - width / 2) * scale / width * aspect;
    const cy = view.centerY + (y - height / 2) * scale / height;
    return [cx, cy];
  }

  // --- the worker's entry point: fill the not-yet-computed entries of `chunk` --
  // `result` is an Int32Array of width*height whose computed entries hold an
  // iteration count and whose uncomputed entries hold -1 (progressive
  // refinement skips those already done).
  function calcFractalChunk(job, result) {
    const width = job.width, height = job.height;
    const type = job.type;
    const maxIter = clampMaxIter(job.maxIter);
    const view = job.view;
    const params = job.params || {};
    const chunk = job.chunk;
    const aspect = width / height;
    const scale = view.scale;
    let jx = 0, jy = 0;
    if (type === 'julia' && params.c) {
      jx = params.c[0];
      jy = params.c[1];
    }
    for (let i = 0; i < chunk.length; ++i) {
      const idx = chunk[i];
      if (result[idx] !== -1) continue;
      const x = idx % width;
      const y = (idx / width) | 0;
      const cx = view.centerX + (x - width / 2) * scale / width * aspect;
      const cy = view.centerY + (y - height / 2) * scale / height;
      result[idx] = iteratePixel(type, cx, cy, maxIter, jx, jy);
    }
    return null;
  }

  // --- the main thread's entry point: the 3D heightmap ------------------------
  // Same iteration core, same clamp; only the output shape differs. Height is 0
  // inside the set and log-scaled outside it, exactly as before.
  function calculateHeightmap(width, height, params) {
    const type = params.type;
    const view = params.view;
    const maxIter = clampMaxIter(params.maxIter);
    const exaggeration = params.exaggeration == null ? 0.07 : params.exaggeration;
    const juliaParams = params.juliaParams;
    let jx = 0, jy = 0;
    if (type === 'julia' && juliaParams && juliaParams.c) {
      jx = juliaParams.c[0];
      jy = juliaParams.c[1];
    }
    const aspect = width / height;
    const scale = view.scale;
    const centerX = view.centerX;
    const centerY = view.centerY;
    const heights = new Float32Array(width * height);
    const logDen = Math.log(maxIter + 1);
    for (let y = 0; y < height; ++y) {
      for (let x = 0; x < width; ++x) {
        const cx = centerX + (x - width / 2) * scale / width * aspect;
        const cy = centerY + (y - height / 2) * scale / height;
        const iter = iteratePixel(type, cx, cy, maxIter, jx, jy);
        const h = iter < maxIter ? Math.log(iter + 1) / logDen : 0;
        heights[y * width + x] = h * exaggeration;
      }
    }
    return heights;
  }

  // --- the ONE published global ----------------------------------------------
  FRACTAL_TYPES.forEach(Object.freeze);
  COLOR_SCHEMES.forEach(Object.freeze);
  const FractalKernel = Object.freeze({
    MAX_ITER: MAX_ITER,
    MIN_ITER: MIN_ITER,
    BAILOUT: BAILOUT,
    FRACTAL_TYPES: Object.freeze(FRACTAL_TYPES),
    COLOR_SCHEMES: Object.freeze(COLOR_SCHEMES),
    colorSchemes: Object.freeze(colorSchemes),
    clampMaxIter: clampMaxIter,
    indexForType: indexForType,
    indexForColorScheme: indexForColorScheme,
    paletteFunction: paletteFunction,
    iteratePixel: iteratePixel,
    pixelToCoord: pixelToCoord,
    calcFractalChunk: calcFractalChunk,
    calculateHeightmap: calculateHeightmap
  });
  globalThis.FractalKernel = FractalKernel;
})();
