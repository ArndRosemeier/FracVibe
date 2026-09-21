// Use ESM imports for all modules
import { FractalViewer } from './fractalViewer.js';
import { Fractal3DViewer } from './fractal3d.js';
import { FractalEngine } from './fractalEngineMain.js';
import { WebGLFractalRenderer } from './webglFractal.js';
import { FractalMemoryRepository } from './memoryRepository.js';

const canvas = document.getElementById('fractalCanvas');
// `let`: a real WebGL context loss replaces this element (see swapCanvasWebGL).
let canvasWebGL = document.getElementById('fractalCanvasWebGL');
const infoElem = document.getElementById('info');
const typeSelect = document.getElementById('fractalType');
const colorSchemeSelect = document.getElementById('colorScheme');
const cycleColorsCheckbox = document.getElementById('cycleColors');
const maxIterSlider = document.getElementById('maxIter');
const maxIterValue = document.getElementById('maxIterValue');
const webglCheckbox = document.getElementById('webglRender');
const renderTimeElem = document.getElementById('renderTime');

let viewer = new FractalViewer(canvas, updateInfo);
// --- Fractal Location Memory Repository and UI ---
const memoryRepo = new FractalMemoryRepository();
const saveLocationBtn = document.getElementById('saveLocationBtn');
const loadLocationBtn = document.getElementById('loadLocationBtn');
const loadLocationModal = document.getElementById('loadLocationModal');
const closeLoadLocationModal = document.getElementById('closeLoadLocationModal');
const exportLocationsBtn = document.getElementById('exportLocationsBtn');
const importLocationsBtn = document.getElementById('importLocationsBtn');
// These live in index.html; the modal is shown/hidden rather than built on demand.
const savedLocationsList = document.getElementById('savedLocationsList');
const locationSortSelect = document.getElementById('locationSortSelect');

function getCurrentLocationState() {
  return {
    id: Date.now() + Math.random(),
    name: '',
    centerX: viewer.view.centerX,
    centerY: viewer.view.centerY,
    scale: viewer.view.scale,
    fractalType: typeSelect.value,
    maxIter: parseInt(maxIterSlider.value, 10),
    renderer: webglCheckbox.checked ? 'GPU' : 'CPU',
    timestamp: Date.now()
  };
}

saveLocationBtn.addEventListener('click', () => {
  const state = getCurrentLocationState();
  const defaultName = `Location (${state.centerX.toFixed(3)}, ${state.centerY.toFixed(3)}, zoom ${(1/state.scale).toFixed(2)})`;
  const userName = window.prompt('Name this location (optional):', defaultName);
  if (userName === null) return; // Cancelled
  state.name = userName && userName.trim() ? userName.trim() : defaultName;
  memoryRepo.save(state);
  // Non-modal fade-out confirmation
  const conf = document.getElementById('saveLocationConfirmation');
  conf.style.display = 'block';
  conf.style.opacity = '1';
  setTimeout(() => {
    conf.style.opacity = '0';
    setTimeout(() => { conf.style.display = 'none'; }, 700);
  }, 1200);
  // If the modal is open, update it
  if (loadLocationModal.style.display !== 'none') {
    renderSavedLocations();
  }
});

loadLocationBtn.addEventListener('click', () => {
  renderSavedLocations();
  // The modal is a flex container (centring relies on display:flex).
  loadLocationModal.style.display = 'flex';
});

closeLoadLocationModal.addEventListener('click', () => {
  loadLocationModal.style.display = 'none';
});

locationSortSelect.addEventListener('change', renderSavedLocations);

exportLocationsBtn.addEventListener('click', () => {
  const data = JSON.stringify(memoryRepo.getAll('timestamp'), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'fractal_locations.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
});

importLocationsBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        if (Array.isArray(imported)) {
          imported.forEach(loc => {
            // Remove existing with same id, then add
            memoryRepo.remove(loc.id);
            memoryRepo.save(loc);
          });
          renderSavedLocations();
          alert('Locations imported successfully.');
        } else {
          alert('Invalid file format.');
        }
      } catch (err) {
        alert('Error importing locations: ' + err.message);
      }
    };
    reader.readAsText(file);
  });
  document.body.appendChild(input);
  input.click();
  setTimeout(() => document.body.removeChild(input), 5000);
});

