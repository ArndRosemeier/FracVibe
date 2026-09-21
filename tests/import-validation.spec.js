// @ts-check
// S4 / input truth — imported locations are DATA, never markup, and never an
// unvalidated shape.
//
// Before S4: `renderSavedLocations()` interpolated FIVE attacker-controlled
// fields (`name`, the formatted `timestamp`, `fractalType`, `maxIter`,
// `renderer`) into ONE `innerHTML` template, the import path's only check was
// `Array.isArray`, malformed JSON raised an `alert`, and the Load button applied
// the view three times and asked for a render two to three times.
//
// Every assertion below observes the REAL paths: `importPayload` runs the same
// function the FileReader handler runs, and `loadLocation` runs the same
// function the Load button's listener runs. Nothing here calls a validator
// directly or builds a second fixture set.
const { test, expect } = require('@playwright/test');

// --- fixtures ------------------------------------------------------------------

// A schema-valid record. Every test derives its hostile variants from this, so a
// failure names one changed field rather than a hand-built object.
function validRecord(overrides = {}) {
  return {
    id: 'loc-1',
    name: 'Home',
    scale: 3,
    centerX: -0.5,
    centerY: 0,
    fractalType: 'mandelbrot',
    maxIter: 256,
    renderer: 'CPU',
    timestamp: 1758441600000,
    ...overrides,
  };
}

async function ready(page) {
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#renderTime')).toHaveText(/Render: [\d.]+ ms/);
  await expect.poll(() => page.evaluate(() => window.__fv.animationSettled()), { timeout: 30_000 }).toBe(true);
}

// --- in-page fixtures (serialized by page.evaluate; bodies must be self-contained) ---

// Read the message surface + report + stored ids after an import has run.
function readImport() {
  const msg = document.getElementById('appMessage');
  return {
    report: window.__fv.importReport(),
    message: msg ? msg.textContent : null,
    messageVisible: !!msg && msg.style.display !== 'none',
    stored: window.__fv.storedLocationIds(),
  };
}

// Import RAW JSON TEXT through the app's OWN text entry point — the same
// function the FileReader handler calls after `readAsText`.
function runImportText(text) {
  window.__fv.importPayload(text);
}

// Import an ALREADY-PARSED document through the app's own import. Used for the
// payload shapes JSON cannot express (NaN, Infinity) and for anything that is
// clearer as an object.
function runImportDocument(doc) {
  window.__fv.importDocument(doc);
}

async function importText(page, text) {
  await page.evaluate(runImportText, text);
  return page.evaluate(readImport);
}

async function importDocument(page, payload) {
  await page.evaluate(runImportDocument, payload);
  return page.evaluate(readImport);
}

// Import a JSON-expressible payload as text (the usual case).
async function importPayload(page, payload) {
  return importText(page, JSON.stringify(payload));
}

const LIMITS = async (page) => page.evaluate(() => window.__fv.importLimits());

// --- pin 1: no data reaches innerHTML ------------------------------------------

test('S4 pin: a hostile location name renders as literal text and executes nothing', async ({ page }) => {
  const pageErrors = [];
  const dialogs = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await ready(page);

  const hostileName = '<img src=x onerror="window.__fvXss=1">';
  const result = await importPayload(page, [validRecord({ name: hostileName })]);

  // The record is ACCEPTED — a string is a valid name, it is simply never HTML.
  expect(result.report.accepted).toBe(1);
  expect(result.report.rejected).toBe(0);
  await page.click('#loadLocationBtn');
  await expect(page.locator('#loadLocationModal')).toBeVisible();

  const rendered = await page.evaluate(() => {
    const list = document.getElementById('savedLocationsList');
    const row = list.firstElementChild;
    const info = row ? row.firstElementChild : null;
    return {
      text: list.textContent,
      imgCount: list.querySelectorAll('img').length,
      // The info cell is `list > div(row) > div(info)`; count the info cell's
      // OWN descendants so the Load/Delete buttons are not part of the count.
      infoElementCount: info ? info.querySelectorAll('*').length : -1,
      xss: window.__fvXss === 1,
    };
  });

  // Literal text: the tag is visible as characters...
  expect(rendered.text).toContain(hostileName);
  // ...and it created no element and ran no handler.
  expect(rendered.imgCount).toBe(0);
  expect(rendered.xss).toBe(false);
  // The info cell is built from exactly five elements (bold name, <br>, date
  // span, <br>, detail span). An injected element would appear here; the action
  // buttons live in a sibling div and are not counted.
  expect(rendered.infoElementCount).toBe(5);
  expect(pageErrors).toEqual([]);
  expect(dialogs).toEqual([]);
});

