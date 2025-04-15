importScripts('fractalEngine.js');

let abortFlag = false;

onmessage = function(e) {
  if (e.data.type === 'abort') {
    abortFlag = true;
    return;
  }
  abortFlag = false;
  const job = e.data;
  let result = job.prior ? job.prior.slice() : new Int32Array(job.width * job.height).fill(-1);
  const width = job.width, height = job.height;
  const gridStep = job.gridStep;
  // Aggressively batch indices to minimize overhead
  let indices = [];
  for (let y = 0; y < height; y += gridStep) {
    for (let x = 0; x < width; x += gridStep) {
      const idx = y * width + x;
      if (result[idx] === -1) indices.push(idx);
    }
  }
  const chunkSize = Math.max(4096, Math.floor(indices.length / 8));
  let offset = 0;
  function checkAbort() { return abortFlag; }
  function sendProgress(start, end) {
    postMessage({type: 'progress', start, end, calcToken: job.calcToken});
  }
  while (offset < indices.length && !checkAbort()) {
    const chunk = indices.slice(offset, offset + chunkSize);
    self.calcFractalChunk({ ...job, chunk }, result);
    offset += chunkSize;
    sendProgress(offset - chunkSize, Math.min(offset, indices.length));
  }
  if (!checkAbort()) {
    // Transfer buffer for max speed, and include calcToken
    postMessage({type: 'done', result: result.buffer, calcToken: job.calcToken}, [result.buffer]);
  }
};

// Helper for chunked calculation
self.calcFractalChunk = function(job, result) {
  const width = job.width, height = job.height;
  const chunk = job.chunk;
  const type = job.type;
  const maxIter = job.maxIter;
  const bailout = 4;
  const view = job.view;
  const params = job.params;
  const aspect = width / height;
  const scale = view.scale;
  let c_julia_x, c_julia_y;
  if (type === 'julia' && params && params.c) {
    c_julia_x = params.c[0];
    c_julia_y = params.c[1];
  }
  for (let i = 0; i < chunk.length; ++i) {
    const idx = chunk[i];
    if (result[idx] !== -1) continue;
    // Inline pixelToCoord
    const x = idx % width;
    const y = Math.floor(idx / width);
    let cx = view.centerX + (x - width/2) * scale / width * aspect;
    let cy = view.centerY + (y - height/2) * scale / height;
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
      iter++;
    }
    result[idx] = escape ? iter : maxIter;
  }
};
