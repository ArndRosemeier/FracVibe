// @ts-check
// S2 / worker truth — the worker job lifecycle: cancellation, worker failure,
// progressive frames and malformed payloads.
//
// Before S2: `postMessage({type:'abort'})` was a no-op (the worker cannot read a
// message while it is inside its synchronous loop), `worker.onerror` did not exist
// at all (a worker failure was completely silent), and `app.js` handled only
// `'done'` so every intermediate `progress` frame was computed and thrown away.
//
// Every assertion here is on a COUNTED observable from `window.__fv`, never on an
// inference from pixels or timing. `runJob()` / `cancelJob()` /
// `deliverWorkerMessage()` / `failWorker()` are the frozen S2 observation surface
// in public/app.js; they call the SAME functions the real handlers call, so a test
// cannot pass on a path the app does not use.
const { test, expect } = require('@playwright/test');

// --- fixtures ------------------------------------------------------------------

// Wait until no calculation is in flight, so a test starts from a known state and
// cannot race a job it did not start.
async function waitIdle(page) {
  await expect
    .poll(() => page.evaluate(() => window.__fv.jobToken()), { timeout: 30_000 })
    .toBe(null);
}

// The tests that need a job to still be IN FLIGHT when they act on it use the
// heaviest user-reachable configuration: Burning Ship at the slider's maximum
// iteration cap. Measured on this host it runs ~1.0 s end to end and emits its
// first frame at ~120 ms, so there is a wide, deterministic window. The default
// Mandelbrot job finishes in ~100 ms, which is too fast to fault or cancel
// deterministically — with it these tests are flaky, not wrong.
async function heavySetup(page) {
  await page.evaluate(() => {
    const type = /** @type {HTMLSelectElement} */ (document.getElementById('fractalType'));
    type.value = 'burningship';
    type.dispatchEvent(new Event('change', { bubbles: true }));
    const slider = /** @type {HTMLInputElement} */ (document.getElementById('maxIter'));
    slider.value = slider.max;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitIdle(page);
}

// Start one job through the real entry point and return { jobId, token, width, height }.
async function startJob(page) {
  const before = await page.evaluate(() => window.__fv.jobCount());
  await page.evaluate(() => window.__fv.runJob());
  await expect
    .poll(() => page.evaluate(() => window.__fv.jobCount()), { timeout: 10_000 })
    .toBeGreaterThan(before);
  const info = await page.evaluate(() => ({
    jobId: window.__fv.jobCount(),
    token: window.__fv.jobToken(),
    size: window.__fv.jobSize(),
  }));
  expect(info.token, 'the job must be in flight when the fixture returns').not.toBe(null);
  return info;
}

const appliedFor = (page, jobId) =>
  page.evaluate((id) => window.__fv.appliedFramesForJob(id), jobId);

// --- pins ----------------------------------------------------------------------

test('S2 pin: cancelling a running job applies no further frame from that job and kills its worker', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitIdle(page);
  await heavySetup(page);

  const baseline = await page.evaluate(() => ({
    cancelled: window.__fv.cancelledWorkers(),
    workers: window.__fv.workerGeneration(),
  }));

  // Start the job and cancel it in ONE round-trip: the job takes ~1 s, while a
  // separate `page.evaluate` for the cancel costs a round-trip the job can (on a
  // loaded host) finish inside. Issuing both from the same evaluate removes that
  // race, so `cancelled` is true by construction rather than by luck.
  const startAndCancel = await page.evaluate(() => {
    const before = window.__fv.jobCount();
    window.__fv.runJob();
    const jobId = window.__fv.jobCount();
    const token = window.__fv.jobToken();
    const size = window.__fv.jobSize();
    const frozen = window.__fv.appliedFramesForJob(jobId);
    const cancelled = window.__fv.cancelJob();
    return {
      job: { jobId, token, size },
      started: jobId > before,
      frozen,
      cancelled,
      after: {
        cancelled: window.__fv.cancelledWorkers(),
        workers: window.__fv.workerGeneration(),
        jobToken: window.__fv.jobToken(),
        liveWorkers: window.__fv.liveWorkers(),
      },
    };
  });
  const job = startAndCancel.job;
  expect(startAndCancel.started).toBe(true);
  expect(startAndCancel.frozen).toBe(0); // cancelled on the very tick it started
  expect(job.token).not.toBe(null);
  expect(job.size.width * job.size.height).toBeGreaterThan(100_000);

  // Cancel exactly as a view change does. `cancelled` must be true: a job WAS in
  // flight, so a worker was terminated. (An inert cancel leaves the counters
  // unchanged and fails here, not on a timing-dependent pixel check.)
  expect(startAndCancel.cancelled, 'the job must still have been in flight when cancel ran').toBe(true);

  const after = startAndCancel.after;
  expect(after.cancelled).toBe(baseline.cancelled + 1);
  expect(after.workers).toBe(baseline.workers + 1); // terminated AND respawned
  expect(after.liveWorkers).toBe(1);
  expect(after.jobToken).toBe(null);
  const frozen = startAndCancel.frozen;

  // Nothing from the cancelled job may land while the worker it used would still
  // have been running (the full job is ~1 s; this covers the rest of it).
  await page.waitForTimeout(1200);
  expect(await appliedFor(page, job.jobId), 'a cancelled job must apply no further frame').toBe(frozen);

  // The decisive case: the cancelled job's own final frame arrives late. terminate()
  // is not a synchronous preemption (measured: the level already in the worker's
  // synchronous kernel still finishes), so a stale frame CAN still be handed to the
  // handler. It must be recognised as stale and dropped. The net that catches it in
  // this design is clearing `progressiveState` on cancel; the `calcToken` generation
  // check is the defence in depth behind that. This pin holds the whole chain to
  // one rule: a late frame is never applied.
  const staleDelivered = await page.evaluate((state) => {
    const before = window.__fv.appliedFramesForJob(state.jobId);
    window.__fv.deliverWorkerMessage({
      type: 'done',
      result: new ArrayBuffer(state.size * 4),
      calcToken: state.token,
    });
    return { before, after: window.__fv.appliedFramesForJob(state.jobId), jobToken: window.__fv.jobToken() };
  }, { jobId: job.jobId, token: job.token, size: job.size.width * job.size.height });
  expect(staleDelivered.jobToken, 'a late frame must not revive a cancelled job').toBe(null);
  expect(staleDelivered.after, 'a late frame from a cancelled job must never be applied').toBe(staleDelivered.before);

  expect(pageErrors).toEqual([]);
});

test('S2 pin: a worker that fails is reported AND self-heals on a fresh worker, not a frozen canvas', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitIdle(page);
  await heavySetup(page);

  const job = await startJob(page);
  const baseline = await page.evaluate(() => window.__fv.workerGeneration());

  // Fire the REAL worker.onerror path with a message no other layer produces, so
  // the page's `#appMessage` text can only have come from the worker handler. (The
  // S1 window error net would also surface a *thrown* error, which is exactly why
  // the sentinel is asserted here rather than merely "a message appeared".)
  //
  // WORKER-CANCEL: a live worker failure must now SELF-HEAL — it retires the dead
  // worker and retries the in-flight job on a fresh one, with no view change from
  // the user. The retry starts synchronously inside the handler, so the new job id
  // and generation are read in the same round-trip.
  const after = await page.evaluate(() => {
    window.__fv.failWorker('S2 worker-failure sentinel');
    return { gen: window.__fv.workerGeneration(), jobId: window.__fv.jobCount(), token: window.__fv.jobToken(), live: window.__fv.liveWorkers() };
  });

  const message = page.locator('#appMessage');
  await expect(message).toBeVisible();
  await expect(message).toContainText('S2 worker-failure sentinel');
  await expect(message).toContainText(/retrying/i); // actionable, and names the retry

  // The dead worker is gone and a FRESH one is serving the retried job: the
  // generation advanced, the live slot is occupied again, and a job is in flight.
  expect(after.gen, 'a failed worker must be replaced by a fresh one').toBeGreaterThan(baseline);
  expect(after.live).toBe(1);
  expect(after.token, 'the in-flight job must be retried, not dropped').not.toBe(null);
  expect(after.jobId).toBeGreaterThan(job.jobId);

  // The retried job reaches a final frame on its own — the canvas is NOT frozen
  // and the user did NOT change the view.
  await expect
    .poll(() => appliedFor(page, after.jobId), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__fv.jobToken()), { timeout: 30_000 }).toBe(null);

  // The page is still ALIVE: a new job runs on a fresh worker afterwards.
  const next = await startJob(page);
  expect(next.token).not.toBe(null);
  await expect
    .poll(() => appliedFor(page, next.jobId), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await waitIdle(page);

  expect(pageErrors).toEqual([]);
});