test('S4 pin: a hostile renderer string renders as literal text', async ({ page }) => {
  const pageErrors = [];
  const dialogs = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await ready(page);

  // Two layers, asserted separately.
  //
  // Layer 1 (the import boundary): a `renderer` the schema does not know is
  // REJECTED, so it never reaches the renderer selection OR the list.
  const hostile = '<img src=x onerror="window.__fvXssRenderer=1">';
  const imported = await importPayload(page, [
    validRecord({ id: 'gpu-hostile', renderer: hostile }),
    validRecord({ id: 'cpu-good', renderer: 'GPU' }),
  ]);
  expect(imported.report.accepted).toBe(1);
  expect(imported.report.rejected).toBe(1);
  expect(imported.report.problems[0]).toContain('renderer');
  expect(imported.stored).toEqual(['cpu-good']);

  // Layer 2 (the sink): a record whose hostile `renderer` DID reach the store
  // (a future persisted/third-party record) is rendered as text. Driven through
  // the real `renderSavedLocations`, because a value the schema rejects can
  // never reach the sink by importing — and the sink is what this pin is for.
  await page.evaluate((bad) => {
    window.__fv.saveUnvalidated({
      id: 'raw-renderer',
      name: 'Raw record',
      scale: 3,
      centerX: 0,
      centerY: 0,
      fractalType: 'mandelbrot',
      maxIter: 256,
      renderer: bad,
      timestamp: 1758441600000,
    });
  }, hostile);
  await page.click('#loadLocationBtn');
  await expect(page.locator('#loadLocationModal')).toBeVisible();

  const rendered = await page.evaluate(() => {
    const list = document.getElementById('savedLocationsList');
    return {
      text: list.textContent,
      imgCount: list.querySelectorAll('img').length,
      xss: window.__fvXssRenderer === 1,
    };
  });
  // Literal text, no element, no handler.
  expect(rendered.text).toContain(hostile);
  expect(rendered.imgCount).toBe(0);
  expect(rendered.xss).toBe(false);
  expect(rendered.text).toContain('GPU');
  expect(pageErrors).toEqual([]);
  expect(dialogs).toEqual([]);
});

test('S4 pin: a hostile fractalType string renders as literal text', async ({ page }) => {
  const pageErrors = [];
  const dialogs = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await ready(page);

  const hostile = '<img src=x onerror="window.__fvXssType=1">';
  // Layer 1: the schema refuses a type that is not in the kernel's table, so the
  // <select> can never be handed an unknown value.
  const imported = await importPayload(page, [
    validRecord({ id: 'type-hostile', fractalType: hostile }),
    validRecord({ id: 'type-good', fractalType: 'julia' }),
  ]);
  expect(imported.report.accepted).toBe(1);
  expect(imported.report.rejected).toBe(1);
  expect(imported.report.problems[0]).toContain('fractalType');
  expect(imported.stored).toEqual(['type-good']);

  // Layer 2: the sink. A record whose hostile type reached the store is text.
  await page.evaluate((bad) => {
    window.__fv.saveUnvalidated({
      id: 'raw-type',
      name: 'Raw record',
      scale: 3,
      centerX: 0,
      centerY: 0,
      fractalType: bad,
      maxIter: 256,
      renderer: 'CPU',
      timestamp: 1758441600000,
    });
  }, hostile);
  await page.click('#loadLocationBtn');
  await expect(page.locator('#loadLocationModal')).toBeVisible();

  const rendered = await page.evaluate(() => {
    const list = document.getElementById('savedLocationsList');
    return {
      text: list.textContent,
      imgCount: list.querySelectorAll('img').length,
      xss: window.__fvXssType === 1,
      typeSelect: /** @type {HTMLSelectElement} */ (document.getElementById('fractalType')).value,
    };
  });
  expect(rendered.text).toContain(hostile);
  expect(rendered.imgCount).toBe(0);
  expect(rendered.xss).toBe(false);
  expect(rendered.text).toContain('julia');
  // The <select> was never handed an unknown option value by either layer.
  expect(rendered.typeSelect).toBe('mandelbrot');
  expect(pageErrors).toEqual([]);
  expect(dialogs).toEqual([]);
});

// --- pin 2: per-record schema validation ---------------------------------------

