// Use ESM imports for all modules
import { FractalViewer } from './fractalViewer.js';
import { Fractal3DViewer } from './fractal3d.js';
// The ONE kernel, shared with the classic render worker and the shader. It has no
// `export` on purpose (so `importScripts` can load the same file), hence the
// side-effect import + global read.
import './fractalKernel.js';
import { WebGLFractalRenderer } from './webglFractal.js';
import { FractalMemoryRepository, LOCATION_LIMITS, validateRecords } from './memoryRepository.js';

// The single source of truth for the iteration cap, the fractal-type table and
// the palette table (public/fractalKernel.js).
const FractalKernel = globalThis.FractalKernel;

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
// S6: the two non-modal surfaces that replace `window.prompt` (save/naming) and
// `window.confirm` (GPU zoom-cap offer). Queried here with every other element.
const zoomCapOffer = document.getElementById('zoomCapOffer');
const zoomCapSwitchBtn = document.getElementById('zoomCapSwitchToCpu');
const zoomCapDismissBtn = document.getElementById('zoomCapDismiss');

// --- S3: the ONE type/palette table and the ONE iteration cap ---------------
// The <select> option lists and the slider's `max` are DERIVED from the kernel
// (public/fractalKernel.js) instead of being restated in index.html. The UI can
// then never name a fractal, a palette or an iteration count the renderers do not
// honour. Before S3 index.html hardcoded max="2000" while the shader's loop bound
// was a literal 1024, so everything above 1024 was silently mis-coloured (B5).
function populateSelect(select, entries) {
  select.innerHTML = '';
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    select.appendChild(option);
  }
}
populateSelect(typeSelect, FractalKernel.FRACTAL_TYPES);
populateSelect(colorSchemeSelect, FractalKernel.COLOR_SCHEMES);
// The slider's upper bound IS the kernel cap; the kernel clamps worker, 3D and
// shader to the same number, so the UI cannot offer more than they honour.
maxIterSlider.max = String(FractalKernel.MAX_ITER);

// S4: ids are STRINGS. The schema accepts a bounded non-empty string, so the
// generator must produce one; the epoch keeps ids distinct across reloads and the
// counter keeps them distinct inside one page (the old `Date.now() + Math.random()`
// produced a NUMBER, which the imported shape does not accept).
let locationIdCounter = 0;
function newLocationId() {
  locationIdCounter += 1;
  return `loc-${Date.now().toString(36)}-${locationIdCounter.toString(36)}`;
}

function getCurrentLocationState() {
  return {
    id: newLocationId(),
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

// --- S6: the save/naming flow is NON-MODAL --------------------------------
// The three elements live in index.html. Before S6 the name came from
// `window.prompt('Name this location (optional):', defaultName)` (old
// `app.js:88`), which blocks the page, is unstyled and un-dismissible by the
// app, and is unavailable in embedded/automated contexts. The panel below
// carries the same contract — an optional name, prefilled with the SAME
// generated default, Save stores it, Cancel stores nothing — without a dialog.
// The fade-out `#saveLocationConfirmation` surface is reused unchanged.
const saveLocationPanel = document.getElementById('saveLocationPanel');
const saveLocationNameInput = document.getElementById('saveLocationName');
const saveLocationConfirmBtn = document.getElementById('saveLocationConfirm');
const saveLocationCancelBtn = document.getElementById('saveLocationCancel');

// The ONE place a named location is committed; reached only from the Save
// button below, so the UI path and the storage path cannot diverge.
function commitNamedLocation(rawName, defaultName) {
  const state = getCurrentLocationState();
  state.name = rawName && rawName.trim() ? rawName.trim() : defaultName;
  memoryRepo.save(state);
  // Non-modal fade-out confirmation
  const conf = document.getElementById('saveLocationConfirmation');
  conf.style.display = 'block';
  conf.style.opacity = '1';
  setTimeout(() => {
    conf.style.opacity = '0';
    setTimeout(() => { conf.style.display = 'none'; }, 700);
  }, 1200);
  // If the locations list is open, refresh it (it may be the modal list).
  if (loadLocationModal.style.display !== 'none') {
    renderSavedLocations();
  }
  return state;
}

function hideSaveLocationPanel() {
  if (saveLocationPanel) saveLocationPanel.style.display = 'none';
}

saveLocationBtn.addEventListener('click', () => {
  const state = getCurrentLocationState();
  const defaultName = `Location (${state.centerX.toFixed(3)}, ${state.centerY.toFixed(3)}, zoom ${(1/state.scale).toFixed(2)})`;
  if (!saveLocationPanel || !saveLocationNameInput) return;
  // Prefill with the same generated default the prompt offered, so accepting
  // the default is one Enter away and the stored name is identical.
  saveLocationNameInput.value = defaultName;
  saveLocationPanel.style.display = 'flex';
  saveLocationNameInput.focus();
  saveLocationNameInput.select();
});

// Save is the only commit; Enter in the field takes the same path.
saveLocationConfirmBtn.addEventListener('click', () => {
  const state = getCurrentLocationState();
  const defaultName = `Location (${state.centerX.toFixed(3)}, ${state.centerY.toFixed(3)}, zoom ${(1/state.scale).toFixed(2)})`;
  commitNamedLocation(saveLocationNameInput ? saveLocationNameInput.value : '', defaultName);
  hideSaveLocationPanel();
});
saveLocationNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (saveLocationConfirmBtn) saveLocationConfirmBtn.click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideSaveLocationPanel();
  }
});
// Cancel stores NOTHING (the `prompt === null` branch it replaces).
saveLocationCancelBtn.addEventListener('click', hideSaveLocationPanel);

