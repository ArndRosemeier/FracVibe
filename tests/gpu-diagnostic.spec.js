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
// the spec passes either way because it never asserts NONZERO. The same is true of
// the INTEGER-CONTROLLED section (DECISIONS 101): on SwiftShader every integer arm
// reads NONZERO-ACTIVE, and on the owner's D3D11 driver it may not — the spec
// asserts only that each item is present and each value is a value or an explicit
// SKIP/FAIL, and that the SUMMARY carries the `icDS=` token in one of its four
// known states.
//
// It also asserts the two things that would make every other number a lie: that
// the report is printed as ONE console block the owner can copy, and that the
// battery leaves no pageerror behind.
const { test, expect } = require('@playwright/test');

const HEADER = '===== GPU DIAGNOSTIC (FracVibe) =====';

// The FIXED emission order, grouped by the section header the report prints. A
// missing or extra item is a defect: a phase that cannot run must still report
// SKIP/FAIL.
const GROUPS = [
  { section: 'IDENTITY', ids: ['ua', 'gl_vendor', 'gl_renderer', 'gl_version', 'webgl2'] },
  { section: 'FEATURE GATES', ids: ['oes_texture_float', 'oes_texture_float_linear', 'max_texture_size', 'max_vertex_texture_units', 'float_texture_sampleable'] },
  { section: 'DOUBLE-SINGLE RESIDUAL', ids: ['ds_precision', 'ds_readback', 'ds_low_component', 'ds_low_changes_result', 'ds_twoprod_low'] },
  // The integer-controlled battery (DECISIONS 101): the D3D11 response. It runs
  // on a WebGL2 / GLSL ES 3.00 context, so on a machine with no WebGL2 these are
  // explicit SKIPs — still structurally complete, never dropped.
  { section: 'INTEGER-CONTROLLED DS', ids: ['ic_variant', 'ic_readback', 'ic_twoprod_low', 'ic_sum_low', 'ic_recurrence_low', 'ic_required_nonzero', 'ic_arm_differential'] },
  { section: 'DEEP LANE', ids: ['deep_view', 'deep_ref_float64', 'deep_ref_bigint', 'app_readback', 'cost_1e-4', 'cost_1e-6', 'cost_1e-8'] },
  { section: 'READBACK & ERRORS', ids: ['gl_error', 'readpixels_plausible'] },
];
const EXPECTED_ITEMS = GROUPS.flatMap((g) => g.ids);

// The three cost items, and the reason this spec checks them by hand rather than
// only structurally. The owner diffed two runs and believed the `cost:` triple
// (DECISIONS 105): on his RTX 5070/D3D11 and on this host's SwiftShader it read one
// identical number for 1e-4, 1e-6 and 1e-8 — to the decimal, on two unrelated
// drivers, with `passes=0`. The cause was that the loop read `renderTimeMs()`
// (a scalar written when a refinement chain COMPLETES) in the same synchronous turn
// it called `renderWebGL()`, which only applies the coarsest level; so all three
// steps read the same stale value. The instrument could not measure the frame it
// claimed. The assertion below is STRUCTURE/VARIANCE-based — it never asserts a
// vendor value — so it holds on hardware and on software alike.
const COST_IDS = ['cost_1e-4', 'cost_1e-6', 'cost_1e-8'];

// A measured cost item must be `"<ms> ms (scale=… capIter=… lane=… passes=…)"`.
const COST_MEASURED_RE = /^([0-9]+(?:\.[0-9]+)?) ms \(scale=([^ ]+) capIter=([0-9]+) lane=([^ ]+) passes=([^ )]+)\)$/;
const COST_SKIP_RE = /^(SKIP|FAIL) \((.+)\)$/;