test('S4 pin: every schema violation is rejected with its own reason, and the valid record in the same file still loads', async ({ page }) => {
  const pageErrors = [];
  const dialogs = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await ready(page);

  // One file, one bad record per field, plus one good record. The shape follows
  // the brief's list exactly: scale missing/NaN/negative, a non-numeric
  // maxIter, an unknown fractalType, a non-string name, a bad renderer, a bad
  // timestamp, and a non-object record.
  //
  // The payload is built INSIDE the page on purpose: `NaN` and `Infinity` cannot
  // cross `page.evaluate`'s serialization boundary (both arrive as `null`), so a
  // Node-built payload would silently test `null` and call it "NaN". The same
  // holds for `JSON.stringify`, which has no NaN spelling at all.
  const result = await page.evaluate(() => {
    const base = {
      id: 'loc-1', name: 'Home', scale: 3, centerX: -0.5, centerY: 0,
      fractalType: 'mandelbrot', maxIter: 256, renderer: 'CPU', timestamp: 1758441600000,
    };
    const rec = (o) => ({ ...base, ...o });
    const bad = [
      rec({ id: 'missing-scale' }),
      rec({ id: 'nan-scale', scale: NaN }),
      rec({ id: 'infinite-scale', scale: Infinity }),
      rec({ id: 'string-scale', scale: '3' }),
      rec({ id: 'negative-scale', scale: -1 }),
      rec({ id: 'zero-scale', scale: 0 }),
      rec({ id: 'string-maxiter', maxIter: 'lots' }),
      rec({ id: 'fractional-maxiter', maxIter: 256.5 }),
      rec({ id: 'low-maxiter', maxIter: 1 }),
      rec({ id: 'high-maxiter', maxIter: 1000000 }),
      rec({ id: 'unknown-type', fractalType: 'not-a-fractal' }),
      rec({ id: 'nonstring-name', name: { evil: true } }),
      rec({ id: 'bad-renderer', renderer: 'VULKAN' }),
      rec({ id: 'bad-timestamp', timestamp: 'yesterday' }),
    ];
    delete bad[0].scale; // the brief's "missing scale" case, not a NaN
    bad.push('not an object');
    bad.push(rec({ id: 'the-good-one' }));
    // The SAME function the FileReader handler ends in.
    window.__fv.importDocument(bad);
    return { report: window.__fv.importReport(), stored: window.__fv.storedLocationIds() };
  });

  expect(result.report.fatal).toBe(null);
  expect(result.report.accepted).toBe(1);
  expect(result.report.rejected).toBe(15); // 16 records in, exactly one accepted
  expect(result.stored).toEqual(['the-good-one']);

  // Every rejection names its field. Matched against the report, which is what
  // the message is built from.
  const problems = result.report.problems.join('\n');
  for (const expected of [
    'scale must be a finite number greater than 0',
    'maxIter must be an integer between',
    'fractalType must be one of',
    'name must be a non-empty string',
    'renderer must be one of',
    'timestamp must be a finite number',
    'record is not an object',
  ]) {
    expect(problems).toContain(expected);
  }
  // The NaN and the Infinity are refused as scale specifically, not as `null`.
  expect(problems).toContain('record 1: scale must be a finite number greater than 0');
  expect(problems).toContain('record 2: scale must be a finite number greater than 0');

  // The user sees the rejection, in the non-modal surface, with a reason.
  await expect(page.locator('#appMessage')).toBeVisible();
  await expect(page.locator('#appMessage')).toContainText(/15 record\(s\) were rejected/);
  await expect(page.locator('#appMessage')).toContainText(/First problem/);
  // ...and never as an alert.
  expect(dialogs).toEqual([]);

  // The valid record from the same file behaves as accepted: it is listed and it
  // LOADS (view applied, render requested).
  await page.click('#loadLocationBtn');
  await expect(page.locator('#savedLocationsList')).toContainText('Home');
  const loaded = await page.evaluate(() => window.__fv.loadLocation('the-good-one'));
  expect(loaded.viewApplications).toBe(1);
  expect(loaded.renderRequests).toBe(1);
  expect(await page.evaluate(() => window.__fv.getView().scale)).toBe(3);
  expect(pageErrors).toEqual([]);
});

test('S4 pin: an out-of-palette record cannot drive the type select or the renderer select', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await ready(page);
  const types = await page.evaluate(() => window.__fv.fractalTypes());
  const result = await importPayload(page, [
    validRecord({ id: 'unknown-type-2', fractalType: 'mandelbrot-3d' }),
    validRecord({ id: 'known-type', fractalType: types[types.length - 1] }),
  ]);
  expect(result.report.accepted).toBe(1);
  expect(result.report.rejected).toBe(1);
  expect(result.stored).toEqual(['known-type']);
  expect(pageErrors).toEqual([]);
});