loadLocationBtn.addEventListener('click', () => {
  // A fresh page load of counts for the loads the user is about to trigger.
  resetLoadCounts();
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

// --- S4: location import, one path -----------------------------------------
// `importReport` is the observable the suite reads: how many records the last
// file contributed and how many the schema refused. Counted, never inferred.
let importReport = { accepted: 0, rejected: 0, fatal: null, problems: [] };

// The ONE place an imported file becomes stored locations. `readLocationsFile`
// (the real FileReader handler) and the `window.__fv.importPayload` observation
// hook both call THIS, so a test can never exercise a path the app does not use.
function importLocationsPayload(text) {
  // Bound the input BEFORE parsing: an oversized file is refused without ever
  // being handed to JSON.parse, so a hostile file cannot wedge the UI in the
  // parser (S4, "bound the import").
  const bytes = typeof text === 'string' ? text.length : 0;
  if (bytes > LOCATION_LIMITS.MAX_FILE_BYTES) {
    importReport = { accepted: 0, rejected: 0, fatal: null, problems: [] };
    showError('Import failed: the file is ' + bytes + ' characters; the maximum is ' + LOCATION_LIMITS.MAX_FILE_BYTES + '. Nothing was imported.');
    return importReport;
  }

  // Malformed JSON is a user-facing failure like every other: it is reported
  // through `#appMessage` and nothing escapes (S1). It used to be an `alert`,
  // and it must never be an uncaught exception.
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    importReport = { accepted: 0, rejected: 0, fatal: null, problems: [] };
    showError('Import failed: the file is not valid JSON (' + errorText(err) + '). Nothing was imported.');
    return importReport;
  }
  return importLocationsObject(payload);
}

// The second half of the import: a PARSED document is validated, the valid part
// is stored, and exactly one render happens. Split out so the payload-shape
// rules can be exercised with a value JSON cannot represent (NaN/Infinity).
function importLocationsObject(payload) {
  importReport = { accepted: 0, rejected: 0, fatal: null, problems: [] };

  const result = validateRecords(payload);
  if (result.fatal) {
    importReport.fatal = result.fatal;
    showError('Import failed: ' + result.fatal + '. Nothing was imported.');
    return importReport;
  }

  // Partial acceptance (docs/DECISIONS.md row 18): the schema-valid records are
  // stored and the invalid ones are refused with a visible reason. One bad
  // record does not cost the user every location in the file.
  result.accepted.forEach((loc) => memoryRepo.upsert(loc));
  importReport.accepted = result.accepted.length;
  importReport.rejected = result.rejected.length;
  importReport.problems = result.rejected.map(r => `record ${r.index}: ${r.reasons.join('; ')}`);
  renderSavedLocations();

  const firstProblem = importReport.problems[0];
  const problemNote = firstProblem ? ' First problem — ' + firstProblem + '.' : '';
  if (result.rejected.length) {
    showError('Imported ' + result.accepted.length + ' location(s); ' + result.rejected.length + ' record(s) were rejected by the import schema.' + problemNote);
  } else {
    showMessage('Imported ' + result.accepted.length + ' location(s).');
  }
  return importReport;
}

function readLocationsFile(file) {
  if (!file) return;
  if (file.size > LOCATION_LIMITS.MAX_FILE_BYTES) {
    showError('Import failed: "' + file.name + '" is ' + file.size + ' bytes; the maximum is ' + LOCATION_LIMITS.MAX_FILE_BYTES + '. Nothing was imported.');
    return;
  }
  const reader = new FileReader();
  reader.onload = (evt) => {
    // `text` may be a non-string only if the read itself failed; `importLocationsPayload`
    // treats that as an empty (and therefore invalid) payload rather than throwing.
    importLocationsPayload(typeof evt.target.result === 'string' ? evt.target.result : '');
  };
  reader.onerror = () => {
    showError('Import failed: the file could not be read. Nothing was imported.');
  };
  reader.readAsText(file);
}

importLocationsBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.addEventListener('change', (e) => readLocationsFile(e.target.files && e.target.files[0]));
  document.body.appendChild(input);
  input.click();
  setTimeout(() => document.body.removeChild(input), 5000);
});