function renderSavedLocations() {
  savedLocationsList.innerHTML = '';
  const sortBy = locationSortSelect ? locationSortSelect.value : 'timestamp';
  const locations = memoryRepo.getAll(sortBy);
  if (!locations.length) {
    const div = document.createElement('div');
    div.textContent = 'No locations saved yet.';
    div.style.padding = '1em';
    savedLocationsList.appendChild(div);
    return;
  }
  locations.forEach(loc => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'space-between';
    row.style.padding = '0.4em 0.5em';
    row.style.borderBottom = '1px solid #333';
    row.style.gap = '1em';
    // Info
    const info = document.createElement('div');
    info.style.flex = '1 1 0';
    info.style.overflow = 'hidden';
    info.innerHTML = `<span style="font-weight:bold;">${loc.name}</span><br><span style="font-size:0.9em;color:#ffc966;">${new Date(loc.timestamp).toLocaleString()}</span><br><span style="font-size:0.9em;color:#aaa;">Type: ${loc.fractalType}, Iter: ${loc.maxIter}, ${loc.renderer}</span>`;
    row.appendChild(info);
    // Actions
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '0.5em';
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    loadBtn.style.background = '#ffe066';
    loadBtn.style.color = '#222';
    loadBtn.style.fontWeight = 'bold';
    loadBtn.style.border = 'none';
    loadBtn.style.borderRadius = '5px';
    loadBtn.style.padding = '0.2em 1.1em';
    loadBtn.style.cursor = 'pointer';
    loadBtn.addEventListener('click', () => {
      typeSelect.value = loc.fractalType;
      maxIterSlider.value = loc.maxIter;
      maxIterValue.textContent = loc.maxIter;
      webglCheckbox.checked = (loc.renderer === 'GPU');
      viewer.setFractal(loc.fractalType);
      viewer.setView({ centerX: loc.centerX, centerY: loc.centerY, scale: loc.scale });
      viewer.maxIter = loc.maxIter;
      if (webglCheckbox.checked) {
        updateWebGLState();
        // After changing mode, re-apply the loaded view
        viewer.setView({ centerX: loc.centerX, centerY: loc.centerY, scale: loc.scale });
        renderWebGL();
      } else {
        updateWebGLState(); // in case switching from GPU to CPU
        viewer.setView({ centerX: loc.centerX, centerY: loc.centerY, scale: loc.scale });
        startFractalCalculationWithTiming();
      }
      // Always trigger a rerender in the current mode
      if (webglCheckbox.checked) {
        renderWebGL();
      } else {
        startFractalCalculationWithTiming();
      }
      // loadLocationModal.style.display = 'none';
    });
    actions.appendChild(loadBtn);
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.style.background = '#444';
    delBtn.style.color = '#ffe066';
    delBtn.style.border = 'none';
    delBtn.style.borderRadius = '5px';
    delBtn.style.padding = '0.2em 0.8em';
    delBtn.style.cursor = 'pointer';
    delBtn.addEventListener('click', () => {
      memoryRepo.remove(loc.id);
      renderSavedLocations();
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);
    savedLocationsList.appendChild(row);
  });
}


// Start with a very zoomed-out view (tiny Mandelbrot)
viewer.view.scale = 300;

// --- WebGL zoom cap logic (S1): the clamp itself lives in FractalViewer
// (setZoomLimit/clampScale) so wheel, setView and the startup animation all
// produce the SAME value. This module only DECIDES the cap and what to say when
// it is reached. There is no monkey-patching of viewer methods any more.
const WEBGL_ZOOM_CAP = 10000;
const WEBGL_MIN_SCALE = 1 / WEBGL_ZOOM_CAP;
let askedCpuSwitchAtZoomCap = false;
let deniedCpuSwitchAtZoomCap = false;

function handleZoomLimitReached() {
  showMessage('Zoom limit reached for GPU mode (~' + WEBGL_ZOOM_CAP.toLocaleString() + 'x). Offer to switch to CPU for deeper zoom.');
  // The cap is hit on every further wheel tick, but the user is PROMPTED only
  // once. Report both facts to the observer so "once" is observable, not
  // asserted from behaviour.
  const prompted = !askedCpuSwitchAtZoomCap && !deniedCpuSwitchAtZoomCap;
  try {
    window.dispatchEvent(new CustomEvent('fv-zoom-limit', {
      detail: { scale: viewer.view.scale, prompted },
    }));
  } catch (_) { /* observation only */ }
  if (!prompted) return;
  askedCpuSwitchAtZoomCap = true;
  // Deferred so the clamp (and the render it triggers) is not blocked by the
  // modal; the cap itself is already applied by the caller.
  setTimeout(() => {
    let switchToCpu = false;
    try {
      switchToCpu = window.confirm('Zoom level limit reached for GPU mode. Switch to CPU mode for deeper zoom?');
    } catch (_) { /* a blocked/absent dialog must not break zoom */ }
    if (switchToCpu) {
      webglCheckbox.checked = false;
      updateWebGLState();
    } else {
      deniedCpuSwitchAtZoomCap = true;
    }
  }, 10);
}

