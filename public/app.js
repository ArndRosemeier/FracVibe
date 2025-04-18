// Use ESM imports for all modules
import { FractalViewer } from './fractalViewer.js';
import { Fractal3DViewer } from './fractal3d.js';
import { FractalEngine } from './fractalEngineMain.js';
import { WebGLFractalRenderer } from './webglFractal.js';
import { FractalMemoryRepository } from './memoryRepository.js';

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
// --- Fractal Location Memory Repository and UI ---
const memoryRepo = new FractalMemoryRepository();
const saveLocationBtn = document.getElementById('saveLocationBtn');
const loadLocationBtn = document.getElementById('loadLocationBtn');
const loadLocationSidebar = document.getElementById('loadLocationSidebar');
const closeLoadLocationSidebar = document.getElementById('closeLoadLocationSidebar');
// We'll create the savedLocationsList and locationSortSelect elements dynamically in the sidebar
let savedLocationsList = null;
let locationSortSelect = null;

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
  // If sidebar is open, update it
  if (loadLocationSidebar && loadLocationSidebar.style.display !== 'none') {
    renderSavedLocations();
  }
});

loadLocationBtn.addEventListener('click', () => {
  // Build sidebar content if not already present
  if (!savedLocationsList) {
    savedLocationsList = document.createElement('div');
    savedLocationsList.id = 'savedLocationsList';
    savedLocationsList.style.maxHeight = '70vh';
    savedLocationsList.style.overflowY = 'auto';
    savedLocationsList.style.margin = '0 1.3em 1em 1.3em';
    // Insert after sort row
    const sidebar = loadLocationSidebar;
    const sortRow = document.createElement('div');
    sortRow.style.display = 'flex';
    sortRow.style.alignItems = 'center';
    sortRow.style.gap = '1em';
    sortRow.style.margin = '0 1.3em 0.5em 1.3em';
    const sortLabel = document.createElement('label');
    sortLabel.textContent = 'Sort by:';
    sortLabel.htmlFor = 'locationSortSelect';
    locationSortSelect = document.createElement('select');
    locationSortSelect.id = 'locationSortSelect';
    locationSortSelect.style.fontSize = '1em';
    locationSortSelect.style.padding = '0.1em 0.5em';
    locationSortSelect.innerHTML = `<option value="timestamp">Most Recent</option><option value="name">Name</option>`;
    sortRow.appendChild(sortLabel);
    sortRow.appendChild(locationSortSelect);
    sidebar.appendChild(sortRow);
    sidebar.appendChild(savedLocationsList);
    locationSortSelect.addEventListener('change', renderSavedLocations);
  }
  renderSavedLocations();
  // Add export/import buttons at the bottom of the sidebar
  let sidebarFooter = document.getElementById('sidebarFooter');
  if (!sidebarFooter) {
    sidebarFooter = document.createElement('div');
    sidebarFooter.id = 'sidebarFooter';
    sidebarFooter.style.display = 'flex';
    sidebarFooter.style.justifyContent = 'flex-start';
    sidebarFooter.style.alignItems = 'center';
    sidebarFooter.style.gap = '1em';
    sidebarFooter.style.padding = '1em 1.3em 1em 1.3em';
    sidebarFooter.style.borderTop = '1px solid #333';
    sidebarFooter.style.position = 'absolute';
    sidebarFooter.style.bottom = '0';
    sidebarFooter.style.width = '100%';
    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.style.background = '#444';
    exportBtn.style.color = '#ffe066';
    exportBtn.style.border = 'none';
    exportBtn.style.borderRadius = '5px';
    exportBtn.style.padding = '0.4em 1.2em';
    exportBtn.style.cursor = 'pointer';
    exportBtn.addEventListener('click', () => {
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
    // Import button
    const importBtn = document.createElement('button');
    importBtn.textContent = 'Import';
    importBtn.style.background = '#ffe066';
    importBtn.style.color = '#222';
    importBtn.style.border = 'none';
    importBtn.style.borderRadius = '5px';
    importBtn.style.padding = '0.4em 1.2em';
    importBtn.style.cursor = 'pointer';
    importBtn.addEventListener('click', () => {
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
    sidebarFooter.appendChild(exportBtn);
    sidebarFooter.appendChild(importBtn);
    loadLocationSidebar.appendChild(sidebarFooter);
  }
  loadLocationSidebar.style.display = 'block';
});

closeLoadLocationSidebar.addEventListener('click', () => {
  loadLocationSidebar.style.display = 'none';
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

// --- WebGL zoom cap logic ---
const WEBGL_ZOOM_CAP = 10000;
const WEBGL_MIN_SCALE = 1 / WEBGL_ZOOM_CAP;
let askedCpuSwitchAtZoomCap = false;
let deniedCpuSwitchAtZoomCap = false;

const originalSetView = viewer.setView.bind(viewer);
viewer.setView = function(view) {
  // Cap zoom in WebGL mode
  if (webglCheckbox.checked) {
    if (view.scale < WEBGL_MIN_SCALE) {
      view = { ...view, scale: WEBGL_MIN_SCALE };
      if (!askedCpuSwitchAtZoomCap && !deniedCpuSwitchAtZoomCap) {
        askedCpuSwitchAtZoomCap = true;
        setTimeout(() => {
          if (window.confirm('Zoom level limit reached for GPU mode. Switch to CPU mode for deeper zoom?')) {
            webglCheckbox.checked = false;
            updateWebGLState();
          } else {
            deniedCpuSwitchAtZoomCap = true;
          }
        }, 10);
      }
    }
  }
  originalSetView(view);
};

viewer.setView(viewer.view);
updateInfo(viewer.view);
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
cycleColorsCheckbox.checked = false;
updateWebGLState();

// Animate zoom from 300 to 3 (default) at startup, then show splash
(function animateZoom() {
  let target = 3;
  let minStep = 0.01;
  let delay = 16; // ms per frame (about 60fps)
  function loop() {
    if (viewer.view.scale > target) {
      let diff = viewer.view.scale - target;
      let thisStep = Math.max(diff * 0.08, minStep); // Easing: smaller steps as we approach
      viewer.view.scale = Math.max(viewer.view.scale - thisStep, target);
      viewer.setView(viewer.view);
      updateInfo(viewer.view);
      setTimeout(loop, delay);
    } else {
      // Animation done, show splash
      updateInfo(viewer.view);
      showFractVibeSplash();
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
    viewer.setView = function(view) {
  // Cap zoom in WebGL mode
  if (webglCheckbox.checked) {
    const maxZoom = 10000;
    if (1 / view.scale > maxZoom) {
      view = { ...view, scale: 1 / maxZoom };
      // Ask user to switch to CPU mode only once
      if (!askedCpuSwitchAtZoomCap && !deniedCpuSwitchAtZoomCap) {
        askedCpuSwitchAtZoomCap = true;
        setTimeout(() => {
          if (window.confirm('Zoom level limit reached for GPU mode. Switch to CPU mode for deeper zoom?')) {
            webglCheckbox.checked = false;
            updateWebGLState();
          } else {
            deniedCpuSwitchAtZoomCap = true;
          }
        }, 10);
      }
    }
  }
  this.view = { ...view };
  this.render();
};
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
  // --- Enforce zoom cap at render time ---
  if (webglCheckbox.checked && viewer.view.scale < WEBGL_MIN_SCALE) {
    viewer.view.scale = WEBGL_MIN_SCALE;
    if (!askedCpuSwitchAtZoomCap && !deniedCpuSwitchAtZoomCap) {
      askedCpuSwitchAtZoomCap = true;
      setTimeout(() => {
        if (window.confirm('Zoom level limit reached for GPU mode. Switch to CPU mode for deeper zoom?')) {
          webglCheckbox.checked = false;
          updateWebGLState();
        } else {
          deniedCpuSwitchAtZoomCap = true;
        }
      }, 10);
    }
  }
  console.log('[WebGL] renderWebGL: view', JSON.stringify(viewer.view), 'maxIter', viewer.maxIter, 'colorScheme', viewer.colorScheme);
  // Map fractal type string to int
  const typeMap = { mandelbrot: 0, julia: 1, burningship: 2, tricorn: 3 };
  const fractalTypeInt = typeMap[viewer.fractalType] || 0;
  const juliaParams = (fractalTypeInt === 1) ? viewer.juliaParams : undefined;
  webglRenderer.render(
    viewer.view,
    viewer.maxIter,
    getColorSchemeIdx(),
    fractalTypeInt,
    juliaParams
  );
  lastRenderDuration = performance.now() - lastRenderStart;
  setRenderTimeDisplay(lastRenderDuration);
}

function setRenderTimeDisplay(ms) {
  renderTimeElem.textContent = `Render: ${ms.toFixed(1)} ms`;
}

// Hook up checkbox
webglCheckbox.addEventListener('change', () => {
  updateWebGLState();
  if (webglCheckbox.checked) {
    renderWebGL();
  } else {
    startFractalCalculationWithTiming();
  }
});

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