// --- S4: the load path, counted ---------------------------------------------
// `viewApplications` counts `viewer.setView` calls made BY THE LOAD PATH, and
// `renderRequests` counts render dispatches made by it. They are reset when a
// load starts and read by the suite through `window.__fv.lastLoad`, so the
// claim "applies once, renders once" is measured rather than asserted.
let loadCounts = { viewApplications: 0, renderRequests: 0 };

function resetLoadCounts() {
  loadCounts = { viewApplications: 0, renderRequests: 0 };
}

// Apply ONE stored record: the fractal type, the view, the iteration count and
// the renderer, each exactly once, then start exactly one render in the mode
// that is now active.
function applyLoadedRecord(loc) {
  resetLoadCounts();
  typeSelect.value = loc.fractalType;
  webglCheckbox.checked = (loc.renderer === 'GPU');
  viewer.setFractal(loc.fractalType);
  // The ONE apply. FractalViewer.setView renders synchronously; that render
  // shows the old data at the new viewport, and the calculation below replaces
  // it with the correct pixels.
  viewer.setView({ centerX: loc.centerX, centerY: loc.centerY, scale: loc.scale });
  loadCounts.viewApplications += 1;
  // A saved/imported record can carry any iteration count. The slider clamps it
  // to what the UI can display and the kernel clamps what is actually stored, so
  // the readout never promises more than the renderers honour (S3/B5).
  maxIterSlider.value = String(loc.maxIter);
  viewer.setMaxIter(parseInt(maxIterSlider.value, 10));
  maxIterValue.textContent = String(viewer.maxIter);
  // Switch (or keep) the renderer for the record, then render exactly once.
  updateWebGLState();
  if (webglCheckbox.checked) renderWebGL();
  else startFractalCalculationWithTiming();
  loadCounts.renderRequests += 1;
  return loadCounts;
}

// A timestamp is a number (the schema guarantees it for imports), but an
// out-of-range one yields an invalid Date whose toLocaleString() is the literal
// "Invalid Date". Falling back keeps the row honest instead of printing junk.
function formatLocationTimestamp(timestamp) {
  const date = new Date(timestamp);
  return isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString();
}

function appendLocationInfo(parent, text, style, bold) {
  const span = document.createElement('span');
  if (bold) span.style.fontWeight = 'bold';
  if (style) span.style.cssText = style;
  // textContent, NEVER innerHTML: an imported string is data, never markup.
  span.textContent = text;
  parent.appendChild(span);
}