viewer.setZoomLimit(WEBGL_MIN_SCALE, handleZoomLimitReached);

viewer.setView(viewer.view);
updateInfo(viewer.view);
// --- S2: the worker job lifecycle -------------------------------------------------
// `worker` is now a SLOT, not a permanent object. Cancellation terminates the worker
// and spins up a fresh one (see cancelJob below): a message cannot reach a worker
// that is blocked inside a synchronous loop, so `terminate()` is the only real
// cancel. `calcToken` is the generation that matches results to the latest view; it
// is still checked on every frame, but after a terminate no frame can even arrive.
let worker = null;
let calcToken = 0; // Used to match results to the latest view
// S2 observables (counted, never inferred). The suite asserts on these.
let workerGeneration = 0; // how many Workers this page has spawned
let cancelledWorkerCount = 0; // how many in-flight jobs were killed by terminate()
let appliedFrameCount = 0; // frames handed to the viewer, progress and final alike
let progressFrameCount = 0; // of those, the non-final ones
let appliedJobToken = null; // the job whose frames are on screen; null when idle
let jobSequence = 0; // monotonic id of every job started
const appliedFramesByJob = new Map(); // jobSequence -> frames applied for that job
// The variables below belong to S6 (hygiene) and are deliberately left alone: they
// are declared and never read. S2 does not make them any less dead.
let currentResult = null;
let aborting = false;
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
// Set when the startup zoom animation has finished; lets the suite (and later
// view logic) distinguish "still animating" from "settled".
let zoomAnimationSettled = false;
// --- S1 renderer-selection state (declared here because updateWebGLState runs
// during startup, before the module body below finishes) ---
// renderingWebGL stops a render from recursing; webglFailureHandled remembers
// that we degraded to CPU so we neither retry a dead context nor report twice;
// webglPending marks the window in which GPU mode is selected but the renderer
// is still being built (a missing renderer then is NOT a failure).
let renderingWebGL = false;
let webglFailureHandled = false;
let webglPending = false;
let resizeViewportTimer = null;
let currentErrorMessage = '';

// Track if user has been asked to switch to CPU mode at zoom cap
// (DECLARED ONCE at the top for global use)



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
  // Hide BOTH 2D canvases: three.js appends its own canvas to <body>, and a
  // visible in-flow canvas would push that one below the fold.
  canvas.style.display = 'none';
  canvasWebGL.style.display = 'none';
  infoElem.style.display = 'none';
}

function exit3DMode() {
  if (!in3DMode) return;
  in3DMode = false;
  if (fractal3D) fractal3D.exit();
  fractal3D = null;
  infoElem.style.display = '';
  // Restores the canvas that matches the active renderer (also re-renders).
  updateWebGLState();
}

function updateInfo(view) {
  infoElem.textContent = `Center: (${view.centerX.toFixed(5)}, ${view.centerY.toFixed(5)})  Zoom: ${(1/view.scale).toFixed(2)}`;
}

// --- Non-modal failure / status surface (S1/B9) ---
// Everything that used to be an `alert` (or was swallowed entirely) reports
// here: visible in the page, dismissible-free, and never blocking the renderer.
const appMessageElem = document.getElementById('appMessage');

function showMessage(text, level) {
  currentErrorMessage = text == null ? '' : String(text);
  if (!appMessageElem) return;
  appMessageElem.textContent = currentErrorMessage;
  appMessageElem.className = 'app-message' + (level && level !== 'info' ? ' app-message--' + level : '');
  appMessageElem.style.display = currentErrorMessage ? 'block' : 'none';
}

function showError(text) { showMessage(text, 'error'); }

function errorText(err) {
  const raw = (err && (err.message || err.reason || err)) || 'Unknown error';
  return String(raw).replace(/\s+/g, ' ').slice(0, 300);
}

// The last-resort net: an exception that escapes a render path must leave a
// message, not a frozen canvas (S1).
window.addEventListener('error', (event) => {
  const target = event && event.target;
  const where = target && target !== window && target.tagName
    ? `${target.tagName} ${target.src || target.href || ''}`.trim()
    : '';
  showError(`Error: ${errorText(event && (event.error || event.message))}${where ? ` (${where})` : ''}`);
});
window.addEventListener('unhandledrejection', (event) => {
  showError(`Unhandled promise rejection: ${errorText(event && (event.reason || event))}`);
});

