// Use ESM imports for all modules
import { FractalViewer } from './fractalViewer.js';
import { Fractal3DViewer } from './fractal3d.js';
import { FractalEngine } from './fractalEngineMain.js';

const canvas = document.getElementById('fractalCanvas');
const infoElem = document.getElementById('info');
const typeSelect = document.getElementById('fractalType');
const colorSchemeSelect = document.getElementById('colorScheme');
const cycleColorsCheckbox = document.getElementById('cycleColors');

let viewer = new FractalViewer(canvas, updateInfo);
let worker = new Worker('fractalWorker.js');
let currentResult = null;
let aborting = false;
let calcToken = 0; // Used to match results to the latest view
let debounceTimer = null;
let lastJobParams = null; // Store last parameters for progressive refinement

// --- 3D Mode Integration ---
let fractal3D = null;
let in3DMode = false;

let colorCycleActive = false;
let colorCycleOffset = 0;
let colorCycleLastTime = 0;
let colorCycleRequestId = null;

function getFractalParams() {
  // Returns the current fractal parameters for 3D
  return {
    type: viewer.fractalType,
    view: { ...viewer.view },
    maxIter: viewer.maxIter,
    juliaParams: { ...viewer.juliaParams }
  };
}

function enter3DMode() {
  if (in3DMode) return;
  in3DMode = true;
  fractal3D = new Fractal3DViewer(document.body, FractalEngine, getFractalParams);
  fractal3D.init();
  canvas.style.display = 'none';
  infoElem.style.display = 'none';
}

function exit3DMode() {
  if (!in3DMode) return;
  in3DMode = false;
  if (fractal3D) fractal3D.exit();
  fractal3D = null;
  canvas.style.display = '';
  infoElem.style.display = '';
}

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

window.addEventListener('keydown', e => {
  if (e.code === 'Space') {
    if (!in3DMode) {
      enter3DMode();
    } else {
      exit3DMode();
    }
    e.preventDefault();
  }
});

// Set color scheme from dropdown
colorSchemeSelect.addEventListener('change', () => {
  viewer.setColorScheme(colorSchemeSelect.value);
  if (fractal3D && fractal3D.setColorScheme) {
    fractal3D.setColorScheme(colorSchemeSelect.value);
  }
});

// Set initial color scheme
viewer.setColorScheme(colorSchemeSelect.value);

function colorCycleLoop(ts) {
  if (!colorCycleActive) return;
  if (!colorCycleLastTime) colorCycleLastTime = ts;
  const dt = (ts - colorCycleLastTime) / 1000;
  colorCycleLastTime = ts;
  // Cycle at 0.1 offset per second
  colorCycleOffset = (colorCycleOffset + dt * 0.1) % 1;
  viewer.setColorOffset(colorCycleOffset);
  if (fractal3D && fractal3D.setColorOffset) {
    fractal3D.setColorOffset(colorCycleOffset);
  }
  colorCycleRequestId = requestAnimationFrame(colorCycleLoop);
}

cycleColorsCheckbox.addEventListener('change', () => {
  if (cycleColorsCheckbox.checked) {
    colorCycleActive = true;
    colorCycleLastTime = 0;
    colorCycleRequestId = requestAnimationFrame(colorCycleLoop);
  } else {
    colorCycleActive = false;
    if (colorCycleRequestId) cancelAnimationFrame(colorCycleRequestId);
    colorCycleOffset = 0;
    viewer.setColorOffset(0);
    if (fractal3D && fractal3D.setColorOffset) {
      fractal3D.setColorOffset(0);
    }
  }
});

// On startup, ensure offset is zero
viewer.setColorOffset(0);
if (fractal3D && fractal3D.setColorOffset) fractal3D.setColorOffset(0);
