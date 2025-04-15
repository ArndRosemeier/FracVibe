// Import color schemes (as ESM)
import { colorSchemes } from './colorSchemes.js';

// FractalViewer: Handles canvas rendering, pan/zoom, and partial data display
function FractalViewer(canvas, infoCallback) {
  this.canvas = canvas;
  this.ctx = canvas.getContext('2d');
  this.infoCallback = infoCallback;
  this.width = canvas.width = window.innerWidth;
  this.height = canvas.height = window.innerHeight;
  this.view = { centerX: -0.5, centerY: 0, scale: 3 };
  this.imageData = null; // Int32Array of iterations
  this.maxIter = 256;
  this.fractalType = 'mandelbrot';
  this.juliaParams = { c: [-0.4, 0.6] };
  this.colorScheme = 'rainbow';
  this.colorOffset = 0;
  this.dragging = false;
  this.lastMouse = null;
  this.setupEvents();
  window.addEventListener('resize', () => this.resize());
}

FractalViewer.prototype.resize = function() {
  this.width = this.canvas.width = window.innerWidth;
  this.height = this.canvas.height = window.innerHeight;
  this.render();
};

FractalViewer.prototype.setFractal = function(type, params) {
  this.fractalType = type;
  if (params) this.juliaParams = params;
};

FractalViewer.prototype.setView = function(view) {
  this.view = { ...view };
  this.render();
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

FractalViewer.prototype.setupEvents = function() {
  this.canvas.addEventListener('mousedown', e => {
    this.dragging = true;
    this.lastMouse = { x: e.clientX, y: e.clientY };
    this.canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', e => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastMouse.x;
    const dy = e.clientY - this.lastMouse.y;
    this.lastMouse = { x: e.clientX, y: e.clientY };
    // Pan view
    const scale = this.view.scale;
    const aspect = this.width / this.height;
    this.view.centerX -= dx * scale / this.width * aspect;
    this.view.centerY -= dy * scale / this.height;
    this.render();
    if (this.infoCallback) this.infoCallback(this.view);
    if (this.onViewChange) this.onViewChange(this.view);
  });
  window.addEventListener('mouseup', () => {
    if (this.dragging) {
      this.dragging = false;
      this.canvas.style.cursor = 'grab';
    }
  });
  this.canvas.addEventListener('wheel', e => {
    e.preventDefault();
    // Invert zoom direction: wheel up zooms in
    const zoom = Math.exp(e.deltaY * 0.001);
    this.view.scale *= zoom;
    this.render();
    if (this.infoCallback) this.infoCallback(this.view);
    if (this.onViewChange) this.onViewChange(this.view);
  });
  this.canvas.style.cursor = 'grab';
};

FractalViewer.prototype.render = function() {
  if (!this.imageData) {
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
  const img = this.ctx.createImageData(this.width, this.height);
  const buf32 = new Uint32Array(img.data.buffer);
  for (let i = 0; i < this.width * this.height; ++i) {
    const iter = this.imageData[i];
    if (iter === -1) {
      buf32[i] = lut[this.maxIter + 1];
    } else {
      buf32[i] = lut[iter];
    }
  }
  this.ctx.putImageData(img, 0, 0);
};

FractalViewer.prototype.iterToColor = function(iter, maxIter) {
  if (iter === maxIter) return [0,0,0];
  let t = iter / maxIter;
  t = (t + this.colorOffset) % 1;
  const fn = colorSchemes[this.colorScheme] || colorSchemes.rainbow;
  return fn(t);
};

export { FractalViewer };