typeSelect.addEventListener('change', () => {
  viewer.setFractal(typeSelect.value);
  // Reset view to default for each fractal type
  let defaultView;
  if (typeSelect.value === 'julia') {
    defaultView = { centerX: 0, centerY: 0, scale: 3 };
  } else {
    defaultView = { centerX: -0.5, centerY: 0, scale: 3 };
  }
  viewer.setView(defaultView);
  startFractalCalculationWithTiming();
});

// --- S2: the worker job lifecycle -------------------------------------------------
// The one place a Worker is constructed. Every frame carries the `calcToken` of the
// job that produced it, and the handler refuses a frame whose token is not the live
// job's token. Termination is the real cancel; the token check is the second net,
// which still catches a frame that raced in before terminate() took effect.
function spinUpWorker() {
  if (worker) return worker; // never orphan a live worker
  const w = new Worker('fractalWorker.js');
  w._fvGeneration = ++workerGeneration;
  // A factory, so the handler knows which worker produced the frame even after the
  // slot has moved on to a respawned worker.
  w.onmessage = makeWorkerMessageHandler(w._fvGeneration);
  // A worker failure used to be completely silent: no handler existed, so the
  // canvas kept its last frame and nothing was reported. This surfaces it.
  w.onerror = (event) => {
    if (w !== worker) return; // a worker we already retired; its exit is not news
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (!progressiveState) return; // no job was in flight: nothing to report
    if (w._fvCancelled) return; // a terminate WE asked for is not a failure
    progressiveState = null;
    const msg = errorText(event && (event.message || event.error)) || 'unknown error';
    showError('Render worker failed: ' + msg + ' The last completed image is still shown; change the view to retry.');
    terminateWorker();
  };
  worker = w;
  return worker;
}

// Kill the live worker. A worker blocked in its synchronous kernel can never read a
// posted 'abort' message, so terminate() is the only cancellation that is real.
// The caller respawns (startFractalCalculation calls spinUpWorker) or leaves the
// slot empty for the next job to fill.
function terminateWorker() {
  const w = worker;
  worker = null;
  progressiveState = null;
  if (!w) return;
  w._fvCancelled = true;
  w.onmessage = null;
  w.onerror = null;
  try { w.terminate(); } catch (_) { /* already gone */ }
}

