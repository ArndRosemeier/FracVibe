// @ts-check
// Shared harness helper: make every WebGL context request fail, exactly as a
// GPU-less browser or a driver-blocklisted machine would. '2d' is untouched, so
// the CPU renderer can still do its job.
//
// Extracted verbatim from tests/webgl-fallback.spec.js (S1) so the S1 pins and
// the S5 3D-init pin deny WebGL through ONE helper instead of two copies.
// Playwright does not collect this file (its testMatch is `**/*.spec.js`).
async function denyWebGLContexts(page) {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') return null;
      return original.call(this, type, ...rest);
    };
  });
}

module.exports = { denyWebGLContexts };