// Parse and CHECK the three cost items. Throws on a dishonest readout.
function assertCostHonesty(items) {
  const parsed = COST_IDS.map((id) => {
    const it = items.find((x) => x.id === id);
    expect(it, id + ' must be present in the report').toBeTruthy();
    const skip = COST_SKIP_RE.exec(it.value);
    if (skip) {
      // The honest alternative to a bad number is a stated reason, never a blank.
      expect(skip[2].trim().length, id + ': a SKIP/FAIL cost item must state a non-empty reason, got: ' + it.value)
        .toBeGreaterThan(0);
      return { id: id, measured: false, reason: skip[2] };
    }
    const m = COST_MEASURED_RE.exec(it.value);
    expect(m, id + ': a measured cost item must read "<ms> ms (scale=… capIter=… lane=… passes=…)", got: ' + it.value)
      .toBeTruthy();
    // A measured item is only a FULL-IMAGE reading if a full-image pass actually
    // ran. The observed defect reported `passes=0`, i.e. it timed nothing.
    expect(Number(m[5]), id + ': a measured cost item must report at least one full-image pass, got passes=' + m[5])
      .toBeGreaterThanOrEqual(1);
    return { id: id, measured: true, ms: parseFloat(m[1]), capIter: m[3], lane: m[4] };
  });

  const measured = parsed.filter((p) => p.measured);
  // THE PIN. Three renders of the same view at DIFFERENT iteration budgets/lanes
  // cannot cost the same number of milliseconds to the decimal. When every step was
  // measured and the setups differ, the timings must vary; an identical triple is
  // the stale-scalar bug, not a measurement. When a step could not be measured it
  // is a SKIP whose reason the branch above already required to be non-empty, so
  // the pin holds on a machine too slow to render the deep steps in budget.
  if (measured.length === parsed.length) {
    const setups = new Set(measured.map((p) => p.capIter + '/' + p.lane));
    expect(setups.size, 'the three cost steps must not all share one setup (capIter/lane); the instrument must vary the depth')
      .toBeGreaterThan(1);
    const distinct = new Set(measured.map((p) => p.ms));
    expect(distinct.size, 'the three cost items must NOT all report the same ms value: three independent renders at '
      + 'different capIter/lane cannot be equal to the decimal, so an identical triple means the readout timed a stale '
      + 'scalar instead of the frame. Read: '
      + measured.map((p) => p.id + '=' + p.ms + 'ms@capIter=' + p.capIter + '/lane=' + p.lane).join(' '))
      .toBeGreaterThan(1);
  }
  return parsed;
}

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
  expect([...sections].sort()).toEqual(GROUPS.map((g) => g.section).sort());

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

  // (5) the SUMMARY answers the five questions by itself.
  for (const token of ['renderer=', 'kind=', 'floatTex=', 'dsLow=', 'icDS=', 'deepLane=', 'cost:']) {
    expect(parsed.summary, 'the SUMMARY must contain ' + token).toContain(token);
  }
  expect(['HARDWARE', 'SOFTWARE', 'UNKNOWN'].some((k) => parsed.summary.includes('kind=' + k)),
    'kind must be HARDWARE|SOFTWARE|UNKNOWN').toBe(true);
  expect(['SAMPLES', 'UNSUPPORTED', 'BROKEN'].some((k) => parsed.summary.includes('floatTex=' + k)),
    'floatTex must be SAMPLES|UNSUPPORTED|BROKEN').toBe(true);
  expect(['NONZERO-ACTIVE', 'NONZERO-INERT', 'ZERO-IGNORED', 'UNAVAILABLE'].some((k) => parsed.summary.includes('dsLow=' + k)),
    'dsLow must be one of the four known tokens').toBe(true);
  expect(['NONZERO-ACTIVE', 'NONZERO-INERT', 'ZERO-COLLAPSED', 'UNAVAILABLE'].some((k) => parsed.summary.includes('icDS=' + k)),
    'icDS must be one of the four known tokens').toBe(true);

  // (6) the machine-readable surface agrees with the printed one.
  expect(report.id).toBe('gpuDiagnostic/1');
  expect(report.items.map((it) => it.id)).toEqual(EXPECTED_ITEMS);
  expect(report.counts).toEqual(counted);
  expect(report.errors, 'the battery must report no internal errors').toEqual([]);

  // (7) THE COST PIN (DECISIONS 105): the three cost items must be MEASURED
  // full-image renders that actually differ, or explicit SKIPs with a reason —
  // never three identical plausible numbers.
  const cost = assertCostHonesty(report.items);
  console.log('\nCOST-READOUT ' + cost.map((c) => c.measured
    ? c.id + '=' + c.ms + 'ms@capIter=' + c.capIter + '/lane=' + c.lane
    : c.id + '=' + c.reason).join(' | ') + '\n');
  return parsed;
}

