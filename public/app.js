// Use ESM imports for all modules
import { FractalViewer } from './fractalViewer.js';
import { Fractal3DViewer } from './fractal3d.js';
import { FractalEngine } from './fractalEngineMain.js';
import { WebGLFractalRenderer } from './webglFractal.js';

const canvas = document.getElementById('fractalCanvas');
const canvasWebGL = document.getElementById('fractalCanvasWebGL');
const infoElem = document.getElementById('info');
const typeSelect = document.getElementById('fractalType');
const colorSchemeSelect = document.getElementById('colorScheme');
const cycleColorsCheckbox = document.getElementById('cycleColors');
const maxIterSlider = document.getElementById('maxIter');
const maxIterValue = document.getElementById('maxIterValue');
const webglCheckbox = document.getElementById('webglRender');
const renderTimeElem = document.getElementById('renderTime');

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

let colorCycleActive = true;
let colorCycleOffset = 0;
let colorCycleLastTime = 0;
let colorCycleRequestId = null;

// Progressive rendering state
let progressiveState = null;

let webglRenderer = null;

let lastRenderStart = 0;
let lastRenderDuration = 0;

// --- Accurate Render Timing ---
let renderStartTime = 0;
function startFractalCalculationWithTiming() {
  renderStartTime = performance.now();
  startFractalCalculation();
}

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
  startFractalCalculationWithTiming();
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
    const duration = performance.now() - renderStartTime;
    setRenderTimeDisplay(duration);
  }
};

// --- Mouse event wrappers to delegate to viewer and update view state ---
function onMouseDown(e) {
  console.log('[FractalMouse] mousedown on', e.target.id, 'mode:', webglCheckbox.checked ? 'WebGL' : 'CPU');
  if (viewer && viewer.onMouseDown) viewer.onMouseDown(e);
}
function onWheel(e) {
  console.log('[FractalMouse] wheel (zoom) on', e.target.id, 'mode:', webglCheckbox.checked ? 'WebGL' : 'CPU');
  if (viewer && viewer.onWheel) viewer.onWheel(e);
}
function onMouseMove(e) {
  if (viewer && viewer.onMouseMove) viewer.onMouseMove(e);
}
function onMouseUp(e) {
  if (viewer && viewer.onMouseUp) viewer.onMouseUp(e);
}

function triggerFractalRender() {
  if (webglCheckbox.checked) {
    console.log('[FractalMouse] Trigger: renderWebGL()');
    renderWebGL();
  } else {
    console.log('[FractalMouse] Trigger: viewer.render()');
    viewer.render();
  }
}

function attachFractalMouseEvents(targetCanvas) {
  targetCanvas.addEventListener('mousedown', onMouseDown);
  targetCanvas.addEventListener('wheel', onWheel, { passive: false });
  targetCanvas.addEventListener('mousemove', onMouseMove);
  targetCanvas.addEventListener('mouseup', onMouseUp);
  targetCanvas.addEventListener('mouseleave', onMouseUp);
}
attachFractalMouseEvents(canvas);
attachFractalMouseEvents(canvasWebGL);

// --- Ensure view changes always trigger calculation ---
function onViewChangeHandler() {
  // Abort current calculation immediately
  if (worker) worker.postMessage({type: 'abort'});
  // Increment token to invalidate old results
  calcToken++;
  // Start a new calculation for the new view
  startFractalCalculationWithTiming();
  // Always trigger render in correct mode
  triggerFractalRender();
}
viewer.setOnViewChange(onViewChangeHandler);

// Set WebGL and color cycling as default
webglCheckbox.checked = true;
cycleColorsCheckbox.checked = true;
updateWebGLState();

// Start color cycling immediately if enabled
if (cycleColorsCheckbox.checked) {
  colorCycleActive = true;
  colorCycleLastTime = performance.now();
  colorCycleRequestId = requestAnimationFrame(colorCycleLoop);
}

// Initial calculation
startFractalCalculationWithTiming();

