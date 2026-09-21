importScripts('fractalEngine.js');

// --- S2: progressive refinement that is actually visible -------------------------
// The job is one gridStep 8 -> 4 -> 2 -> 1 refinement sequence over a SINGLE buffer.
// Every level posts a real frame with the whole buffer (copied, not transferred, so
// the worker keeps ownership and the loop can continue), so the main thread can
// apply all four images and the render visibly converges. Before S2 the worker
// posted only 'progress' with no pixels at all, and app.js handled only 'done', so
// every intermediate frame was computed and thrown away.
//
// Cancellation is NOT this flag: a message cannot be delivered while this loop is
// running, so app.js cancels by terminating this worker outright. `abortFlag` is
// kept for the genuine between-jobs case, and posting 'abort' still clears it.
let abortFlag = false;

// The grid coordinates of a level, exactly the ones calcFractalChunk will visit.
function levelIndices(width, height, gridStep) {
  const indices = [];
  for (let y = 0; y < height; y += gridStep) {
    for (let x = 0; x < width; x += gridStep) {
      indices.push(y * width + x);
    }
  }
  return indices;
}

onmessage = function(e) {
  if (e.data && e.data.type === 'abort') {
    abortFlag = true;
    return;
  }
  abortFlag = false;
  const job = e.data;
  const width = job.width, height = job.height;
  const levels = [8, 4, 2, 1].filter((step) => step <= Math.max(1, job.gridStep));
  if (levels.length === 0) levels.push(1);

  // ONE buffer for the whole sequence. Pixels not yet computed stay -1, which the
  // viewer paints as the "uncalculated" colour, so a partial frame is honest about
  // what is still missing instead of smearing the previous level.
  const result = job.prior ? job.prior.slice() : new Int32Array(width * height).fill(-1);
  const chunkSize = 4096;

  for (let l = 0; l < levels.length; l++) {
    const gridStep = levels[l];
    const indices = levelIndices(width, height, gridStep);
    const jobForLevel = { ...job, gridStep, chunk: null };
    for (let offset = 0; offset < indices.length; offset += chunkSize) {
      if (abortFlag) return;
      jobForLevel.chunk = indices.slice(offset, offset + chunkSize);
      self.calcFractalChunk(jobForLevel, result);
    }
    const isFinal = l === levels.length - 1;
    // The final level transfers the buffer; every earlier level copies it. The
    // token travels with every frame so the main thread can drop a stale one.
    const msg = {
      type: isFinal ? 'done' : 'progress',
      result: result.buffer,
      gridStep,
      calcToken: job.calcToken
    };
    if (isFinal) postMessage(msg, [result.buffer]);
    else postMessage(msg);
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
