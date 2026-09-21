// D1 removed this file's only use of the `colorSchemes` re-export: the palette now
// comes from the kernel's shared colour mapping, so the side-effect import below
// is the ONLY kernel dependency left here.
// The ONE kernel: iteration cap, type table, palette table (see that file). It is
// imported for its side effect because it deliberately has no `export`.
import './fractalKernel.js';
const FractalKernel = globalThis.FractalKernel;

// FractalViewer: Handles canvas rendering, pan/zoom, and partial data display
function FractalViewer(canvas, infoCallback) {
  this.canvas = canvas;
  this.ctx = canvas.getContext('2d');
  this.infoCallback = infoCallback;
  // width/height are the BACKING-STORE size in device pixels; cssWidth/cssHeight
  // are the CSS layout size. They differ whenever devicePixelRatio !== 1.
  this.width = 1;
  this.height = 1;
  this.cssWidth = 1;
  this.cssHeight = 1;
  // The ONE zoom clamp. null = unlimited. setZoomLimit() owns it; setView(),
  // onWheel() and the drag path all route through clampScale() so the cap is
  // applied ONCE, identically, no matter how the view was reached.
  this.zoomLimit = null;
  this.onZoomLimit = null;
  this.view = { centerX: -0.5, centerY: 0, scale: 3 };
  // D1: a Float32Array of SMOOTH (continuous) escape values, with NaN in the
  // cells the worker has not calculated yet (an Int32Array cannot hold the value).
  this.imageData = null;
  // D2: `maxIterFloor` is the USER's slider value and `maxIter` is the budget the
  // next job runs at. They differ when the zoom-derived floor raises the budget
  // above the slider (see refreshBudget and kernel.iterBudgetForScale); the frame
  // currently on screen is always indexed at `maxIter` (D1 pin 6).
  this.maxIterFloor = FractalKernel.clampMaxIter(512);
  this.maxIter = FractalKernel.effectiveMaxIter(this.maxIterFloor, this.view.scale);
  // D2: the colour table is built ONCE per (scheme, colour offset, cap) and reused;
  // `colorTableBuilds` counts the builds so "the table is not rebuilt per frame" is
  // measured, not inferred, and `_colorImage`/`_colorU32` reuse one ImageData and
  // its 32-bit view instead of allocating them on every render (MODERNIZATION.md's
  // per-frame-allocation finding). Both counters are read through `window.__fv`.
  this.colorTableBuilds = 0;
  this.colorImageDataBuilds = 0;
  this._colorTable = null;
  this._colorTableKey = null;
  this._colorImage = null;
  this._colorU32 = null;
  this.fractalType = 'mandelbrot';
  this.juliaParams = { c: [-0.4, 0.6] };
  this.colorScheme = 'rainbow';
  this.colorOffset = 0;
  this.dragging = false;
  this.lastMouse = null;
  this.setupEvents();
  // NOTE: there is deliberately NO window 'resize' listener here. app.js owns the
  // single resize path and calls resize() exactly once (S1/B4).
  this.resize();
}

// Size the backing store to CSS size x devicePixelRatio. Cached so a resize
// request with an unchanged geometry (e.g. a WebGL fallback) is not a layout hit.
FractalViewer.prototype.applyCanvasSize = function(cssWidth, cssHeight, dpr) {
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  this.cssWidth = cssWidth;
  this.cssHeight = cssHeight;
  this.width = w;
  this.height = h;
  if (this.canvas.width !== w) this.canvas.width = w;
  if (this.canvas.height !== h) this.canvas.height = h;
};

// Rebuild the backing store at the given CSS size. Does NOT render: the caller
// decides whether a re-render or a fresh calculation is wanted. The CSS size is
// the canvas's CSS box (100vw x 100vh), which equals the viewport; it is read
// from the window because a `display:none` canvas has a zero-sized box.
FractalViewer.prototype.resize = function(cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = cssWidth || window.innerWidth;
  const cssH = cssHeight || window.innerHeight;
  this.applyCanvasSize(cssW, cssH, dpr);
};