test('S2 pin: a malformed worker payload never escapes as an uncaught pageerror', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitIdle(page);
  await heavySetup(page);

  const job = await startJob(page);

  // Every shape of bad 'done'/'progress' the probe named. `result: undefined` is
  // the exact payload the brief describes. Delivered through the REAL handler.
  // The canonical `message`/`cancel` events for this job are delivered in the same
  // evaluate so the frame count is read at the boundary, not a round-trip earlier.
  const outcome = await page.evaluate((state) => {
    const bad = [
      { type: 'done', calcToken: state.token },
      { type: 'done', result: undefined, calcToken: state.token },
      { type: 'done', result: null, calcToken: state.token },
      { type: 'done', result: new ArrayBuffer(3), calcToken: state.token }, // not a whole Int32 count
      { type: 'done', result: new ArrayBuffer(8), calcToken: state.token }, // wrong length
      { type: 'progress', result: undefined, calcToken: state.token },
      { type: 'progress', result: 'nope', calcToken: state.token },
    ];
    for (const msg of bad) window.__fv.deliverWorkerMessage(msg);
    return {
      jobToken: window.__fv.jobToken(),
      frozen: window.__fv.appliedFramesForJob(state.jobId),
    };
  }, { token: job.token, jobId: job.jobId });

  // A defined state and a visible reason, not a frozen canvas.
  await expect(page.locator('#appMessage')).toBeVisible();
  await expect(page.locator('#appMessage')).toContainText(/could not be applied/i);
  expect(outcome.jobToken).toBe(null);
  await page.waitForTimeout(400);
  expect(await appliedFor(page, job.jobId), 'a malformed payload must not turn into an applied frame').toBe(outcome.frozen);
  // Nothing threw inside the event handler.
  expect(pageErrors).toEqual([]);

  // The app still works afterwards: a fresh, VALID job is applied.
  const next = await startJob(page);
  await expect
    .poll(() => appliedFor(page, next.jobId), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await waitIdle(page);
  expect(pageErrors).toEqual([]);
});

test('S2 pin: a slow render applies intermediate frames before the final one', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await waitIdle(page);
  await heavySetup(page);

  const baseline = await page.evaluate(() => ({
    progress: window.__fv.progressFrames(),
    applied: window.__fv.appliedFrames(),
  }));

  const job = await startJob(page);

  // Counted, not inferred: the viewer must receive MORE THAN ONE frame for this
  // job. Only one can be final, so every further frame is a real intermediate
  // image. If progress frames are discarded (the pre-S2 behaviour) this poll only
  // ever sees a single application and times out red.
  await expect
    .poll(() => appliedFor(page, job.jobId), { timeout: 30_000 })
    .toBeGreaterThan(1);

  // The intermediate frames arrived while the job was still running, i.e. the user
  // sees them BEFORE the render is finished.
  expect(await page.evaluate(() => window.__fv.jobToken()), 'the job must still be running when its intermediate frames land').not.toBe(null);
  expect(await page.evaluate(() => window.__fv.progressFrames())).toBeGreaterThan(baseline.progress);

  await waitIdle(page);
  expect(await appliedFor(page, job.jobId)).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.__fv.appliedFrames())).toBeGreaterThan(baseline.applied + 1);
  expect(pageErrors).toEqual([]);
});