function renderSavedLocations() {
  // Clearing children is DOM manipulation, not content: no string is ever
  // parsed as markup here. (S4: the sink this replaces interpolated FIVE
  // attacker-controlled fields into one innerHTML template at the old line 180.)
  savedLocationsList.textContent = '';
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
    // Info — every field is written with textContent. `name`, the formatted
    // timestamp, `fractalType`, `maxIter` and `renderer` are all
    // attacker-controlled when they came from an imported file, so none of them
    // may reach HTML parsing (S4/B7).
    const info = document.createElement('div');
    info.style.flex = '1 1 0';
    info.style.overflow = 'hidden';
    appendLocationInfo(info, loc.name, '', true);
    info.appendChild(document.createElement('br'));
    appendLocationInfo(info, formatLocationTimestamp(loc.timestamp), 'font-size:0.9em;color:#ffc966;');
    info.appendChild(document.createElement('br'));
    appendLocationInfo(
      info,
      `Type: ${loc.fractalType}, Iter: ${loc.maxIter}, ${loc.renderer}`,
      'font-size:0.9em;color:#aaa;'
    );
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
    // S4: loading a record applies the view ONCE and renders ONCE.
    //
    // Before S4 this handler called `setView` three times (two of them identical,
    // both re-rendering synchronously through FractalViewer.setView) and called
    // `renderWebGL`/`startFractalCalculationWithTiming` twice per branch, so one
    // click re-rendered the same frame up to three times. Both counts are
    // observable (`window.__fv.lastLoad`), so "once" is counted, not asserted.
    loadBtn.addEventListener('click', () => applyLoadedRecord(loc));
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
// S6: the offer is non-modal and shown AT MOST ONCE. This remembers whether the
// offer is currently on screen, so the pin can observe "the user was actually
// asked" as a DOM fact rather than inferring it from a deferred callback.
let cpuSwitchOfferVisible = false;

function showZoomCapOffer() {
  if (!zoomCapOffer) return;
  cpuSwitchOfferVisible = true;
  zoomCapOffer.style.display = 'flex';
}

function hideZoomCapOffer() {
  cpuSwitchOfferVisible = false;
  if (zoomCapOffer) zoomCapOffer.style.display = 'none';
}

// The user asked for the CPU renderer from the cap offer. This is the SAME
// action as unticking the checkbox: it unchecks, which fires the checkbox's ONE
// change handler (updateWebGLState + a real CPU calculation). The cap itself was
// already applied by FractalViewer.clampScale before this ran.
function acceptCpuSwitchAtZoomCap() {
  hideZoomCapOffer();
  webglCheckbox.checked = false;
  webglCheckbox.dispatchEvent(new Event('change'));
}

// The user declined (or dismissed) the offer. The cap stays applied; the offer
// is never shown again, and `fv-zoom-limit` keeps reporting `prompted: false`
// for every further capped tick, so "once" stays observable.
function declineCpuSwitchAtZoomCap() {
  hideZoomCapOffer();
  deniedCpuSwitchAtZoomCap = true;
}

function handleZoomLimitReached() {
  showMessage('Zoom limit reached for GPU mode (~' + WEBGL_ZOOM_CAP.toLocaleString() + 'x). Offer to switch to CPU for deeper zoom.');
  // The cap is hit on every further wheel tick, but the user is ASKED only once.
  // Report both facts to the observer so "once" is observable, not asserted from
  // behaviour. `prompted` means exactly "the user was actually asked", i.e. this
  // is the one tick that puts the offer on screen.
  const prompted = !askedCpuSwitchAtZoomCap && !deniedCpuSwitchAtZoomCap;
  try {
    window.dispatchEvent(new CustomEvent('fv-zoom-limit', {
      detail: { scale: viewer.view.scale, prompted },
    }));
  } catch (_) { /* observation only */ }
  if (!prompted) return;
  askedCpuSwitchAtZoomCap = true;
  // NON-MODAL (S6): the offer is a positioned element with two buttons, shown
  // synchronously. It blocks nothing — the clamp was already applied by the
  // caller and the render it triggers proceeds — and BOTH answers leave the cap
  // in force, because neither one touches `viewer.zoomLimit`. This replaces the
  // S1 `window.confirm` (old `app.js:394`), retired as the smell row 9 recorded.
  showZoomCapOffer();
}

// The offer's two real answers. They are wired once, here, so the offer cannot
// be shown without a way to answer it.
if (zoomCapSwitchBtn) zoomCapSwitchBtn.addEventListener('click', acceptCpuSwitchAtZoomCap);
if (zoomCapDismissBtn) zoomCapDismissBtn.addEventListener('click', declineCpuSwitchAtZoomCap);


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
// S6 deleted four variables that were declared here and never read anywhere:
// `currentResult`, `aborting`, `debounceTimer` and `lastJobParams`. S2 had
// already replaced the abort-flag and debounce designs they belonged to; the
// dead declarations survived until S6 (the probe's "dead module state").

// --- 3D Mode Integration ---
let fractal3D = null;
let in3DMode = false;

let colorCycleActive = true;
let colorCycleOffset = 0;
let colorCycleLastTime = 0;
let colorCycleRequestId = null;
// Colour-cycle frames that actually ran. Exposed through `window.__fv` (S5) so
// "the heightmap count did not advance across colour ticks" cannot be vacuous —
// a stopped cycle would also leave the count untouched.
let colorCycleTicks = 0;

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

// --- S5: 3D mode entry is AWAITED --------------------------------------------
// `Fractal3DViewer.init()` is async and three.js constructs its WebGLRenderer
// synchronously inside it. Before S5 it was called without `await` or `catch`
// after both 2D canvases had been hidden, so a GPU-less or driver-blocklisted
// machine got an unhandled rejection and a black screen with no message. It is
// awaited now; every failure tears the 3D viewer down, restores the 2D UI and
// reports through `#appMessage`.
//
// `threeDGeneration` invalidates an in-flight init when the user leaves 3D mode
// (or re-enters) while it is still starting, so a late success or failure cannot
// hide or restore the wrong UI state.
let threeDGeneration = 0;

// Put the UI back exactly where a normal 3D exit leaves it. Safe to call when
// init() failed before it hid anything (the 2D UI is simply re-asserted).
function restore2DFrom3D() {
  fractal3D = null;
  in3DMode = false;
  infoElem.style.display = '';
  // Restores (and repaints) whichever 2D renderer was active before 3D mode.
  updateWebGLState();
}

async function enter3DMode() {
  if (in3DMode) return;
  const generation = ++threeDGeneration;
  in3DMode = true;
  let viewer3d = null;
  try {
    viewer3d = new Fractal3DViewer(document.body, FractalKernel, getFractalParams);
    fractal3D = viewer3d;
    await viewer3d.init();
  } catch (err) {
    if (generation !== threeDGeneration) return; // a later exit already restored
    try { if (viewer3d) viewer3d.exit(); } catch (_) { /* teardown must not mask the cause */ }
    restore2DFrom3D();
    showError('3D mode unavailable — WebGL could not be initialised: ' + errorText(err));
    return;
  }
  if (generation !== threeDGeneration) {
    // The user left 3D mode while init() was in flight; do not hide the 2D UI.
    try { if (viewer3d) viewer3d.exit(); } catch (_) { /* already torn down */ }
    return;
  }
  // Hide BOTH 2D canvases: three.js appends its own canvas to <body>, and a
  // visible in-flow canvas would push that one below the fold. Only on SUCCESS.
  canvas.style.display = 'none';
  canvasWebGL.style.display = 'none';
  infoElem.style.display = 'none';
}

function exit3DMode() {
  if (!in3DMode) return;
  in3DMode = false;
  threeDGeneration++; // invalidate an init() that is still in flight
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
  // D1: the payload carries a Float32Array of SMOOTH escape values, with NaN
  // marking the cells not yet calculated (it used to be an Int32Array of integer
  // counts with -1). The validation is unchanged in INTENT — a malformed payload
  // must never become a frame — and is what the S2 pin holds it to: an absent
  // payload, a non-byte-length payload, a payload that is not a whole number of
  // 4-byte entries, or one of the wrong length is refused with a visible reason.
  if (!rawResult || typeof rawResult.byteLength !== 'number' || rawResult.byteLength % 4 !== 0) {
    throw new Error('worker result is not a Float32Array payload');
  }
  const smoothResult = new Float32Array(rawResult);
  const expected = progress.width * progress.height;
  if (smoothResult.length !== expected) {
    throw new Error(`worker result has ${smoothResult.length} entries, expected ${expected}`);
  }
  // The buffer is indexed against the iteration cap the JOB ran at, not against
  // whatever the viewer holds now: `viewer.maxIter` is only updated when the
  // slider change reaches setMaxIter, and a job started from the restored view can
  // carry a different cap. Passing the job's own cap keeps the "exactly maxIter is
  // inside ⇒ black" test aligned with the values in the buffer.
  viewer.setData(smoothResult, progress.jobParams.maxIter);
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
// These run on the hottest interaction paths (every mousedown, every wheel tick,
// every view-change render). They carry NO logging: the four `[FractalMouse]`
// console.logs that used to sit here were removed by S6, and nothing replaced
// them, because a log on this path is per-event work on the render loop (S6 pin:
// tests/hygiene.spec.js "no app console output during a scripted interaction").
function onMouseDown(e) {
  if (viewer && viewer.onMouseDown) viewer.onMouseDown(e);
}
function onWheel(e) {
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
    renderWebGL();
  } else {
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
  colorCycleTicks++;
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
  // `setMaxIter` applies the kernel's ONE clamp; the slider cannot exceed the cap,
  // but the stored value must still be the clamped one (S3/B5).
  viewer.setMaxIter(parseInt(maxIterSlider.value, 10));
  maxIterValue.textContent = viewer.maxIter;
  startFractalCalculationWithTiming();
});

// --- Helper: map a palette name to the shader's index ------------------------
// The map itself lives in the kernel's COLOR_SCHEMES table (templated into the
// shader as `#define CS_*`), so the CPU name and the GPU index cannot drift.
function getColorSchemeIdx() {
  return FractalKernel.indexForColorScheme(viewer.colorScheme);
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
    // The fractal-type index comes from the kernel's FRACTAL_TYPES table, which is
    // the same table the shader's `#define FT_*` values are templated from, so a
    // type name and its GLSL branch can never disagree (S3 pin 3).
    const fractalTypeInt = FractalKernel.indexForType(viewer.fractalType);
    const juliaParams = (fractalTypeInt === FractalKernel.indexForType('julia')) ? viewer.juliaParams : undefined;
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
// The precision-hop pin's baseline buffer (D1). Test-only state: `captureShiftBaseline`
// stores a copy of the frame the worker produced, so the pin can re-render that SAME
// frame with a shifted escape value instead of accumulating shifts.
let shiftBaseline = null;
let shiftBaselineMaxIter = 0;
window.__fv = Object.freeze({
  getView: () => ({ ...viewer.view }),
  setScale: (scale) => viewer.setView({ ...viewer.view, scale }),
  // Move the view to an explicit centre and scale through the REAL setView (the
  // same entry point the startup animation uses; the clamp still applies). The
  // zoom-sweep pin needs a centre whose window actually crosses the set boundary.
  setView: (view) => viewer.setView({ ...viewer.view, ...view }),
  runAnimationFrame: () => { viewer.setView({ ...viewer.view, scale: viewer.view.scale }); },
  renderWebGL: () => renderWebGL(),
  forceFallback: () => handleWebGLFailure('WebGL failure forced for observation.'),
  simulateContextLoss: () => handleWebGLLoss('Context loss simulated.'),
  zoomCap: WEBGL_ZOOM_CAP,
  minScale: WEBGL_MIN_SCALE,
  // S6: the non-modal zoom-cap offer, observed as a DOM fact. `offered` is
  // "the offer is on screen right now"; `prompted` is "the one-time ask has
  // happened" (which is exactly what `fv-zoom-limit`'s `prompted` reports), so a
  // one-line regression in either mechanism is visible without pixel inference.
  zoomCapOffered: () => cpuSwitchOfferVisible,
  zoomCapPrompted: () => askedCpuSwitchAtZoomCap,
  liveRenderers: () => (typeof window.__fvLiveWebglRenderers === 'number' ? window.__fvLiveWebglRenderers : 0),
  animationSettled: () => zoomAnimationSettled,
  // --- S5 3D-truth observables (B8 + the awaited 3D failure path) ---
  // How many times the 3D viewer has EVALUATED the fractal heightmap. A colour
  // change (offset or scheme) must leave this number untouched: counted, not
  // inferred. Before S5 a colour tick called regenerateMesh, i.e. a full
  // resolution^2 fractal evaluation per animation frame.
  heightmapCalls: () => (fractal3D ? fractal3D.heightmapCalls : 0),
  // Colour-cycle frames that actually ran, so "the heightmap count did not
  // advance" cannot be vacuous (zero ticks would also not advance it).
  colorCycleTicks: () => colorCycleTicks,
  in3DMode: () => in3DMode,
  // The 3D mesh exists and is on screen (init() finished its first rebuild).
  threeDReady: () => !!(fractal3D && fractal3D.terrain),
  colorScheme3D: () => (fractal3D ? fractal3D.colorScheme : null),
  colorOffset3D: () => (fractal3D ? fractal3D.colorOffset : 0),
  terrainVertexCount: () => (fractal3D && fractal3D.terrain
    ? fractal3D.terrain.geometry.attributes.position.count
    : 0),
  // The height range actually stored on the LIVE geometry (read from the
  // position attribute, not from a cached field), so the palette pin derives its
  // expectation from what is on the mesh.
  terrainHeightRange: () => {
    if (!fractal3D || !fractal3D.terrain) return null;
    const pos = fractal3D.terrain.geometry.attributes.position;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < pos.count; ++i) {
      const z = pos.getZ(i);
      if (z < min) min = z;
      if (z > max) max = z;
    }
    return { min, max, count: pos.count };
  },
  // (z, r, g, b) for the requested vertex indices, so a colour rewrite can be
  // checked against the geometry that is actually rendered.
  sample3DTerrain: (indices) => {
    if (!fractal3D || !fractal3D.terrain) return null;
    const g = fractal3D.terrain.geometry;
    const pos = g.attributes.position;
    const col = g.attributes.color;
    if (!col) return null;
    return indices.map((i) => ({
      z: pos.getZ(i),
      r: col.getX(i),
      g: col.getY(i),
      b: col.getZ(i)
    }));
  },
  // three.js `BufferAttribute.version`: it is incremented by `needsUpdate = true`
  // and `WebGLAttributes.update` re-uploads a buffer exactly when
  // `cached.version < attribute.version`. So this counter observes whether a
  // colour rewrite was actually MARKED FOR UPLOAD, which the CPU-side values in
  // `sample3DTerrain` cannot show (a rewrite that never sets `needsUpdate` leaves
  // the GPU mesh frozen with correct-looking array values).
  colorAttributeVersion: () => {
    const terrain = fractal3D && fractal3D.terrain;
    const col = terrain && terrain.geometry && terrain.geometry.attributes.color;
    return col ? col.version : -1;
  },
  // Drive the REAL 3D colour paths with known values (the same way
  // `forceFallback` and `importPayload` drive theirs); adds no production path.
  set3DColorOffset: (offset) => {
    if (!fractal3D) throw new Error('3D mode is not active');
    fractal3D.setColorOffset(offset);
  },
  set3DColorScheme: (scheme) => {
    if (!fractal3D) throw new Error('3D mode is not active');
    fractal3D.setColorScheme(scheme);
  },
  // --- D1 smooth-colour observables (the continuous escape value) ---
  // The EXACT continuous colour of an arbitrary smooth value through the kernel's
  // ONE definition (no table quantisation), so a pin can hold the quantised table
  // the render writes to the definition it samples.
  colorAtSmoothIteration: (value, maxIter) => viewer.colorAtSmoothIteration(value, maxIter),
  // The same for a value the viewer is actually holding, through the QUANTISED
  // table the render writes (so the pin can compare the table against the exact
  // definition instead of restating either).
  colorForValue: (value, maxIter) => viewer.colorForValue(value, maxIter),
  // The kernel's exact continuous definition, independent of the UI state, so a
  // pin can check the formula itself (inside ⇒ exactly maxIter, finiteness, ...).
  smoothValue: (escapeRadiusSq, n, maxIter) => FractalKernel.smoothIterationValue(escapeRadiusSq, n, maxIter),
  // The kernel constant the GLSL is templated with, so a pin can hold the shader
  // and the kernel to the same number instead of trusting the source.
  smoothLogBailout: FractalKernel.SMOOTH_LOG_BAILOUT,
  bailoutSq: FractalKernel.BAILOUT_SQ,
  smoothPixel: (type, px, py, maxIter, jx, jy) =>
    FractalKernel.iteratePixelSmooth(type, px, py, maxIter, jx, jy),
  // The ONE uncalculated-placeholder colour, from the kernel.
  uncalculatedColor: () => FractalKernel.UNCALCULATED_COLOR.slice(),
  // The whole escape-value buffer as a plain array (the pin computes its
  // statistics inside the page, so this never crosses the wire).
  iterBufferAll: () => (viewer.imageData ? Array.from(viewer.imageData) : null),
  // Render the CURRENT buffer with every finite escape value shifted by `epsilon`,
  // through the REAL `setData`/`render` path. This models a precision hop exactly:
  // the same view, the same buffer, escape values differing by a sub-iteration
  // amount (what a rebased reference orbit or a float32 rounding difference
  // produces). It is an observation-only entry point like `deliverWorkerMessage`:
  // the only production code it runs is the colour mapping under test.
  //
  // The baseline is captured EXPLICITLY so repeated shifts do not accumulate, and
  // dropped explicitly so a later real frame is used again.
  captureShiftBaseline: () => {
    if (!viewer.imageData) return false;
    shiftBaseline = viewer.imageData.slice();
    shiftBaselineMaxIter = viewer.maxIter;
    return true;
  },
  clearShiftBaseline: () => { shiftBaseline = null; },
  renderShiftedBuffer: (epsilon) => {
    if (!shiftBaseline) return false;
    const shifted = new Float32Array(shiftBaseline.length);
    for (let i = 0; i < shiftBaseline.length; ++i) {
      const v = shiftBaseline[i];
      shifted[i] = v === v ? v + epsilon : v;
    }
    viewer.setData(shifted, shiftBaselineMaxIter);
    return true;
  },
  // The ONE uncalculated-placeholder colour, from the kernel.
  uncalculatedColor: () => FractalKernel.UNCALCULATED_COLOR.slice(),
  // --- S3 kernel observables (the ONE cap, observed not inferred) ---
  // `maxIterCap` is the kernel constant the slider max, the clamps and the shader
  // loop bound all derive from. `shaderMaxIter` is the value actually templated
  // into the fragment source, and `shaderLoopBounds` the bound token of every loop
  // site in it — so the suite can see the template, not just the constant.
  maxIterCap: FractalKernel.MAX_ITER,
  maxIter: () => viewer.maxIter,
  shaderMaxIter: () => (webglRenderer ? webglRenderer.shaderMaxIter : null),
  shaderLoopBounds: () => (webglRenderer && webglRenderer.shaderLoopBounds
    ? webglRenderer.shaderLoopBounds.slice()
    : null),
  // D1: the GPU's smooth-colour constants as ACTUALLY templated, so a pin can hold
  // the shader and the kernel to the same numbers instead of trusting the source.
  shaderSmoothLogBailout: () => (webglRenderer ? webglRenderer.shaderSmoothLogBailout : null),
  // The fragment source as generated. Read-only; the shader-formula pin reads the
  // smooth expression out of it rather than inferring it from pixels.
  shaderSource: () => (webglRenderer && webglRenderer.shaderSource ? webglRenderer.shaderSource : null),
  // The kernel's own tables, so a test can drive every supported type/palette
  // without restating the list in a second fixture.
  fractalTypes: () => FractalKernel.FRACTAL_TYPES.map((t) => t.value),
  colorSchemes: () => FractalKernel.COLOR_SCHEMES.map((s) => s.value),
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
  // --- S4 input-truth observables ---
  // Import a payload through the REAL import path (`importLocationsPayload`,
  // the same function the FileReader handler calls): schema validation, the
  // size bound, `#appMessage` reporting and the single re-render. The suite
  // uses this instead of driving the OS file picker; it adds no production path.
  importPayload: (text) => importLocationsPayload(text),
  // The same import with an already-parsed document. The suite needs this for
  // the payload shapes JSON cannot express (NaN, Infinity); the validation and
  // storage below are the identical code the text path runs.
  importDocument: (payload) => importLocationsObject(payload),
  // What the last imported file contributed and what was refused. Counted.
  importReport: () => ({ ...importReport, problems: importReport.problems.slice() }),
  // The declared bounds, so a test asserts against the app's own numbers
  // instead of restating them.
  importLimits: () => ({ ...LOCATION_LIMITS }),
  // How many times the last load applied the view and asked for a render.
  lastLoad: () => ({ ...loadCounts }),
  // Load a stored record through the REAL listener path (the same function the
  // Load button calls), so the counted path is the production one.
  loadLocation: (id) => {
    const loc = memoryRepo.get(id);
    if (!loc) throw new Error('no stored location with that id');
    return applyLoadedRecord(loc);
  },
  // The ids the store currently holds, in display order.
  storedLocationIds: () => memoryRepo.getAll('timestamp').map(loc => loc.id),
  // S6: the stored records themselves (names included), so the save/naming pin
  // can prove the non-modal panel commits the SAME record the prompt used to.
  // Read-only copy; the schema still owns what a stored record may contain.
  storedLocations: () => memoryRepo.getAll('timestamp').map(loc => ({ ...loc })),
  // Store a record WITHOUT the schema, then render the list. This is not a
  // bypass of the import boundary — it exists so the RENDERING pin can be driven
  // with a hostile `renderer`/`fractalType` that the schema would otherwise
  // reject before it ever reached the sink. Rendering must treat every field as
  // text no matter how the record got into the store (e.g. a future persisted
  // or third-party record), and this is the only way to prove that.
  saveUnvalidated: (record) => {
    memoryRepo.save(record);
    renderSavedLocations();
    return memoryRepo.getAll('timestamp').map(loc => loc.id);
  },
});

// Also update on maxIter/type/params changes
[typeSelect, colorSchemeSelect, maxIterSlider].forEach(el => {
  el.addEventListener('change', () => {
    if (webglCheckbox.checked) renderWebGL();
  });
});