// The single clamp. Returns { scale, clamped }: `scale` is what must be stored,
// `clamped` is true only when this call actually HIT the cap (so the one-shot
// "you are at the GPU zoom limit" notification fires once per crossing).
FractalViewer.prototype.clampScale = function(scale) {
  if (this.zoomLimit == null) return { scale, clamped: false };
  if (scale < this.zoomLimit) return { scale: this.zoomLimit, clamped: true };
  return { scale, clamped: false };
};

FractalViewer.prototype.setFractal = function(type, params) {
  this.fractalType = type;
  if (params) this.juliaParams = params;
};

// The ONE place a zoom cap is declared. `minScale` is the smallest permitted
// view.scale; onLimitReached fires when a view actually hits it (app.js uses it
// to tell the user and offer the CPU renderer). Passing null removes the cap.
FractalViewer.prototype.setZoomLimit = function(minScale, onLimitReached) {
  this.zoomLimit = (typeof minScale === 'number' && minScale > 0) ? minScale : null;
  this.onZoomLimit = typeof onLimitReached === 'function' ? onLimitReached : null;
};

FractalViewer.prototype.setView = function(view) {
  const { scale, clamped } = this.clampScale(view.scale);
  this.view = { ...view, scale };
  this.refreshBudget();
  this.render();
  if (this.infoCallback) this.infoCallback(this.view);
  if (clamped && this.onZoomLimit) this.onZoomLimit(this.view);
};

// `iterArray` is a Float32Array of SMOOTH escape values with NaN marking the cells
// the worker has not reached yet (D1 — it used to be an Int32Array of integer
// counts with -1 as the sentinel).
FractalViewer.prototype.setData = function(iterArray, maxIter) {
  this.imageData = iterArray;
  this.maxIter = maxIter;
  this.render();
};

// The ONE way an iteration count is stored in the 2D viewer. The clamp lives in
// the kernel (public/fractalKernel.js), which also bounds the worker chunk, the
// 3D heightmap and the shader, so the UI, both CPU paths and the GPU cannot
// disagree about what "the cap" is (S3/B5). Returns the budget the next job will
// run at.
//
// D2: the value passed here is the USER's slider value and is kept as a FLOOR; the
// effective budget is the floor raised by the zoom (refreshBudget). The floor is
// what a saved record stores, and the zoom re-derives the effective budget from it
// on load — so a location saved at a deep view does not freeze a cap that a
// different zoom would make wrong.
FractalViewer.prototype.setMaxIter = function(value) {
  this.maxIterFloor = FractalKernel.clampMaxIter(value);
  this.refreshBudget();
  return this.maxIter;
};

// Recompute the effective budget from the user's floor and the current zoom. D2:
// the zoom-derived floor may raise the budget above the slider; MAX_ITER bounds
// both. Called on every path that changes the scale (setView, the wheel) and on
// setMaxIter, and NOT on setData — a finished frame is indexed at the cap its own
// job ran at (D1 pin 6), so `maxIter` is overwritten there, deliberately.
FractalViewer.prototype.refreshBudget = function() {
  this.maxIter = FractalKernel.effectiveMaxIter(this.maxIterFloor, this.view.scale);
  return this.maxIter;
};

FractalViewer.prototype.setColorScheme = function(scheme) {
  this.colorScheme = scheme;
  this.render();
};

FractalViewer.prototype.setColorOffset = function(offset) {
  this.colorOffset = offset;
  this.render();
};

FractalViewer.prototype.setOnViewChange = function(cb) {
  this.onViewChange = cb;
};

// --- SHARED VIEW STATE & GENERIC PAN/ZOOM ---
// These functions update any view object regardless of canvas
export function panView(view, dx, dy, width, height) {
  const scale = view.scale;
  const aspect = width / height;
  view.centerX -= dx * scale / width * aspect;
  view.centerY -= dy * scale / height;
}
export function zoomView(view, zoomFactor) {
  view.scale *= zoomFactor;
}

