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
  });
  this.canvas.style.cursor = 'grab';
};

FractalViewer.prototype.render = function() {
  if (!this.imageData) {
    this.ctx.fillStyle = '#222';
    this.ctx.fillRect(0, 0, this.width, this.height);
    return;
  }
  // Render with magnification for missing data
  const img = this.ctx.createImageData(this.width, this.height);
  for (let y = 0; y < this.height; ++y) {
    for (let x = 0; x < this.width; ++x) {
      const idx = y * this.width + x;
      const iter = this.imageData[idx];
      let color;
      if (iter === -1) {
        // Uncalculated: show as dark gray
        color = [40, 40, 40];
      } else {
        color = this.iterToColor(iter, this.maxIter);
      }
      const p = idx * 4;
      img.data[p] = color[0];
      img.data[p+1] = color[1];
      img.data[p+2] = color[2];
      img.data[p+3] = 255;
    }
  }
  this.ctx.putImageData(img, 0, 0);
};

FractalViewer.prototype.iterToColor = function(iter, maxIter) {
  if (iter === maxIter) return [0,0,0];
  // Simple coloring: smooth gradient
  const t = iter / maxIter;
  const r = Math.floor(255 * t);
  const g = Math.floor(255 * (1-t));
  const b = Math.floor(128 + 127*Math.sin(6.28*t));
  return [r, g, b];
};

// Expose globally
window.FractalViewer = FractalViewer;