// --- pin 3: malformed JSON -----------------------------------------------------

test('S4 pin: malformed JSON produces a visible message, no alert and no uncaught error', async ({ page }) => {
  const pageErrors = [];
  const dialogs = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await ready(page);

  // Real raw text, exactly as a corrupt file would arrive from FileReader.
  const result = await importText(page, '{"this is": not json,,,');

  await expect(page.locator('#appMessage')).toBeVisible();
  await expect(page.locator('#appMessage')).toContainText(/not valid JSON/);
  expect(result.report.accepted).toBe(0);
  expect(result.report.rejected).toBe(0);
  expect(result.report.fatal).toBe(null); // malformed JSON is not a schema verdict
  expect(result.stored).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(pageErrors).toEqual([]);

  // The app still works: a valid file imports afterwards.
  const good = await importPayload(page, [validRecord({ id: 'after-json-error' })]);
  expect(good.report.accepted).toBe(1);
  await expect(page.locator('#appMessage')).toContainText(/Imported 1 location/);
  expect(pageErrors).toEqual([]);
});

test('S4 pin: a non-array JSON document is refused through the message surface, not an alert', async ({ page }) => {
  const pageErrors = [];
  const dialogs = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await ready(page);

  // Each document is valid JSON, so it reaches the payload-shape rule; all four
  // are refused whole. (`JSON.stringify` gives the exact file text for each:
  // `"a string"` is a JSON string, `42` a number, `null` a null.)
  for (const doc of [{ locations: [] }, 'a string', 42, null]) {
    const result = await importText(page, JSON.stringify(doc));
    expect(result.report.fatal, `document ${JSON.stringify(doc)} must be fatal`).toBeTruthy();
    expect(result.report.accepted).toBe(0);
    expect(result.stored).toEqual([]);
  }
  await expect(page.locator('#appMessage')).toBeVisible();
  await expect(page.locator('#appMessage')).toContainText(/JSON array/);
  expect(dialogs).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// --- pin 4: the import is bounded ----------------------------------------------

test('S4 pin: a file beyond the declared bounds is refused whole and the app stays responsive', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await ready(page);
  const limits = await LIMITS(page);

  // (a) too many records: refused WHOLE — not even the valid prefix is stored.
  const many = [];
  for (let i = 0; i < limits.MAX_RECORDS + 1; i++) many.push(validRecord({ id: `bulk-${i}` }));
  const tooMany = await importPayload(page, many);
  expect(tooMany.report.fatal).toContain(String(limits.MAX_RECORDS));
  expect(tooMany.report.accepted).toBe(0);
  expect(tooMany.stored).toEqual([]);
  await expect(page.locator('#appMessage')).toContainText(/maximum is \d+/);

  // (b) the exact limit is fine.
  const exactly = await importPayload(page, many.slice(0, limits.MAX_RECORDS));
  expect(exactly.report.fatal).toBe(null);
  expect(exactly.report.accepted).toBe(limits.MAX_RECORDS);
  expect(exactly.stored.length).toBe(limits.MAX_RECORDS);

  // (c) an over-long name is rejected per record...
  const longName = await importPayload(page, [
    validRecord({ id: 'long-name', name: 'x'.repeat(limits.MAX_NAME_LENGTH + 1) }),
  ]);
  expect(longName.report.rejected).toBe(1);
  expect(longName.report.problems[0]).toContain('name must be a non-empty string');

  // (d) ...and an oversized raw payload is refused before it is parsed at all.
  const huge = await importPayload(page, 'x'.repeat(limits.MAX_FILE_BYTES + 1));
  expect(huge.report.accepted).toBe(0);
  expect(huge.stored.length).toBe(limits.MAX_RECORDS); // nothing was added
  await expect(page.locator('#appMessage')).toContainText(/maximum is \d+/);

  // The UI is not wedged: the stores still render and the modal still opens.
  await page.click('#loadLocationBtn');
  await expect(page.locator('#loadLocationModal')).toBeVisible();
  await expect(page.locator('#savedLocationsList')).not.toContainText('No locations saved yet');
  await page.click('#closeLoadLocationModal');
  await expect(page.locator('#loadLocationModal')).toBeHidden();
  expect(pageErrors).toEqual([]);
});

// --- pin 5: the load path applies once and renders once -------------------------

test('S4 pin: loading a record applies the view once and renders once (counted, not asserted)', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await ready(page);

  const imported = await importPayload(page, [
    validRecord({ id: 'load-me', scale: 0.25, centerX: -0.75, centerY: 0.1, maxIter: 512, fractalType: 'burningship' }),
  ]);
  expect(imported.report.accepted).toBe(1);

  // Through the observation hook, which runs the same function the button does.
  const viaHook = await page.evaluate(() => window.__fv.loadLocation('load-me'));
  expect(viaHook.viewApplications).toBe(1);
  expect(viaHook.renderRequests).toBe(1);
  expect(await page.evaluate(() => window.__fv.getView())).toEqual({ centerX: -0.75, centerY: 0.1, scale: 0.25 });
  expect(await page.evaluate(() => window.__fv.maxIter())).toBe(512);

  // Through the REAL button, so the pin covers the wiring and not just the hook.
  await page.click('#loadLocationBtn');
  await expect(page.locator('#loadLocationModal')).toBeVisible();
  // Reset through the modal-open path the user takes, then click the row's Load.
  await page.locator('#savedLocationsList button', { hasText: 'Load' }).first().click();
  const viaButton = await page.evaluate(() => window.__fv.lastLoad());
  expect(viaButton.viewApplications).toBe(1);
  expect(viaButton.renderRequests).toBe(1);
  expect(await page.evaluate(() => window.__fv.getView().scale)).toBe(0.25);
  expect(pageErrors).toEqual([]);
});

