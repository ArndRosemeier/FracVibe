// Use ESM imports for all modules
import { FractalViewer } from './fractalViewer.js';
import { Fractal3DViewer } from './fractal3d.js';
import { FractalEngine } from './fractalEngineMain.js';

const canvas = document.getElementById('fractalCanvas');
const infoElem = document.getElementById('info');
const typeSelect = document.getElementById('fractalType');
const colorSchemeSelect = document.getElementById('colorScheme');
const cycleColorsCheckbox = document.getElementById('cycleColors');
const maxIterSlider = document.getElementById('maxIter');
const maxIterValue = document.getElementById('maxIterValue');

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

// Progressive rendering state
let progressiveState = null;

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
  startFractalCalculation();
});

function startFractalCalculation() {
  // Start with a coarse gridStep for fast preview
  let gridStep = 8;
  let prior = null;
  let width = viewer.width, height = viewer.height;
  let params = viewer.fractalType === 'julia' ? viewer.juliaParams : {};
  let thisToken = ++calcToken;

  progressiveState = {
    calcToken: thisToken,
    jobParams: {
      type: viewer.fractalType,
      width,
      height,
      view: viewer.view,
      maxIter: viewer.maxIter,
      colorScheme: viewer.colorScheme,
      colorOffset: viewer.colorOffset,
      params,
      gridStep,
      prior
    }
  };

  sendProgressiveJob();
}

function sendProgressiveJob() {
  if (!progressiveState) return;
  worker.postMessage({ ...progressiveState.jobParams, calcToken: progressiveState.calcToken });
}

worker.onmessage = function(e) {
  // Only process latest progressive sequence
  if (!progressiveState || e.data.calcToken !== progressiveState.calcToken) return;
  if (e.data.type === 'done') {
    // Always wrap the buffer as Int32Array
    let intResult = new Int32Array(e.data.result);
    viewer.setData(intResult, viewer.maxIter);
    // Refine further if possible
    let { gridStep } = progressiveState.jobParams;
    if (gridStep > 1) {
      let nextStep = Math.floor(gridStep / 2);
      progressiveState.jobParams.gridStep = nextStep;
      progressiveState.jobParams.prior = intResult;
      sendProgressiveJob();
    } else {
      // Done, clear state
      progressiveState = null;
    }
  }
};

// --- Robust interrupt & restart logic for pan/zoom ---
viewer.setOnViewChange(() => {
  // Abort current calculation immediately
  if (worker) worker.postMessage({type: 'abort'});
  // Increment token to invalidate old results
  calcToken++;
  // Start a new calculation for the new view
  startFractalCalculation();
});

// Initial calculation
startFractalCalculation();

window.addEventListener('resize', () => {
  viewer.resize();
  startFractalCalculation();
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

// Set initial slider value and display
maxIterSlider.value = viewer.maxIter;
maxIterValue.textContent = viewer.maxIter;

maxIterSlider.addEventListener('input', () => {
  viewer.maxIter = parseInt(maxIterSlider.value, 10);
  maxIterValue.textContent = viewer.maxIter;
  startFractalCalculation();
});
