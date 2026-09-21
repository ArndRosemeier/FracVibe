// @ts-check
// GPU-DIAGNOSTIC — the hardware-certification instrument.
//
// WHAT THIS SPEC ASSERTS, and deliberately does NOT assert. The instrument exists
// because this host runs SwiftShader for WebGL, so a value measured here says
// nothing about a real vendor compiler/driver: the owner presses the button on a
// real GPU and reports the console. Therefore this spec asserts the report's
// STRUCTURE — every item present exactly once, each either a value or an explicit
// SKIP/FAIL with a reason, a parseable SUMMARY, no uncaught error, the button
// wired and safe to press twice — and NOT the values, which are machine-specific.
// On this host a zero/ignored double-single low component is a plausible outcome;
// the spec passes either way because it never asserts NONZERO.
//
// It also asserts the two things that would make every other number a lie: that
// the report is printed as ONE console block the owner can copy, and that the
// battery leaves no pageerror behind.
const { test, expect } = require('@playwright/test');

const HEADER = '===== GPU DIAGNOSTIC (FracVibe) =====';

// The FIXED emission order. A missing or extra item is a defect: a phase that
// cannot run must still report SKIP/FAIL.
const EXPECTED_ITEMS = [
  'ua', 'gl_vendor', 'gl_renderer', 'gl_version', 'webgl2',
  'oes_texture_float', 'oes_texture_float_linear', 'max_texture_size',
  'max_vertex_texture_units', 'float_texture_sampleable',
  'ds_precision', 'ds_readback', 'ds_low_component', 'ds_low_changes_result', 'ds_twoprod_low',
  'deep_view', 'deep_ref_float64', 'deep_ref_bigint', 'app_readback',
  'cost_1e-4', 'cost_1e-6', 'cost_1e-8',
  'gl_error', 'readpixels_plausible',
];

// Values that must never appear in a report the owner reads.
const FORBIDDEN_SUBSTRINGS = ['undefined', 'NaN', '[object Object]'];

async function waitSettled(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv && window.__fv.animationSettled && window.__fv.animationSettled()), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => !!(window.__gpuDiagnostic && window.__gpuDiagnostic.lastReport !== undefined)), { timeout: 10_000 })
    .toBe(true);
}

// Parse the console block the button printed. The report is one `console.log`, so
// this is exactly the text the owner will copy.
function parseReport(text) {
  const lines = text.split('\n');
  expect(lines[0], 'the report must start with the header').toBe(HEADER);
  expect(lines[1] && lines[1].startsWith('SUMMARY: '), 'the SUMMARY line must come second').toBe(true);
  const items = [];
  let section = null;
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    const sec = /^--- (.+) ---$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    const it = /^ {2}([A-Za-z0-9_-]+): (.+)$/.exec(line);
    if (it) { items.push({ section, id: it[1], value: it[2] }); continue; }
  }
  const footer = lines.find((l) => l.startsWith('===== END: '));
  return { lines, items, footer, summary: lines[1].slice('SUMMARY: '.length) };
}

function assertStructure(report, consoleTexts) {
  const parsed = parseReport(consoleTexts);
  const ids = parsed.items.map((it) => it.id);

  // (1) every expected item present, in order, exactly once.
  expect(ids, 'the exact item id set and order').toEqual(EXPECTED_ITEMS);
  expect(new Set(ids).size, 'no duplicate item id').toBe(ids.length);

  // (2) every item section is one of the declared groups.
  const sections = new Set(parsed.items.map((it) => it.section));
  expect([...sections].sort()).toEqual([
    'DEEP LANE', 'DOUBLE-SINGLE RESIDUAL', 'FEATURE GATES', 'IDENTITY', 'READBACK & ERRORS',
  ]);

  // (3) each item is a value or an explicit SKIP/FAIL with a reason.
  for (const it of parsed.items) {
    expect(it.value.length, it.id + ' must have a value').toBeGreaterThan(0);
    for (const bad of FORBIDDEN_SUBSTRINGS) {
      expect(it.value, it.id + ' must not contain ' + JSON.stringify(bad)).not.toContain(bad);
    }
    if (/^(SKIP|FAIL)\b/.test(it.value)) {
      expect(it.value, it.id + ' must state SKIP/FAIL with a reason').toMatch(/^(SKIP|FAIL) \(.+\)$/);
    }
  }

  // (4) the footer counts agree with the parsed items.
  const counted = { ok: 0, skip: 0, fail: 0 };
  for (const it of parsed.items) {
    if (it.value.startsWith('SKIP')) counted.skip++;
    else if (it.value.startsWith('FAIL')) counted.fail++;
    else counted.ok++;
  }
  expect(parsed.footer, 'the footer must be present and countable')
    .toBe('===== END: ' + counted.ok + ' OK, ' + counted.skip + ' SKIP, ' + counted.fail + ' FAIL =====');

  // (5) the SUMMARY answers the four questions by itself.
  for (const token of ['renderer=', 'kind=', 'floatTex=', 'dsLow=', 'deepLane=', 'cost:']) {
    expect(parsed.summary, 'the SUMMARY must contain ' + token).toContain(token);
  }
  expect(['HARDWARE', 'SOFTWARE', 'UNKNOWN'].some((k) => parsed.summary.includes('kind=' + k)),
    'kind must be HARDWARE|SOFTWARE|UNKNOWN').toBe(true);
  expect(['SAMPLES', 'UNSUPPORTED', 'BROKEN'].some((k) => parsed.summary.includes('floatTex=' + k)),
    'floatTex must be SAMPLES|UNSUPPORTED|BROKEN').toBe(true);
  expect(['NONZERO-ACTIVE', 'NONZERO-INERT', 'ZERO-IGNORED', 'UNAVAILABLE'].some((k) => parsed.summary.includes('dsLow=' + k)),
    'dsLow must be one of the four known tokens').toBe(true);

  // (6) the machine-readable surface agrees with the printed one.
  expect(report.id).toBe('gpuDiagnostic/1');
  expect(report.items.map((it) => it.id)).toEqual(EXPECTED_ITEMS);
  expect(report.counts).toEqual(counted);
  expect(report.errors, 'the battery must report no internal errors').toEqual([]);
  return parsed;
}

