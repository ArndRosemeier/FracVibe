// FractalViewer must be loaded as classic script, so we assume it is globally available

const canvas = document.getElementById('fractalCanvas');
const infoElem = document.getElementById('info');
const typeSelect = document.getElementById('fractalType');

let viewer = new FractalViewer(canvas, updateInfo);
let worker = new Worker('fractalWorker.js');
let currentResult = null;
let aborting = false;
let calcToken = 0; // Used to match results to the latest view
let debounceTimer = null;
let lastJobParams = null; // Store last parameters for progressive refinement

function updateInfo(view) {
  infoElem.textContent = `Center: (${view.centerX.toFixed(5)}, ${view.centerY.toFixed(5)})  Zoom: ${(1/view.scale).toFixed(2)}`;
}

typeSelect.addEventListener('change', () => {
  viewer.setFractal(typeSelect.value);
  startCalculation();
});

function startCalculationDebounced() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    startCalculation();
  }, 100);
}

function startCalculation() {
  abortCurrent();
  const width = viewer.width, height = viewer.height;
  const view = { ...viewer.view }; // capture current view
  const maxIter = viewer.maxIter;
  const type = viewer.fractalType;
  const params = type === 'julia' ? viewer.juliaParams : {};
  let prior = null; // always start fresh for new view
  let gridStep = 8;
  currentResult = new Int32Array(width * height).fill(-1);
  calcToken++;
  lastJobParams = {type, width, height, view, maxIter, params, gridStep};
  progressiveCalc({type, width, height, view, maxIter, prior, gridStep, params, calcToken});
}

function progressiveCalc(job) {
  if (job.gridStep < 1) return;
  // Always use the latest view and token for each refinement
  const {type, width, height, params} = lastJobParams;
  const view = { ...viewer.view };
  worker.postMessage({
    type, width, height, view, maxIter: job.maxIter, prior: job.prior, gridStep: job.gridStep, params, calcToken
  });
}

worker.onmessage = function(e) {
  if (e.data.type === 'progress') {
    // No-op: progress is now handled in big batches
  } else if (e.data.type === 'done') {
    // Only apply if view is still current
    if (e.data.result && (e.data.calcToken === calcToken)) {
      currentResult = new Int32Array(e.data.result);
      viewer.setData(currentResult, viewer.maxIter);
      // Refine further
      if (lastJobParams && lastJobParams.gridStep > 1) {
        const nextStep = Math.floor(lastJobParams.gridStep / 2);
        // Use the latest view and token for each refinement
        progressiveCalc({
          ...lastJobParams,
          prior: currentResult,
          gridStep: nextStep,
          calcToken
        });
        lastJobParams.gridStep = nextStep; // update for next refinement
      }
    }
  }
};

function abortCurrent() {
  if (worker) worker.postMessage({type: 'abort'});
  aborting = true;
}

// Pan/zoom triggers new calculation
document.addEventListener('mouseup', () => { startCalculation(); });
canvas.addEventListener('wheel', () => { updateInfo(viewer.view); startCalculationDebounced(); });

// Initial calculation
startCalculation();

window.addEventListener('resize', () => {
  viewer.resize();
  startCalculation();
});