FractalViewer.prototype.setupEvents = function() {
  this.canvas.addEventListener('mousedown', e => {
    this.onMouseDown(e);
    this.canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', e => {
    this.onMouseMove(e);
  });
  window.addEventListener('mouseup', e => {
    this.onMouseUp(e);
  });
  this.canvas.addEventListener('wheel', e => {
    this.onWheel(e);
  });
  this.canvas.style.cursor = 'grab';
};

FractalViewer.prototype.onMouseDown = function(e) {
  this.dragging = true;
  this.lastMouse = { x: e.clientX, y: e.clientY };
};

FractalViewer.prototype.onMouseMove = function(e) {
  if (!this.dragging) return;
  const dx = e.clientX - this.lastMouse.x;
  const dy = e.clientY - this.lastMouse.y;
  this.lastMouse = { x: e.clientX, y: e.clientY };
  // Pan in CSS pixels (mouse deltas), not device pixels: the drag must move the
  // view by the same amount the pointer moved, at any devicePixelRatio.
  panView(this.view, dx, dy, this.cssWidth, this.cssHeight);
  this.render();
  if (this.infoCallback) this.infoCallback(this.view);
  if (this.onViewChange) this.onViewChange(this.view);
};

FractalViewer.prototype.onMouseUp = function(e) {
  this.dragging = false;
  this.canvas.style.cursor = 'grab';
};

FractalViewer.prototype.onWheel = function(e) {
  e.preventDefault();
  const zoom = Math.exp(e.deltaY * 0.001);
  zoomView(this.view, zoom);
  const { scale, clamped } = this.clampScale(this.view.scale);
  this.view.scale = scale;
  this.refreshBudget();
  this.render();
  if (this.infoCallback) this.infoCallback(this.view);
  if (clamped && this.onZoomLimit) this.onZoomLimit(this.view);
  if (this.onViewChange) this.onViewChange(this.view);
};

// Build the render's colour table. The table is over the SMOOTH value, at the
// kernel's ONE stride (COLORS_LUT_STRIDE steps per iteration of escape value), so
// it is a sampled version of the continuous mapping and NOT a staircase: the
// worst-case difference from the exact palette is half a stride step, under one
// 1/255 unit. It is also the ONLY place the palette is evaluated, so the pixel
// loop below is a lookup — the same shape the old integer LUT had, at a resolution
// that cannot alias. The uncalculated placeholder is the table's last index.
//
// D2: the table is sized by THIS frame's cap — `colorTableSize(maxIter)`, never the
// module MAXIMUM — and cached under (scheme, colour offset, cap), so a progressive
// job's 4 frames, a resize repaint or a repeated render do not rebuild it. The
// build count and the entry count are exposed (`colorTableBuilds`,
// `colorTableEntries`) so the cost claim is measured, and a key change still
// rebuilds (the cache is not a way to render the wrong palette).
FractalViewer.prototype.buildColorTable = function() {
  const cap = this.maxIter;
  const key = this.colorScheme + '|' + this.colorOffset + '|' + cap;
  if (this._colorTable && this._colorTableKey === key) return this._colorTable;
  const size = FractalKernel.colorTableSize(cap);
  // size real entries + 1 inside-the-set entry + 1 uncalculated-placeholder entry.
  const table = new Uint32Array(size + 2);
  for (let i = 0; i < size; ++i) {
    table[i] = FractalKernel.toRGBA(FractalKernel.colorAtLutIndex(i, cap, this.colorScheme, this.colorOffset));
  }
  // Entry `size` is exactly maxIter: the point never escaped, so it is black
  // (matching the GPU's `iter == u_maxIter` test), and index `size + 1` is the
  // "not yet calculated" placeholder — NaN is not a smooth value at all.
  table[size] = FractalKernel.toRGBA([0, 0, 0]);
  table[size + 1] = FractalKernel.toRGBA(FractalKernel.UNCALCULATED_COLOR);
  this._colorTable = table;
  this._colorTableKey = key;
  this.colorTableBuilds++;
  return table;
};