window.addEventListener('resize', () => {
  viewer.resize();
  startFractalCalculationWithTiming();
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
  if (webglCheckbox.checked && webglRenderer) {
    renderWebGL();
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
  if (webglCheckbox.checked && webglRenderer && webglRenderer.setColorOffset) {
    webglRenderer.setColorOffset(colorCycleOffset);
    renderWebGL();
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
    if (fractal3D && fractal3D.setColorOffset) fractal3D.setColorOffset(0);
    if (webglCheckbox.checked && webglRenderer && webglRenderer.setColorOffset) {
      webglRenderer.setColorOffset(0);
      renderWebGL();
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
  startFractalCalculationWithTiming();
});

// Minimal WebGL Demo Button
const webglDemoBtn = document.getElementById('webglDemoBtn');
webglDemoBtn.addEventListener('click', () => {
  let demoCanvas = document.createElement('canvas');
  demoCanvas.width = 100;
  demoCanvas.height = 100;
  demoCanvas.style.position = 'fixed';
  demoCanvas.style.top = '10px';
  demoCanvas.style.right = '10px';
  demoCanvas.style.border = '2px solid #0f0';
  document.body.appendChild(demoCanvas);
  let gl = demoCanvas.getContext('webgl') || demoCanvas.getContext('experimental-webgl');
  if (gl) {
    gl.clearColor(0.2, 0.8, 0.2, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    alert('WebGL context created and cleared! You should see a green square in the corner.');
  } else {
    alert('Failed to create WebGL context!');
  }
  setTimeout(() => demoCanvas.remove(), 3000);
});

// --- Helper: Map color scheme string to shader index ---
const colorSchemeMap = {
  'rainbow': 0,
  'fire': 1,
  'ocean': 2,
  'grayscale': 3,
  'viridis': 4
};

function getColorSchemeIdx() {
  return colorSchemeMap[viewer.colorScheme] ?? 0;
}

function updateWebGLState() {
  if (webglCheckbox.checked) {
    // Show WebGL canvas, hide 2D canvas BEFORE context creation
    canvas.style.display = 'none';
    canvasWebGL.style.display = 'block'; // Explicitly set to block
    // Attach a MutationObserver to debug style changes
    if (!canvasWebGL._debugObserver) {
      canvasWebGL._debugObserver = new MutationObserver((mutations) => {
        mutations.forEach(m => {
          if (m.attributeName === 'style') {
            console.log('[WebGL] MutationObserver: style changed to', canvasWebGL.style.display);
          }
        });
      });
      canvasWebGL._debugObserver.observe(canvasWebGL, { attributes: true, attributeFilter: ['style'] });
    }
    // Force reflow to ensure style is applied before context creation
    void canvasWebGL.offsetWidth;
    // Now set canvas size (must be visible)
    canvasWebGL.width = window.innerWidth;
    canvasWebGL.height = window.innerHeight;
    setTimeout(() => {
      // Log style right before context creation
      console.log('[WebGL] Before context: style.display =', canvasWebGL.style.display);
      try {
        if (!webglRenderer) webglRenderer = new WebGLFractalRenderer(canvasWebGL);
        renderWebGL();
      } catch (e) {
        alert('WebGL is not supported or could not be initialized.');
        webglCheckbox.checked = false;
        webglRenderer = null;
        canvasWebGL.style.display = 'none';
        canvas.style.display = '';
        viewer.render();
      }
    }, 0);
  } else {
    // Show 2D canvas, hide WebGL canvas
    canvasWebGL.style.display = 'none';
    canvas.style.display = '';
    if (webglRenderer) { webglRenderer.destroy(); webglRenderer = null; }
    viewer.render();
  }
}

function renderWebGL() {
  lastRenderStart = performance.now();
  if (!webglRenderer) return;
  console.log('[WebGL] renderWebGL: view', JSON.stringify(viewer.view), 'maxIter', viewer.maxIter, 'colorScheme', viewer.colorScheme);
  webglRenderer.render(
    viewer.view,
    viewer.maxIter,
    getColorSchemeIdx()
  );
  lastRenderDuration = performance.now() - lastRenderStart;
  setRenderTimeDisplay(lastRenderDuration);
}

function setRenderTimeDisplay(ms) {
  renderTimeElem.textContent = `Render: ${ms.toFixed(1)} ms`;
}

// Hook up checkbox
webglCheckbox.addEventListener('change', updateWebGLState);

// Update rendering on any parameter change
const originalRender = viewer.render.bind(viewer);
viewer.render = function() {
  lastRenderStart = performance.now();
  if (webglCheckbox.checked && webglRenderer) {
    renderWebGL();
  } else {
    originalRender();
    lastRenderDuration = performance.now() - lastRenderStart;
    setRenderTimeDisplay(lastRenderDuration);
  }
};

// Also update on maxIter/type/params changes
[typeSelect, colorSchemeSelect, maxIterSlider].forEach(el => {
  el.addEventListener('change', () => {
    if (webglCheckbox.checked) renderWebGL();
  });
});