test.describe('GPU diagnostic (hardware-certification instrument)', () => {
  test('the Test button prints one structurally complete report and raises no error', async ({ page }) => {
    // The battery now WAITS for each cost step's full-resolution pass (the honest
    // measurement, DECISIONS 105): ~25 s of extra work on this software rasteriser,
    // more under load, so the timeout is sized for that and not for the old loop.
    test.setTimeout(300_000);
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

    await expect(status, 'the status ends done').toHaveAttribute('data-state', 'done', { timeout: 240_000 });
    await expect(status).toContainText('done — see console');

    const report = await page.evaluate(() => window.__gpuDiagnostic.lastReport());
    expect(report, 'the battery must publish a report object').not.toBeNull();
    // CDP delivers console events asynchronously, so wait for the block rather
    // than racing it against the status flip.
    await expect.poll(() => consoleTexts.length, { timeout: 10_000 }).toBe(1);
    // Echo the EXACT block into the runner log, so the gate log carries the
    // software baseline the owner's hardware report is compared against.
    console.log('\n' + consoleTexts[0] + '\n');
    assertStructure(report, consoleTexts[0]);

    expect(pageErrors, 'no uncaught page error').toEqual([]);
    expect(consoleErrors, 'no console.error').toEqual([]);
  });

  test('a second press is safe (re-entry is refused, a later press reruns)', async ({ page }) => {
    // TWO full batteries, each with the awaited cost passes (see test 1).
    test.setTimeout(420_000);
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
    await expect(status).toHaveAttribute('data-state', 'done', { timeout: 240_000 });
    // Wait for the ONE block the first invocation prints; a refused re-entry must
    // never print a second, so this also fails if the guard did not hold.
    await expect.poll(() => consoleTexts.length, { timeout: 10_000 }).toBe(1);
    await expect(page.locator('#gpuDiagBtn'), 'the button is enabled again').toBeEnabled();

    const first = await page.evaluate(() => window.__gpuDiagnostic.lastReport());
    assertStructure(first, consoleTexts[0]);

    // A later press reruns the whole battery and prints a fresh, complete block.
    await page.locator('#gpuDiagBtn').click();
    await expect
      .poll(() => consoleTexts.length, { timeout: 240_000 })
      .toBe(2);
    await expect(status).toHaveAttribute('data-state', 'done');
    const second = await page.evaluate(() => window.__gpuDiagnostic.lastReport());
    expect(second, 'the rerun must publish a fresh report').not.toBeNull();
    assertStructure(second, consoleTexts[1]);

    expect(pageErrors, 'no uncaught page error across both presses').toEqual([]);
  });

  // NON-VACUITY: a structure checker that accepts anything proves nothing. This
  // runs no browser — it feeds assertStructure a report missing 30 of its 31 items
  // and requires it to reject.
  test('the structure checker is not vacuous: a malformed report is rejected', async () => {
    const ITEM_COUNT = EXPECTED_ITEMS.length;
    const summary = 'renderer="x" kind=SOFTWARE floatTex=SAMPLES dsLow=UNAVAILABLE icDS=UNAVAILABLE deepLane=none cost: 1e-4=n/a 1e-6=n/a 1e-8=n/a';
    const badText = [
      HEADER,
      'SUMMARY: ' + summary,
      '--- IDENTITY ---',
      '  ua: Mozilla/5.0',
      '===== END: 1 OK, 0 SKIP, 0 FAIL =====',
    ].join('\n');
    const fakeReport = {
      id: 'gpuDiagnostic/1',
      summary: summary,
      items: [{ section: 'IDENTITY', id: 'ua', status: 'OK', value: 'Mozilla/5.0' }],
      counts: { ok: 1, skip: 0, fail: 0 },
      errors: [],
    };
    expect(() => assertStructure(fakeReport, badText),
      'a report missing ' + (ITEM_COUNT - 1) + ' of its ' + ITEM_COUNT + ' items must be rejected').toThrow();

    // And a report whose item set and sections are right but whose values contain
    // 'undefined' must ALSO be rejected, so "the right ids are present" cannot pass
    // for "every number is a real number".
    const badValueLines = [HEADER, 'SUMMARY: ' + summary];
    for (const group of GROUPS) {
      badValueLines.push('--- ' + group.section + ' ---');
      for (const id of group.ids) badValueLines.push('  ' + id + ': undefined');
    }
    badValueLines.push('===== END: ' + ITEM_COUNT + ' OK, 0 SKIP, 0 FAIL =====');
    const items = [];
    for (const group of GROUPS) for (const id of group.ids) items.push({ section: group.section, id: id, status: 'OK', value: 'undefined' });
    const undefinedReport = {
      id: 'gpuDiagnostic/1', summary: summary,
      items: items,
      counts: { ok: ITEM_COUNT, skip: 0, fail: 0 }, errors: [],
    };
    expect(() => assertStructure(undefinedReport, badValueLines.join('\n')),
      "an 'undefined' item value must be rejected").toThrow();
  });

  // NON-VACUITY OF THE COST PIN: feed assertCostHonesty the exact readout the owner
  // reported, and the intermediate shapes, and require each to be rejected. This
  // runs no browser: it proves the cost assertion itself is sensitive, independently
  // of what this host's GPU happens to produce.
  test('the cost-honesty pin is not vacuous: a flat/stale readout is rejected', async () => {
    const mk = (ms, passes, capIter, lane) => ({
      id: '',
      value: ms + ' ms (scale=1e-6 capIter=' + capIter + ' lane=' + lane + ' passes=' + passes + ')',
    });
    const withIds = (vals) => vals.map((v, i) => ({ ...v, id: COST_IDS[i] }));

    // ARM A — the required sensitive case: three DIFFERENT setups, three IDENTICAL
    // ms values, each claiming a full-image pass. Only the variance clause can
    // reject this, so a green here would mean the pin is vacuous.
    const identical = withIds([
      mk(72.5, 1, 512, 'none'),
      mk(72.5, 1, 6144, 'float64'),
      mk(72.5, 1, 8192, 'float64'),
    ]);
    expect(() => assertCostHonesty(identical),
      'three equal timings across three different capIter/lane setups must be rejected').toThrow(/must NOT all report the same/);

    // ARM B — the OWNER-OBSERVED report verbatim in shape: identical ms AND
    // passes=0. Rejected independently of the variance clause.
    const ownerObserved = withIds([
      mk(72.5, 0, 512, 'none'),
      mk(72.5, 0, 6144, 'float64'),
      mk(72.5, 0, 8192, 'float64'),
    ]);
    expect(() => assertCostHonesty(ownerObserved),
      "the owner's exact flat readout (identical ms, passes=0) must be rejected").toThrow();

    // ARM C — the honest alternative must not be fakeable: a SKIP with an EMPTY
    // reason is rejected, while a SKIP with a real reason is accepted.
    const emptyReason = withIds([
      { id: COST_IDS[0], value: 'SKIP ()' },
      mk(10.0, 1, 6144, 'float64'),
      mk(20.0, 1, 8192, 'float64'),
    ]);
    expect(() => assertCostHonesty(emptyReason),
      'a SKIP with an empty reason must be rejected').toThrow();
    const realReason = withIds([
      { id: COST_IDS[0], value: 'SKIP (the full-image render did not complete within 60s, so renderTimeMs() would report a stale value: scale=1e-4 capIter=512 lane=none passes=0)' },
      mk(10.0, 1, 6144, 'float64'),
      mk(20.0, 1, 8192, 'float64'),
    ]);
    expect(() => assertCostHonesty(realReason),
      'a SKIP with a stated reason is the honest outcome and must be accepted').not.toThrow();
  });
});