// The size in ENTRIES of the table the last build produced (null before any build).
// Read through `window.__fv` so the D2 pin can hold the allocation to the JOB's cap
// rather than the module maximum.
FractalViewer.prototype.colorTableEntries = function() {
  return this._colorTable ? this._colorTable.length : null;
};

FractalViewer.prototype.render = function() {
  // imageData belongs to the size that produced it; after a resize it is stale
  // until the next worker result, so fall back to the background instead of
  // reading past the end of the buffer.
  if (!this.imageData || this.imageData.length !== this.width * this.height) {
    this.ctx.fillStyle = '#222';
    this.ctx.fillRect(0, 0, this.width, this.height);
    return;
  }
  // --- D1: CONTINUOUS COLOUR, FROM THE ONE KERNEL MAPPING ---------------------
  // The pre-D1 table had ONE entry per INTEGER iteration and could not index a
  // Float32 value at all. The table built here is sampled over the continuous
  // value instead, so adjacent pixels whose smooth values differ by far less than
  // one iteration get adjacent — not equal-or-opposite — colours. That is what
  // removes the amplifier: a precision hop no longer moves a pixel across a whole
  // colour band (docs/DECISIONS.md row 27).
  const table = this.buildColorTable();
  const placeholderIndex = table.length - 1;
  const cap = this.maxIter;
  try {
    // D2: reuse ONE ImageData and its Uint32 view while the backing store size is
    // unchanged. Every entry is written below, so no stale pixel can survive. This
    // is the second half of MODERNIZATION.md's per-frame-allocation finding; the
    // build is counted so a regression to per-render allocation is measurable.
    let img = this._colorImage;
    if (!img || img.width !== this.width || img.height !== this.height) {
      img = this.ctx.createImageData(this.width, this.height);
      this._colorImage = img;
      this._colorU32 = new Uint32Array(img.data.buffer);
      this.colorImageDataBuilds++;
    }
    const buf32 = this._colorU32;
    for (let i = 0; i < buf32.length; ++i) {
      const value = this.imageData[i];
      // NaN is the "not yet calculated" sentinel (it used to be -1). It is NOT a
      // palette colour: it is the fixed placeholder. Every other value — including
      // exactly maxIter (inside the set, black) — takes its table entry.
      const index = value !== value ? -1 : FractalKernel.colorLutIndex(value, cap);
      buf32[i] = index < 0 ? table[placeholderIndex] : table[index];
    }
    this.ctx.putImageData(img, 0, 0);
  } catch (err) {
    // A canvas that cannot be painted must still show something, and the failure
    // must not escape as an uncaught exception.
    console.error('[FractalViewer] 2D render failed', err);
    try {
      this.ctx.fillStyle = '#222';
      this.ctx.fillRect(0, 0, this.width, this.height);
    } catch (_) { /* nothing left to do */ }
  }
};

// The colour of a value the viewer is holding, through the SAME table path the
// render writes (so a pin can compare the quantised table against the exact
// definition rather than restating either). NaN is the placeholder, exactly
// maxIter is inside-the-set black.
FractalViewer.prototype.colorForValue = function(value, maxIter) {
  const cap = FractalKernel.clampMaxIter(maxIter == null ? this.maxIter : maxIter);
  const index = value !== value ? -1 : FractalKernel.colorLutIndex(value, cap);
  return FractalKernel.colorAtLutIndex(index, cap, this.colorScheme, this.colorOffset);
};

// The colour of an ARBITRARY smooth value (not necessarily one the worker
// produced), through the kernel's exact continuous definition — the observable the
// colour-continuity pin needs. `value === maxIter` is the inside-the-set black.
FractalViewer.prototype.colorAtSmoothIteration = function(value, maxIter) {
  const cap = FractalKernel.clampMaxIter(maxIter == null ? this.maxIter : maxIter);
  if (value !== value) return FractalKernel.UNCALCULATED_COLOR.slice();
  return FractalKernel.colorAtSmoothIteration(value, cap, this.colorScheme, this.colorOffset);
};

export { FractalViewer };
