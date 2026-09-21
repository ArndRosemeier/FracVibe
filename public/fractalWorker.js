// The worker is CLASSIC (app.js: `new Worker('fractalWorker.js')`), so the kernel
// it loads must be a classic script. public/fractalKernel.js deliberately has no
// import/export, so this same file is also a valid ES module for the main thread
// (see the header of that file and docs/DECISIONS.md row 14).
importScripts('fractalKernel.js');

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
      self.FractalKernel.calcFractalChunk(jobForLevel, result);
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
