// Aggressively optimized fractal engine for use in Web Worker
// All hot paths are tight loops, minimal allocations, and pre-hoisted type logic

function createFractalJob({type, width, height, view, maxIter, prior, gridStep, params, chunk}) {
  // type: 'mandelbrot', 'julia', etc.
  // prior: previous result array or null
  // gridStep: current refinement step (e.g., 8, 4, 2, 1)
  // params: e.g. julia c value
  // chunk: array of indices to calculate
  return { type, width, height, view, maxIter, prior, gridStep, params, chunk };
}

function calcFractalChunk(job, result) {
  const width = job.width, height = job.height;
  const type = job.type;
  const maxIter = job.maxIter;
  const bailout = 4;
  const view = job.view;
  const params = job.params;
  const chunk = job.chunk;
  const aspect = width / height;
  const scale = view.scale;
  let cx, cy, zx, zy, zx2, zy2, iter, escape;
  let c_julia_x, c_julia_y;
  if (type === 'julia' && params && params.c) {
    c_julia_x = params.c[0];
    c_julia_y = params.c[1];
  }
  for (let i = 0; i < chunk.length; ++i) {
    const idx = chunk[i];
    if (result[idx] !== -1) continue;
    const x = idx % width, y = (idx / width) | 0;
    cx = view.centerX + (x - width/2) * scale / width * aspect;
    cy = view.centerY + (y - height/2) * scale / height;
    if (type === 'mandelbrot') {
      zx = 0; zy = 0;
    } else if (type === 'julia') {
      zx = cx; zy = cy; cx = c_julia_x; cy = c_julia_y;
    } else if (type === 'burningship') {
      zx = 0; zy = 0;
    } else if (type === 'tricorn') {
      zx = 0; zy = 0;
    } else {
      zx = 0; zy = 0;
    }
    iter = 0;
    escape = false;
    while (iter < maxIter) {
      zx2 = zx*zx; zy2 = zy*zy;
      if (zx2 + zy2 > bailout) { escape = true; break; }
      if (type === 'mandelbrot') {
        zy = 2*zx*zy + cy;
        zx = zx2 - zy2 + cx;
      } else if (type === 'julia') {
        zy = 2*zx*zy + cy;
        zx = zx2 - zy2 + cx;
      } else if (type === 'burningship') {
        zy = Math.abs(2*zx*zy) + cy;
        zx = zx2 - zy2 + cx;
        zx = Math.abs(zx);
        zy = Math.abs(zy);
      } else if (type === 'tricorn') {
        zy = -2*zx*zy + cy;
        zx = zx2 - zy2 + cx;
      }
      ++iter;
    }
    result[idx] = escape ? iter : maxIter;
  }
  // No object allocation, just return indices and values
  return null;
}

function pixelToCoord(x, y, width, height, view) {
  // view: {centerX, centerY, scale}
  const aspect = width / height;
  const scale = view.scale;
  const cx = view.centerX + (x - width/2) * scale / width * aspect;
  const cy = view.centerY + (y - height/2) * scale / height;
  return [cx, cy];
}

// Expose globally for worker
self.createFractalJob = createFractalJob;
self.calcFractalChunk = calcFractalChunk;
self.pixelToCoord = pixelToCoord;