function startFractalCalculation() {
  // A job always runs on a live worker. Starting a job while one is still in flight
  // is a view change or a control change, and the new job supersedes it.
  if (progressiveState) cancelJob();
  else spinUpWorker();
  // Start with a coarse gridStep; the worker refines it and posts every level as a
  // frame, so a slow render shows something before it is finished.
  let gridStep = 8;
  let prior = null;
  let width = viewer.width, height = viewer.height;
  let params = viewer.fractalType === 'julia' ? viewer.juliaParams : {};
  let thisToken = ++calcToken;

  progressiveState = {
    calcToken: thisToken,
    jobId: ++jobSequence,
    workerGeneration: worker._fvGeneration,
    width,
    height,
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
  appliedFramesByJob.set(progressiveState.jobId, 0);

  sendProgressiveJob();
}

function sendProgressiveJob() {
  if (!progressiveState) return;
  if (!worker) spinUpWorker(); // e.g. the previous worker failed and was retired
  worker.postMessage({ ...progressiveState.jobParams, calcToken: progressiveState.calcToken });
}

// The ONE place a worker frame becomes pixels. It is shared by the real message
// handler and the observation hook, so a test can never exercise a path the app
// does not use. Returns true when the frame was applied.
function applyWorkerFrame(calcTokenValue, rawResult, final) {
  const progress = progressiveState;
  // Only the live job's frames are applied, and only from the worker that is still
  // live. A stale frame is dropped, whatever path it arrived by.
  if (!progress) return false;
  if (calcTokenValue !== progress.calcToken) return false;
  if (!worker || worker._fvGeneration !== progress.workerGeneration) return false;
  if (!rawResult || typeof rawResult.byteLength !== 'number' || rawResult.byteLength % 4 !== 0) {
    throw new Error('worker result is not an Int32Array payload');
  }
  const intResult = new Int32Array(rawResult);
  const expected = progress.width * progress.height;
  if (intResult.length !== expected) {
    throw new Error(`worker result has ${intResult.length} entries, expected ${expected}`);
  }
  viewer.setData(intResult, viewer.maxIter);
  const n = (appliedFramesByJob.get(progress.jobId) || 0) + 1;
  appliedFramesByJob.set(progress.jobId, n);
  appliedFrameCount++;
  if (!final) progressFrameCount++;
  appliedJobToken = calcTokenValue;
  if (final) {
    // The frame for THIS job is on screen and the job is finished, so the token
    // no longer describes an in-flight job (jobToken() -> null).
    appliedJobToken = null;
    progressiveState = null;
    setRenderTimeDisplay(performance.now() - renderStartTime);
  }
  return true;
}

function handleWorkerFrame(msg) {
  // Progress frames are applied: the worker refines 8 -> 4 -> 2 -> 1 and every
  // level is a real image, so the user sees the render converge instead of staring
  // at a stale frame until the last pixel lands.
  try {
    const final = msg && msg.type === 'done';
    applyWorkerFrame(msg && msg.calcToken, msg && msg.result, final);
  } catch (err) {
    // A malformed payload must never escape the event handler uncaught: that used
    // to freeze the render with no message at all.
    progressiveState = null;
    showError('Render worker returned a result that could not be applied (' + errorText(err) + '). The last completed image is still shown.');
  }
}

// One handler per spawned worker, so a frame can be attributed to the worker that
// sent it even after the slot has moved on to a respawned one. A frame from a worker
// that is no longer live is dropped: terminate() cannot preempt a synchronous kernel
// in progress, so the cancelled job's final frame CAN still be handed to this
// handler, and it must not be applied.
function makeWorkerMessageHandler(generation) {
  return function handleWorkerMessage(e) {
    if (generation !== (worker && worker._fvGeneration)) return;
    const msg = e && e.data;
    if (!msg || typeof msg !== 'object') return; // not ours; ignore rather than throw
    handleWorkerFrame(msg);
  };
}

function cancelJob() {
  // Real cancellation: kill the worker that is inside the kernel, then respawn.
  // Returns true when an in-flight job was actually cancelled.
  const wasActive = !!progressiveState;
  if (wasActive) cancelledWorkerCount++;
  terminateWorker();
  calcToken++; // invalidate anything a racing frame could still carry
  progressiveState = null;
  spinUpWorker();
  return wasActive;
}

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
  // Abort current calculation for real: terminate the worker that is inside the
  // kernel and respawn it (S2). The old `postMessage({type:'abort'})` was a no-op
  // because the worker cannot read a message while it is in its synchronous loop.
  cancelJob();
  // Start a new calculation for the new view
  startFractalCalculationWithTiming();
  // Always trigger render in correct mode
  triggerFractalRender();
}
viewer.setOnViewChange(onViewChangeHandler);

// Set WebGL and color cycling as default
webglCheckbox.checked = true;
cycleColorsCheckbox.checked = false;
updateWebGLState();

// Animate zoom from 300 to 3 (default) at startup, then show splash
(function animateZoom() {
  const target = 3;
  const minStep = 0.01;
  const delay = 16; // ms per frame (about 60fps)
  function loop() {
    if (viewer.view.scale > target) {
      const diff = viewer.view.scale - target;
      const thisStep = Math.max(diff * 0.08, minStep); // Easing: smaller steps as we approach
      const nextScale = Math.max(viewer.view.scale - thisStep, target);
      // Go through setView (a fresh object, never mutating the live view) so the
      // ONE clamp applies here exactly as it does for the wheel (S1). Passing the
      // live object would let the animation overwrite a clamped scale next frame.
      viewer.setView({ ...viewer.view, scale: nextScale });
      setTimeout(loop, delay);
    } else {
      // Animation done, show splash
      zoomAnimationSettled = true;
      updateInfo(viewer.view);
      showFractVibeSplash();
      // The animation moved the view without going through the view-change
      // path, so the CPU renderer is still showing the pre-animation image.
      // (GPU mode re-renders every frame from the uniforms, so it needs nothing.)
      if (!webglCheckbox.checked) startFractalCalculationWithTiming();
    }
  }
  loop();
})();

function showFractVibeSplash() {
  const splash = document.getElementById('fractVibeSplash');
  if (!splash) return;
  splash.style.opacity = '1';
  // Fade out after 2 seconds
  setTimeout(() => {
    splash.style.opacity = '0';
  }, 2000);
}

// Start color cycling only if enabled (now default OFF)
if (cycleColorsCheckbox.checked) {
  colorCycleActive = true;
  colorCycleLastTime = performance.now();
  colorCycleRequestId = requestAnimationFrame(colorCycleLoop);
} else {
  colorCycleActive = false;
}