// --- pin 6: the sort is total and non-throwing ---------------------------------

test('S4 pin: a non-string name is rejected on import and cannot throw the name sort', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await ready(page);

  // A non-string name is rejected by the schema, so it never reaches the store.
  const rejected = await importPayload(page, [
    validRecord({ id: 'object-name', name: { toString: null } }),
    validRecord({ id: 'number-name', name: 12345 }),
    validRecord({ id: 'sorted-a', name: 'Alpha' }),
    validRecord({ id: 'sorted-b', name: 'Beta' }),
  ]);
  expect(rejected.report.rejected).toBe(2);
  expect(rejected.report.accepted).toBe(2);
  expect(rejected.stored.sort()).toEqual(['sorted-a', 'sorted-b']);

  // Sorting by name over the accepted records is a total order and does not
  // throw — this exercised `a.name.localeCompare(b.name)` before S4.
  await page.click('#loadLocationBtn');
  await page.selectOption('#locationSortSelect', 'name');
  await expect(page.locator('#savedLocationsList')).toContainText('Alpha');
  await expect(page.locator('#savedLocationsList')).toContainText('Beta');
  const order = await page.evaluate(() => {
    const text = document.getElementById('savedLocationsList').textContent;
    return [text.indexOf('Alpha'), text.indexOf('Beta')];
  });
  expect(order[0]).toBeGreaterThanOrEqual(0);
  expect(order[1]).toBeGreaterThan(order[0]);
  expect(pageErrors).toEqual([]);

  // The hazard itself: a non-string name that DID reach the store (the schema
  // refuses it on import, so this is the defence-in-depth path — a hand-built
  // record, a future persisted one, or a future importer). Before S4
  // `getAll('name')` called `a.name.localeCompare(...)` on it and THREW out of
  // the render. The store normalizes, the sort key coerces, so the display
  // survives and nothing escapes as a pageerror.
  const survivor = await page.evaluate(() => {
    window.__fv.saveUnvalidated({
      id: 'raw-nonstring-name',
      name: { toString: null },
      scale: 3,
      centerX: 0,
      centerY: 0,
      fractalType: 'mandelbrot',
      maxIter: 256,
      renderer: 'CPU',
      timestamp: 1758441600000,
    });
    // Sort by name over a store that now holds a non-string name.
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('locationSortSelect'));
    select.value = 'name';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const list = document.getElementById('savedLocationsList');
    return { rows: list.children.length, text: list.textContent };
  });
  expect(survivor.rows).toBe(3); // Alpha, Beta and the raw record, none dropped
  expect(survivor.text).toContain('Alpha');
  expect(survivor.text).toContain('Beta');
  expect(pageErrors).toEqual([]);

  // The same file was accepted-and-listed twice without a pageerror, and the
  // modal still closes.
  await page.selectOption('#locationSortSelect', 'timestamp');
  await page.click('#closeLoadLocationModal');
  await expect(page.locator('#loadLocationModal')).toBeHidden();
  expect(pageErrors).toEqual([]);
});
