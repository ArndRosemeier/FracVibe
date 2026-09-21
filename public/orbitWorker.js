// P2 · the reference-orbit Worker.
//
// The arbitrary-precision reference orbit is computed OFF the main thread, so a
// deep view never blocks the interaction loop (the owner's standing requirement:
// "the zoom needs to stay visually as smooth as possible"). It is a CLASSIC
// worker, exactly like public/fractalWorker.js, so it loads the ONE no-import /
// no-export BigInt module with `importScripts` (docs/DECISIONS.md row 14).
//
// The orbit is computed ONCE PER VIEW: the caller sends a request only when its
// (centre, budget, working precision) key is not already cached, and this worker
// is long-lived — it is not spawned per draw.
importScripts('bigOrbit.js');

self.onmessage = function (event) {
  var req = event.data || {};
  if (req.type !== 'orbit') return;
  try {
    // TEST-ONLY injection (default 0): the caller carries it here because the
    // control is read where the orbit is computed.
    self.BigOrbit.setControlStepShift(req.control || 0);
    var r = self.BigOrbit.computeOrbitFixed(
      req.centerX, req.centerY, req.maxIter, req.bits, req.width
    );
    self.postMessage({
      type: 'orbit',
      id: req.id,
      key: req.key,
      bits: r.bits,
      width: r.width,
      escapedAt: r.escapedAt,
      ms: r.ms,
      zx: r.zx,
      zy: r.zy,
    }, [r.zx.buffer, r.zy.buffer]);
  } catch (err) {
    self.postMessage({
      type: 'orbit-error',
      id: req.id,
      key: req.key,
      message: String(err && err.message ? err.message : err),
    });
  }
};