// Initial calculation
startFractalCalculationWithTiming();

// --- S1/B4: the ONE resize path -------------------------------------------------
// Both canvases are sized to CSS size x devicePixelRatio here, for all three
// renderers. FractalViewer no longer installs its own resize listener.
// A canvas whose WebGL context has been lost can never hand out a fresh context
// again, so teardown replaces the element with a clean one. Idempotent: the
// current canvas is only replaced while it is the one that lost its context.
function swapCanvasWebGL() {
  const old = canvasWebGL;
  if (!old || !old.parentNode) return null;
  if (!old._fvContextLost) return old;
  const replacement = old.cloneNode(false);
  replacement.width = 1;
  replacement.height = 1;
  old.parentNode.replaceChild(replacement, old);
  canvasWebGL = replacement;
  attachFractalMouseEvents(replacement);
  attachContextLossGuard(replacement);
  return replacement;
}

function sameSizeCanvas(c, w, h) {
  return c.width === w && c.height === h;
}

function resizeRenderers(force) {
  if (in3DMode) return; // Fractal3DViewer owns its own size
  const dpr = window.devicePixelRatio || 1;
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));

  const cw = canvasWebGL;
  const webglChanged = !!cw && (force || !sameSizeCanvas(cw, w, h));
  if (webglChanged) {
    cw.width = w;
    cw.height = h;
    if (webglRenderer && typeof webglRenderer.resize === 'function') {
      webglRenderer.resize(cssW, cssH, dpr);
    }
  }

  const viewerChanged = viewer.width !== w || viewer.height !== h || force;
  if (viewerChanged) viewer.applyCanvasSize(cssW, cssH, dpr);
  return { width: w, height: h, webglChanged, viewerChanged, dpr };
}

function onViewportResize() {
  if (in3DMode) return;
  const change = resizeRenderers(false);
  if (!change) return;
  // Refresh both renderers immediately, then recompute at the new resolution
  // once the burst of resize events has settled.
  if (webglCheckbox.checked) renderWebGL();
  else viewer.render();
  if (resizeViewportTimer) clearTimeout(resizeViewportTimer);
  resizeViewportTimer = setTimeout(() => {
    resizeViewportTimer = null;
    startFractalCalculationWithTiming();
  }, 150);
}

window.addEventListener('resize', onViewportResize);

