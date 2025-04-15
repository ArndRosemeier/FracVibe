// Main-thread FractalEngine for 3D viewer
// Uses same logic as worker, but runs synchronously in main thread

function calculateHeightmap(width, height, params) {
  const { type, view, maxIter, juliaParams, exaggeration = 0.07 } = params;
  const aspect = width / height;
  const scale = view.scale;
  const centerX = view.centerX;
  const centerY = view.centerY;
  const heights = new Float32Array(width * height);
  let c_julia_x = 0, c_julia_y = 0;
  if (type === 'julia' && juliaParams && juliaParams.c) {
    c_julia_x = juliaParams.c[0];
    c_julia_y = juliaParams.c[1];
  }
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      let cx = centerX + (x - width / 2) * scale / width * aspect;
      let cy = centerY + (y - height / 2) * scale / height;
      let zx, zy;
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
      let iter = 0;
      let escape = false;
      while (iter < maxIter) {
        let zx2 = zx * zx, zy2 = zy * zy;
        if (zx2 + zy2 > 4) { escape = true; break; }
        if (type === 'mandelbrot') {
          zy = 2 * zx * zy + cy;
          zx = zx2 - zy2 + cx;
        } else if (type === 'julia') {
          zy = 2 * zx * zy + cy;
          zx = zx2 - zy2 + cx;
        } else if (type === 'burningship') {
          zy = Math.abs(2 * zx * zy) + cy;
          zx = zx2 - zy2 + cx;
          zx = Math.abs(zx);
          zy = Math.abs(zy);
        } else if (type === 'tricorn') {
          zy = -2 * zx * zy + cy;
          zx = zx2 - zy2 + cx;
        }
        ++iter;
      }
      // Height: 0 for inside, log-scaled for outside
      let h = 0;
      if (escape) {
        h = Math.log(iter + 1) / Math.log(maxIter + 1);
      }
      heights[y * width + x] = h * exaggeration;
    }
  }
  return heights;
}

export const FractalEngine = { calculateHeightmap };
// Also attach to window/globalThis for classic script compatibility
if (typeof window !== 'undefined') window.FractalEngine = FractalEngine;
if (typeof globalThis !== 'undefined') globalThis.FractalEngine = FractalEngine;