test.describe('GPU diagnostic (hardware-certification instrument)', () => {
  test('the Test button prints one structurally complete report and raises no error', async ({ page }) => {
    test.setTimeout(180_000);
    const consoleTexts = [];
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
      if (msg.text().includes(HEADER)) consoleTexts.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto('./', { waitUntil: 'domcontentloaded' });
    await waitSettled(page);

    const button = page.locator('#gpuDiagBtn');
    const status = page.locator('#gpuDiagStatus');
    await expect(button, 'the Test button must be in the UI').toHaveText('Test');
    await expect(status, 'the status starts idle').toHaveAttribute('data-state', 'idle');

    await button.click();
    // The battery does real work between the click and the first await, so the
    // running state is observable before it finishes.
    await expect(status, 'the status reports that it is running').toHaveAttribute('data-state', 'running');

    await expect(status, 'the status ends done').toHaveAttribute('data-state', 'done', { timeout: 150_000 });
    await expect(status).toContainText('done — see console');

    const report = await page.evaluate(() => window.__gpuDiagnostic.lastReport());
    expect(report, 'the battery must publish a report object').not.toBeNull();
    expect(consoleTexts.length, 'exactly one console block').toBe(1);
    assertStructure(report, consoleTexts[0]);

    expect(pageErrors, 'no uncaught page error').toEqual([]);
    expect(consoleErrors, 'no console.error').toEqual([]);
  });

  test('a second press is safe (re-entry is refused, a later press reruns)', async ({ page }) => {
    test.setTimeout(180_000);
    const consoleTexts = [];
    const pageErrors = [];
    page.on('console', (msg) => {
      if (msg.text().includes(HEADER)) consoleTexts.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto('./', { waitUntil: 'domcontentloaded' });
    await waitSettled(page);

    const status = page.locator('#gpuDiagStatus');

    // Two invocations in one tick: the second must hit the re-entry guard and NOT
    // start a second battery (the DOM disabled attribute would mask this, so the
    // click handler is invoked directly to exercise the guard itself).
    await page.evaluate(() => {
      window.__gpuDiagnostic.onTestClick();
      window.__gpuDiagnostic.onTestClick();
    });
    await expect(status).toHaveAttribute('data-state', 'done', { timeout: 150_000 });
    expect(consoleTexts.length, 'the refused re-entry must not print a second block').toBe(1);
    await expect(page.locator('#gpuDiagBtn'), 'the button is enabled again').toBeEnabled();

    const first = await page.evaluate(() => window.__gpuDiagnostic.lastReport());
    assertStructure(first, consoleTexts[0]);

    // A later press reruns the whole battery and prints a fresh, complete block.
    await page.locator('#gpuDiagBtn').click();
    await expect
      .poll(() => consoleTexts.length, { timeout: 150_000 })
      .toBe(2);
    await expect(status).toHaveAttribute('data-state', 'done');
    const second = await page.evaluate(() => window.__gpuDiagnostic.lastReport());
    expect(second, 'the rerun must publish a fresh report').not.toBeNull();
    assertStructure(second, consoleTexts[1]);

    expect(pageErrors, 'no uncaught page error across both presses').toEqual([]);
  });
});
