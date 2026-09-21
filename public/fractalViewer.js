// Import color schemes (as ESM)
import { colorSchemes } from './colorSchemes.js';

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
  this.imageData = null; // Int32Array of iterations
  this.maxIter = 512;
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
  this.render();
  if (this.infoCallback) this.infoCallback(this.view);
  if (clamped && this.onZoomLimit) this.onZoomLimit(this.view);
};

FractalViewer.prototype.setData = function(iterArray, maxIter) {
  this.imageData = iterArray;
  this.maxIter = maxIter;
  this.render();
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
  this.render();
  if (this.infoCallback) this.infoCallback(this.view);
  if (clamped && this.onZoomLimit) this.onZoomLimit(this.view);
  if (this.onViewChange) this.onViewChange(this.view);
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
  // --- FAST COLOR LOOKUP TABLE OPTIMIZATION ---
  // Precompute color LUT for all possible iteration values
  const lut = new Uint32Array(this.maxIter + 2); // +1 for maxIter (black), +1 for -1 (uncalculated)
  const toRGBA = (r, g, b, a=255) => (a << 24) | (b << 16) | (g << 8) | r;
  for (let i = 0; i <= this.maxIter; ++i) {
    if (i === this.maxIter) {
      lut[i] = toRGBA(0, 0, 0, 255); // Inside set = black
    } else {
      const color = this.iterToColor(i, this.maxIter);
      lut[i] = toRGBA(color[0], color[1], color[2], 255);
    }
  }
  lut[this.maxIter + 1] = toRGBA(40, 40, 40, 255); // -1 (uncalculated)

  // Use Uint32Array view for fast pixel writes
  try {
    const img = this.ctx.createImageData(this.width, this.height);
    const buf32 = new Uint32Array(img.data.buffer);
    for (let i = 0; i < this.width * this.height; ++i) {
      const iter = this.imageData[i];
      if (iter === -1) {
        buf32[i] = lut[this.maxIter + 1];
      } else {
        buf32[i] = lut[iter] !== undefined ? lut[iter] : lut[this.maxIter + 1];
      }
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

FractalViewer.prototype.iterToColor = function(iter, maxIter) {
  if (iter === maxIter) return [0,0,0];
  let t = iter / maxIter;
  t = (t + this.colorOffset) % 1;
  const fn = colorSchemes[this.colorScheme] || colorSchemes.rainbow;
  return fn(t);
};

export { FractalViewer };
