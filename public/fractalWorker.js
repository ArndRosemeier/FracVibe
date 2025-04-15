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
  for (const idx of chunk) {
    if (result[idx] !== -1) continue;
    let zx, zy, cx, cy;
    [cx, cy] = pixelToCoord(idx % width, Math.floor(idx / width), width, height, job.view);
    if (job.type === 'mandelbrot') {
      zx = 0; zy = 0;
    } else if (job.type === 'julia') {
      zx = cx; zy = cy; [cx, cy] = job.params.c;
    } else if (job.type === 'burningship') {
      zx = 0; zy = 0;
    } else if (job.type === 'tricorn') {
      zx = 0; zy = 0;
    } else {
      zx = 0; zy = 0;
    }
    let iter = 0;
    let escape = false;
    while (iter < job.maxIter) {
      let zx2 = zx*zx, zy2 = zy*zy;
      if (zx2 + zy2 > 4) { escape = true; break; }
      if (job.type === 'mandelbrot') {
        zy = 2*zx*zy + cy;
        zx = zx2 - zy2 + cx;
      } else if (job.type === 'julia') {
        zy = 2*zx*zy + cy;
        zx = zx2 - zy2 + cx;
      } else if (job.type === 'burningship') {
        zy = Math.abs(2*zx*zy) + cy;
        zx = zx2 - zy2 + cx;
        zx = Math.abs(zx);
        zy = Math.abs(zy);
      } else if (job.type === 'tricorn') {
        zy = -2*zx*zy + cy;
        zx = zx2 - zy2 + cx;
      }
      iter++;
    }
    result[idx] = escape ? iter : job.maxIter;
  }
};

function pixelToCoord(x, y, width, height, view) {
  const aspect = width / height;
  const scale = view.scale;
  const cx = view.centerX + (x - width/2) * scale / width * aspect;
  const cy = view.centerY + (y - height/2) * scale / height;
  return [cx, cy];
}