// devicePixelRatio changes (dragging a window between displays, or a browser
// zoom) fire no 'resize' event on their own; watch the media query directly.
let dprQuery = null;
function watchDevicePixelRatio() {
  if (!window.matchMedia) return;
  if (dprQuery && dprQuery.removeEventListener) dprQuery.removeEventListener('change', dprHandler);
  const dpr = window.devicePixelRatio || 1;
  dprQuery = window.matchMedia('(resolution: ' + dpr + 'dppx)');
  if (dprQuery.addEventListener) dprQuery.addEventListener('change', dprHandler);
}
function dprHandler() {
  watchDevicePixelRatio();
  resizeRenderers(true);
  if (webglCheckbox.checked) renderWebGL();
  else viewer.render();
  startFractalCalculationWithTiming();
}
watchDevicePixelRatio();
window.addEventListener('beforeunload', () => {
  if (dprQuery && dprQuery.removeEventListener) dprQuery.removeEventListener('change', dprHandler);
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

// --- S1: renderer selection and the WebGL failure path ------------------------
// (state declared near the top, before startup runs updateWebGLState)
function updateWebGLState() {
  if (webglCheckbox.checked) {
    if (webglFailureHandled) {
      // Already degraded: stay on the CPU canvas instead of retrying a context
      // this page cannot get.
      canvasWebGL.style.display = 'none';
      canvas.style.display = '';
      return;
    }
    // Show WebGL canvas, hide 2D canvas BEFORE context creation
    canvas.style.display = 'none';
    canvasWebGL.style.display = 'block';
    // Force reflow to ensure style is applied before context creation
    void canvasWebGL.offsetWidth;
    // Size the drawing buffer to CSS size x dpr, now that the canvas is visible
    // (B4: this used to be a one-off CSS-pixel size that never changed again).
    resizeRenderers(true);
    webglPending = true;
    setTimeout(() => {
      try {
        if (!webglRenderer) {
          swapCanvasWebGL(); // no-op unless the current canvas lost its context
          webglRenderer = new WebGLFractalRenderer(canvasWebGL);
        }
        webglPending = false;
        renderWebGL();
      } catch (err) {
        webglPending = false;
        handleWebGLFailure('WebGL is not supported or could not be initialized.', err);
      }
    }, 0);
  } else if (!webglFailureHandled) {
    // Show 2D canvas, hide WebGL canvas
    webglPending = false;
    canvasWebGL.style.display = 'none';
    canvas.style.display = '';
    if (webglRenderer) {
      webglRenderer.destroy();
      webglRenderer = null;
      // The destroyed context leaves its canvas permanently unusable; replace it
      // so a later GPU toggle can actually get a context.
      canvasWebGL._fvContextLost = true;
      swapCanvasWebGL();
    }
    renderFractal();
  } else {
    // Degraded to CPU: make sure the 2D canvas is the visible one.
    canvasWebGL.style.display = 'none';
    canvas.style.display = '';
    renderFractal();
  }
}

// One exit for every WebGL failure: context creation, shader compile, context
// loss, or a throw from renderWebGL. It always (a) starts a REAL CPU render so
// the canvas is never the blank #222 the old alert-path left behind, and (b)
// says so in the page instead of an alert.
function handleWebGLFailure(reason, err) {
  const detail = err ? ` (${errorText(err)})` : '';
  if (webglRenderer) {
    try { webglRenderer.destroy(); } catch (_) { /* already unusable */ }
    webglRenderer = null;
    canvasWebGL._fvContextLost = true;
    swapCanvasWebGL();
  }
  webglCheckbox.checked = false;
  webglFailureHandled = true;
  canvasWebGL.style.display = 'none';
  canvas.style.display = '';
  showError(reason + detail + ' Fell back to the CPU renderer.');
  // Start a real CPU calculation (the old path only called viewer.render(), which
  // paints the background when no image data exists yet).
  startFractalCalculationWithTiming();
}

// A lost context (real event or an unusable renderer): report it, degrade to
// CPU, and swap in a live WebGL canvas so a later GPU toggle can work again.
function handleWebGLLoss(note) {
  if (webglRenderer) {
    try { webglRenderer.destroy(); } catch (_) { /* already unusable */ }
    webglRenderer = null;
  }
  canvasWebGL._fvContextLost = true;
  webglCheckbox.checked = false;
  canvasWebGL.style.display = 'none';
  canvas.style.display = '';
  showError('WebGL context lost. ' + (note || '') + ' Fell back to the CPU renderer.');
  startFractalCalculationWithTiming();
}

function renderWebGL() {
  lastRenderStart = performance.now();
  if (!webglRenderer) {
    // No renderer while GPU mode is the ACTIVE choice means WebGL cannot draw:
    // fall back rather than leaving a blank canvas (S1/B9). This used to be a
    // bare `return`. While the renderer is still being built (webglPending) that
    // absence is expected, and while the CPU is the active choice there is simply
    // nothing for WebGL to do.
    if (webglCheckbox.checked && !webglPending) handleWebGLFailure('WebGL renderer unavailable.');
    return;
  }
  if (webglRenderer.destroyed || (webglRenderer.gl && webglRenderer.gl.isContextLost())) {
    handleWebGLLoss('The renderer is no longer usable.');
    return;
  }
  try {
    // Map fractal type string to int
    const typeMap = { mandelbrot: 0, julia: 1, burningship: 2, tricorn: 3 };
    const fractalTypeInt = typeMap[viewer.fractalType] || 0;
    const juliaParams = (fractalTypeInt === 1) ? viewer.juliaParams : undefined;
    renderingWebGL = true;
    webglRenderer.render(
      viewer.view,
      viewer.maxIter,
      getColorSchemeIdx(),
      fractalTypeInt,
      juliaParams
    );
  } catch (err) {
    handleWebGLFailure('WebGL rendering failed.', err);
    return;
  } finally {
    renderingWebGL = false;
  }
  lastRenderDuration = performance.now() - lastRenderStart;
  setRenderTimeDisplay(lastRenderDuration);
}

function setRenderTimeDisplay(ms) {
  renderTimeElem.textContent = `Render: ${ms.toFixed(1)} ms`;
}

// Hook up checkbox. Every switch is guarded: a failure here must surface as a
// message and a CPU render, never as an uncaught exception.
webglCheckbox.addEventListener('change', () => {
  try {
    updateWebGLState();
    if (webglCheckbox.checked) {
      renderWebGL();
    } else {
      startFractalCalculationWithTiming();
    }
  } catch (err) {
    handleWebGLFailure('Renderer switch failed.', err);
  }
});

// --- S1: the ONE canvas resize path -------------------------------------------
// `viewer.render` is re-pointed exactly once, here, to dispatch to the active
// renderer. (Previously this was a monkey-patch installed before every GPU entry.)
const originalRender = viewer.render.bind(viewer);
function renderFractal() {
  if (webglCheckbox.checked && (webglRenderer || webglPending)) {
    if (webglRenderer) renderWebGL();
    // webglPending: the deferred init will render as soon as it has a renderer.
  } else {
    originalRender();
    lastRenderDuration = performance.now() - lastRenderStart;
    setRenderTimeDisplay(lastRenderDuration);
  }
}
viewer.render = function() {
  lastRenderStart = performance.now();
  return renderFractal();
};

// Context loss must be heard from the moment the element exists, not only after
// a renderer was constructed. preventDefault() keeps the canvas restorable;
// the element is then replaced so a fresh context can be created.
function attachContextLossGuard(target) {
  if (!target || typeof target.addEventListener !== 'function') return;
  target.addEventListener('webglcontextlost', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    target._fvContextLost = true;
    // A teardown we initiated also emits this event, but only for the ACTIVE
    // canvas does it mean the page just lost its renderer. A detached canvas
    // (already replaced by swapCanvasWebGL) must not trigger a second fallback.
    if (target !== canvasWebGL) return;
    handleWebGLLoss(event && event.statusMessage ? event.statusMessage : '');
  });
}
attachContextLossGuard(canvasWebGL);

// --- S1: debug/observation hook for the suite ---------------------------------
// A small, frozen surface so tests can observe view truth without inferring it
// from pixels. It exposes no way to change renderer behaviour.
window.__fv = Object.freeze({
  getView: () => ({ ...viewer.view }),
  setScale: (scale) => viewer.setView({ ...viewer.view, scale }),
  runAnimationFrame: () => { viewer.setView({ ...viewer.view, scale: viewer.view.scale }); },
  renderWebGL: () => renderWebGL(),
  forceFallback: () => handleWebGLFailure('WebGL failure forced for observation.'),
  simulateContextLoss: () => handleWebGLLoss('Context loss simulated.'),
  zoomCap: WEBGL_ZOOM_CAP,
  minScale: WEBGL_MIN_SCALE,
  liveRenderers: () => (typeof window.__fvLiveWebglRenderers === 'number' ? window.__fvLiveWebglRenderers : 0),
  animationSettled: () => zoomAnimationSettled,
  // --- S2 worker observables (counted, never inferred) ---
  // How many Workers this page has constructed, and how many live jobs a terminate
  // killed. A cancellation is proven by the second number going up, not by watching
  // pixels stop changing.
  workerGeneration: () => workerGeneration,
  cancelledWorkers: () => cancelledWorkerCount,
  liveWorkers: () => (worker ? 1 : 0),
  // Frames the viewer actually received, progress and final alike.
  appliedFrames: () => appliedFrameCount,
  progressFrames: () => progressFrameCount,
  appliedFramesForJob: (jobId) => appliedFramesByJob.get(jobId) || 0,
  appliedJobToken: () => appliedJobToken,
  jobCount: () => jobSequence,
  // The live job's token, or null when no job is in flight (which is what a
  // completed or cancelled job leaves behind).
  jobToken: () => (progressiveState ? progressiveState.calcToken : null),
  jobSize: () => (progressiveState ? { width: progressiveState.width, height: progressiveState.height } : null),
  // Start a job of the current view/size through the REAL calculation entry point.
  // The suite uses this to make a job big enough to cancel mid-flight; it adds no
  // production path.
  runJob: () => { startFractalCalculationWithTiming(); },
  // Cancel exactly as a view change does, and report whether a job was in flight.
  cancelJob: () => cancelJob(),
  // Deliver a raw worker message, so a malformed payload can be tested without
  // waiting for a real worker to produce one. Goes through the real handler.
  deliverWorkerMessage: (msg) => {
    const w = worker;
    if (!w || typeof w.onmessage !== 'function') throw new Error('no live worker');
    w.onmessage({ data: msg });
  },
  // Surface an error through the REAL onerror path (as a worker script/runtime
  // failure would), without waiting for a worker to actually crash.
  failWorker: (message) => {
    const w = worker;
    if (!w || typeof w.onerror !== 'function') throw new Error('no live worker');
    w.onerror({ message: String(message), preventDefault() {} });
  },
});

// Also update on maxIter/type/params changes
[typeSelect, colorSchemeSelect, maxIterSlider].forEach(el => {
  el.addEventListener('change', () => {
    if (webglCheckbox.checked) renderWebGL();
  });
});
