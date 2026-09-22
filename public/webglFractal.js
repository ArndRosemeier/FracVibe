// The ONE kernel (iteration cap + type/palette tables). Imported for its side
// effect: it deliberately has no `export`, so both the classic worker and this ES
// module can load the same file (see public/fractalKernel.js and
// docs/DECISIONS.md row 14).
import './fractalKernel.js';
// P2: the arbitrary-precision reference orbit in BigInt fixed point. Loaded for
// its side effect for the same reason as the kernel: the file has no import and
// no export, so the classic orbit Worker can `importScripts` the ONE source.
import './bigOrbit.js';
const FractalKernel = globalThis.FractalKernel;
const BigOrbit = globalThis.BigOrbit;

// Accounting for GPU↔CPU teardown. Every constructed renderer increments and
// every destroyed renderer decrements, so a test can assert that N toggles leave
// zero live renderers instead of inferring it. (Inference is not evidence.)
let liveRendererCount = 0;
function trackLiveRenderer(delta) {
  liveRendererCount = Math.max(0, liveRendererCount + delta);
  if (typeof window !== 'undefined') window.__fvLiveWebglRenderers = liveRendererCount;
}

// A JS number as a GLSL float literal. GLSL `float` is IEEE float32, so
// `Math.fround` produces exactly the value the shader will parse. GLSL has no
// implicit int→float widening, so an integral value MUST carry the `.0` (a bare
// `4` makes `escapeRadiusSq > BAILOUT_SQ` a type error that fails the fragment
// compile and silently falls back to the CPU — D1 pin 5 caught exactly that).
function glslFloat(value) {
  const s = String(Math.fround(value));
  return /[.eE]/.test(s) ? s : s + '.0';
}

// Minimal WebGL Fractal Renderer (Mandelbrot/Julia)
export class WebGLFractalRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.vsh = null;
    this.fsh = null;
    this.posBuf = null;
    // P1: the shallow (plain float32) lane is a second linked program whenever the
    // deep lane exists; without OES_texture_float the two lanes are the same object.
    this.plainProgram = null;
    this.plainVsh = null;
    this.plainFsh = null;
    this.destroyed = false;
    // P1: the reference orbit for the CURRENT view. `orbitComputations` counts the
    // CPU orbit builds, so "computed once per view, never per pixel" is measured
    // rather than inferred; `_orbitKey` is the view identity the cached orbit
    // belongs to (centre + budget + type), and the texture is re-uploaded only
    // when that key changes.
    this.orbitComputations = 0;
    this._orbitKey = null;
    this._orbitTex = null;
    this._orbitW = 0;
    this._orbitZx = null;
    this._orbitZy = null;
    this.hasFloatTexture = false;
    this.maxOrbitWidth = 0;
    // P2: the arbitrary-precision (BigInt) reference orbit. `orbitMode` selects
    // the ORBIT SOURCE for a deep view whose exact centre is available:
    //   'bigint'  (production default) -- the Worker orbit at the working precision
    //   'float64' (observation only)   -- P1's float64 orbit of the rounded centre,
    //                                     i.e. exactly the wall this slice removes
    // `_bigOrbit` caches the completed orbit under its (centre, budget, bits) key;
    // `_bigOrbitPending` is the key of the one request in flight, so a redraw
    // while it is being computed does not post a second one. Counters make
    // "once per view" measured rather than inferred: `bigOrbitRequests` counts
    // what was ASKED of the Worker, `bigOrbitComputations` what came back.
    this.orbitMode = 'bigint';
    // Observation only: force the working precision (bits) used for the next
    // BigInt orbit instead of the scale-derived rule. Pin 3 uses it to compare the
    // two sides of a precision STEP at one fixed view.
    this.bigOrbitBitsOverride = 0;
    this._orbitWorker = null;
    this._bigOrbit = null;
    this._bigOrbitPending = null;
    this._orbitReqId = 0;
    this.bigOrbitRequests = 0;
    this.bigOrbitComputations = 0;
    this.bigOrbitErrors = 0;
    this.bigOrbitWorkerSpawns = 0;
    this.lastBigOrbitMs = 0;
    // ARBITRARY DEPTH: the exponent split for the deep lane's delta seed. The
    // override is TEST-ONLY (0 = the measured rule) and exists so the shift itself
    // can be swept, exactly as bigOrbitBitsOverride sweeps the precision.
    this.deepSeedShift = 0;
    // DIAGNOSTIC ONLY (default false): draw the pre-fix seed, so the collapse this
    // slice fixes is measured through the REAL program rather than hand-rolled.
    this.legacyDeltaSeed = false;
    // The wall-clock ms of the last full-image draw, measured around the
    // synchronous GL pass. This is the value the readout reports.
    this.lastDrawMs = 0;
    // A 1x1 RGBA scratch buffer for the completion sync that makes the render-time
    // readout real (see draw). Reused, because it is touched once per image.
    this._syncPixel = new Uint8Array(4);
    // How many FULL-RESOLUTION passes this renderer has issued. The render-time
    // readout is asserted against this so "the time is a FULL image" is counted:
    // `draw` submits exactly one full-frame drawArrays and advances this by one;
    // a COARSE pass (`renderPass` with sampleStep > 1) deliberately does NOT
    // advance it, because it is not a full image. Coarse passes are counted
    // separately by `gpuPasses`, so both facts stay available and neither is
    // inferred (see COARSE-TO-FINE below).
    this.fullImagePasses = 0;
    // COARSE-TO-FINE: every pass this renderer has applied, full-resolution or
    // coarse. `fullImagePasses` is a subset of this, so a pin can assert "more
    // than one frame was applied" without redefining the full-image count that
    // DECISIONS row 59 gave `fullImagePasses`.
    this.gpuPasses = 0;
    // The sample step of the pass most recently applied (1 = full resolution).
    this.lastPassStep = 0;
    this.lastPassMs = 0;
    // The offscreen target a coarse pass renders into before it is magnified onto
    // the canvas, and the program that magnifies it. Created lazily; the size is
    // reallocated only when the requested coarse size changes.
    this.blitProgram = null;
    this.blitVsh = null;
    this.blitFsh = null;
    this.blitU = null;
    this._coarseTex = null;
    this._coarseFbo = null;
    this._coarseW = 0;
    this._coarseH = 0;
    this.onBigOrbitReady = null;
    this.orbitSource = 'none';
    if (!canvas) {
      throw new Error('WebGL initialization failed: canvas is null or undefined');
    }
    if (!canvas.parentNode) {
      throw new Error('WebGL initialization failed: canvas not attached to DOM');
    }
    trackLiveRenderer(1);
    try {
      this.gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!this.gl) {
        throw new Error('WebGL context creation failed');
      }
      this.initFractalShader();
    } catch (err) {
      // A half-initialised renderer must not stay counted as live, and must not
      // keep a context it created.
      this.destroy();
      throw err;
    }
  }

  initFractalShader() {
    const gl = this.gl;
    // P1: the reference orbit travels to the GPU as a FLOAT texture, one texel per
    // iteration. The committed probe measured this transport EXACT here (NEAREST
    // round-trips 53 significant bits; MAX_TEXTURE_SIZE = 8192 = the shipped cap;
    // NPOT fine), so the only question is the arithmetic, not the transport. A
    // context without OES_texture_float keeps the plain float32 Mandelbrot loop —
    // there is no way to upload a float64 orbit without it.
    this.hasFloatTexture = !!(gl.getExtension('OES_texture_float'));
    this.maxOrbitWidth = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0, FractalKernel.MAX_ITER);
    // Vertex shader (same as before)
    const vertSrc = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = (a_position + 1.0) * 0.5;
        gl_Position = vec4(a_position, 0, 1);
      }
    `;
    // Fragment shader with dynamic color palette.
    //
    // B5: GLSL ES 1.00 requires a loop bound that is a *constant expression*, so
    // the iteration cap cannot be a uniform. It is templated in from the ONE
    // kernel constant instead (`#define MAX_ITER <FractalKernel.MAX_ITER>`), and
    // the fractal-type / palette indices are templated from the kernel's tables,
    // so a GLSL branch can never drift from the maps app.js uses.
    const defines = [
      '#define MAX_ITER ' + FractalKernel.MAX_ITER,
      // D1: the SAME constants the kernel's `smoothIterationValue` uses. They are
      // float literals because GLSL has no implicit int→float widening: a bare
      // `4` here makes `escapeRadiusSq > BAILOUT_SQ` a type error that fails the
      // fragment compile and silently falls back to the CPU.
      '#define SMOOTH_LOG_BAILOUT ' + glslFloat(FractalKernel.SMOOTH_LOG_BAILOUT),
      '#define BAILOUT_SQ ' + glslFloat(FractalKernel.BAILOUT_SQ),
      // P1: the two CHOSEN perturbation constants, templated from the kernel so a
      // measurement and the shader can never name different numbers.
      '#define PERTURB_GLITCH_G ' + glslFloat(FractalKernel.PERTURB_GLITCH_G),
      '#define PERTURB_RESCALE_INTERVAL ' + FractalKernel.PERTURB_RESCALE_INTERVAL,
      ...FractalKernel.FRACTAL_TYPES.map((t) => '#define FT_' + t.glsl + ' ' + t.index),
      ...FractalKernel.COLOR_SCHEMES.map((s) => '#define CS_' + s.glsl + ' ' + s.index)
    ].join('\n') + '\n';
    // P1: the Mandelbrot branch is chosen ONCE, at compile time. GLSL ES 1.00
    // needs a constant loop bound and the suite counts loop SITES: four fractal
    // types, four loops, every one bound to MAX_ITER. A runtime variant would be
    // a fifth loop and would break the S3 pin that holds that.
    //
    // Perturbation is used whenever OES_texture_float is present -- every context
    // that can carry the orbit at all; one without it keeps the plain float32
    // lane. Both lanes keep the D1 escape idioms verbatim
    // (`escapeRadiusSq = x * x + y * y;` and `escapeRadiusSq > BAILOUT_SQ`),
    // because the smooth value below is the SAME expression on the SAME quantity.
    const perturbBranch = `
          // P1 · PERTURBATION CORE. The reference orbit Z_m is the float64 orbit of
          // the view centre, computed ONCE per view on the CPU and uploaded as a
          // float texture (u_orbit, one texel per reference iteration). This pixel
          // is C + dc where dc is its offset from that centre — NOT an absolute
          // float32 coordinate, which at deep zoom does not exist at all (that is
          // the whole defect the reference orbit removes).
          //
          //   z_0 = 0,  z_{n+1} = 2 Z_m z_n + z_n^2 + dc
          //
          // with z_n the PERTURBED delta, so the pixel value is Z_m + z_n. The
          // delta is carried in the RESCALED units z = S*w, dc = S*d:
          //
          //   w -> 2 Z_m w + S w^2 + d          (|w| near 1)
          //
          // so the arithmetic never runs out of RANGE however small the delta gets.
          // Two mechanisms keep the delta representable, and they are the two the
          // naive probe lacked:
          //
          //  * REBASING — when |Z_m + z| < |z|, replace z with Z_m + z and reset
          //    the reference iteration m to 0. A reference is arbitrary and
          //    iteration 0 has Z_0 = 0, so this is exact and it re-anchors the
          //    delta before it can grow without bound relative to the reference.
          //    MEASURED: this is the mechanism that reaches the depth
          //    (docs/DECISIONS.md row 33).
          //  * RESCALING — renormalise S every PERTURB_RESCALE_INTERVAL iterations
          //    (see the kernel constants for where it does, and does not, matter).
          //
          // ARBITRARY DEPTH (the range fix). The two lines that used to read
          //     float dcx = (v_uv.x - 0.5) * u_scale * u_aspect;
          //     float dcy = ((1.0 - v_uv.y) - 0.5) * u_scale;
          // were the wall: u_scale is a float32 UNIFORM, so past ~2e-38 the product
          // underflows and every pixel lands on the reference point before any
          // rebasing or rescaling can act — measured through the real shader: a
          // structured frame at 1e-37, ONE value at 2e-38 (docs/DECISIONS.md rows
          // 39/42+). The delta only ever needs to be SMALL, never WIDE, so the fix
          // seeds it in float32's NORMAL range and carries the scale's exponent in
          // the rescaled representation's own S:
          //
          //     u_scale <- scale * 2^shift               (a normal float32, so the
          //                                               offset product is normal)
          //     S       <- 2^-shift                      (a normal float32; the shift
          //                                               saturates at 120, which is
          //                                               the measured reach below)
          //
          // The physical per-pixel offset is unchanged — S * dc is exactly what the
          // old code computed — while neither the seeded delta nor S is ever
          // subnormal. That is what stops the collapse: it is the delta's RANGE that
          // was float32-bounded, not its mantissa, and no mantissa change (wider
          // hi/lo orbit words) can fix a range underflow. S is carried as TWO
          // factors because 2^-shift alone underflows for the deepest views; both
          // factors are powers of two, so every scaling step stays exact.
          //
          // The loop's EXISTING rescaling then walks S from 2^-shift toward |z| as
          // the delta grows, exactly as before. Nothing else changes: rebasing, the
          // glitch detector and the S-normalisation are untouched. With a shift of 0
          // the expressions are byte-for-byte the pre-change ones (S = 1, u_scale is
          // the true scale), which is why the shallow lane is unchanged.
          //
          // The shift is orthogonal to how the pass is SCHEDULED: a coarse-to-fine
          // pass re-runs this same per-pixel expression with the same uniforms, so
          // progressive refinement can reuse the mechanism unchanged (the exponent
          // depends on the VIEW, not on the frame's resolution or its place in a
          // refinement sequence).
          float S = exp2(-u_scaleShift);        // exact (power of two)
          float dcx = (v_uv.x - 0.5) * u_scale * u_aspect;
          float dcy = ((1.0 - v_uv.y) - 0.5) * u_scale;
          // DIAGNOSTIC ONLY (default 0, never set in production): u_diagLegacy == 1
          // reproduces the PRE-FIX seed exactly — the raw times-u_scale product with
          // S = 1 — so the pin can measure the collapse it fixes through the REAL
          // render path instead of hand-rolling a baseline. It is the same pattern
          // as P1's u_diag and P2's orbitMode: observation only.
          if (u_diagLegacy == 1) {
            dcx = (v_uv.x - 0.5) * u_scaleLegacy * u_aspect;
            dcy = ((1.0 - v_uv.y) - 0.5) * u_scaleLegacy;
            S = 1.0;
          }
          float dzx = 0.0, dzy = 0.0;    // w
          float ddx = dcx, ddy = dcy;    // d
          float Zx = 0.0, Zy = 0.0, Z2 = 0.0, z2g = 0.0;
          int m = 0;
          x = 0.0;
          y = 0.0;
          for (int i = 0; i < MAX_ITER; i++) {
            if (iter >= u_maxIter) break;
            // Z_m. m can only exceed the orbit when iter has reached u_maxIter,
            // which the break above has already caught; the clamp is a guard for
            // the single iteration where the orbit texture is one texel short of
            // maxIter + 1 (MAX_TEXTURE_SIZE == MAX_ITER == 8192).
            float om = min(float(m), u_orbitW - 1.0);
            vec4 o = texture2D(u_orbit, vec2((om + 0.5) / u_orbitW, 0.5));
            Zx = o.r;
            Zy = o.g;
            Z2 = Zx * Zx + Zy * Zy;
            float nwx = 2.0 * (Zx * dzx - Zy * dzy) + S * (dzx * dzx - dzy * dzy) + ddx;
            float nwy = 2.0 * (Zx * dzy + Zy * dzx) + S * (2.0 * dzx * dzy) + ddy;
            dzx = nwx;
            dzy = nwy;
            m++;
            float om2 = min(float(m), u_orbitW - 1.0);
            vec4 o2 = texture2D(u_orbit, vec2((om2 + 0.5) / u_orbitW, 0.5));
            Zx = o2.r;
            Zy = o2.g;
            x = Zx + S * dzx;
            y = Zy + S * dzy;
            escapeRadiusSq = x * x + y * y;
            // Pauldelbrot: a glitch is possible when |Z+z|^2 < G |Z|^2. The
            // expanded magnitude is used because |z| may be far below the float32
            // resolution of |Z| — which is exactly the case this detects.
            z2g = Z2 + 2.0 * S * (Zx * dzx + Zy * dzy) + S * S * (dzx * dzx + dzy * dzy);
            if (Z2 > 0.0 && z2g < PERTURB_GLITCH_G * Z2) glitchLevel = 1.0;
            // REBASING (rule in the header comment above).
            float zd2 = S * S * (dzx * dzx + dzy * dzy);
            if (escapeRadiusSq < zd2) {
              dzx = x / S;
              dzy = y / S;
              m = 0;
            }
            if (escapeRadiusSq > BAILOUT_SQ) break;
            iter++;
            // RESCALING. S is a power of two, so scaling by it is exact in float32.
            if (mod(float(iter), float(PERTURB_RESCALE_INTERVAL)) < 0.5) {
              float mag = S * sqrt(dzx * dzx + dzy * dzy);
              if (mag > 0.0 && mag < 3.0e38) {
                float newS = exp2(floor(log2(mag) + 0.5));
                float f = S / newS;
                dzx *= f;
                dzy *= f;
                ddx *= f;
                ddy *= f;
                S = newS;
              }
            }
          }
`;
    const plainBranch = `
          x = 0.0;
          y = 0.0;
          for (int i = 0; i < MAX_ITER; i++) {
            if (iter >= u_maxIter) break;
            float xtemp = x * x - y * y + x0;
            y = 2.0 * x * y + y0;
            x = xtemp;
            escapeRadiusSq = x * x + y * y;
            if (escapeRadiusSq > BAILOUT_SQ) break;
            iter++;
          }
`;
    const makeFragSrc = (mandelbrotBody) => defines + `
      precision highp float;
      varying vec2 v_uv;
      uniform float u_centerX, u_centerY, u_scale, u_aspect;
      // ARBITRARY DEPTH: the exponent folded out of u_scale into S. 0 in every
      // shallow draw (u_scale is then the true scale and S = 1, byte-for-byte the
      // pre-change shader); non-zero only in the deep lane, where it keeps the
      // seeded delta and S out of float32's subnormal range.
      uniform float u_scaleShift;
      // DIAGNOSTIC ONLY (default 0): reproduce the pre-fix delta seed. See the
      // perturbation branch. Production never sets either uniform non-zero.
      uniform float u_scaleLegacy;
      uniform int u_diagLegacy;
      uniform int u_maxIter;
      uniform int u_colorScheme;
      uniform float u_colorOffset;
      uniform int u_fractalType;
      uniform float u_julia_cx;
      uniform float u_julia_cy;
      // P1: the reference orbit as a float texture (one texel per reference
      // iteration, .r = Re Z_m, .g = Im Z_m) and the diagnostic selector. u_diag is
      // 0 for every production draw; the glitch pin is the only caller that sets 1.
      uniform sampler2D u_orbit;
      uniform float u_orbitW;
      uniform int u_diag;
      void main() {
        float x0 = u_centerX + (v_uv.x - 0.5) * u_scale * u_aspect;
        float y0 = u_centerY + ((1.0 - v_uv.y) - 0.5) * u_scale;
        float x, y;
        int iter = 0;
        // D1: the squared magnitude the escape test fires on. It is the SAME
        // quantity the kernel's iteratePixelState returns as escapeRadiusSq
        // (both are x*x + y*y of the state the test sees), and the smooth value
        // below is computed from it with the identical expression.
        float escapeRadiusSq = 0.0;
        // P1: the per-pixel Pauldelbrot glitch level (0 = none, 1 = detected at
        // PERTURB_GLITCH_G). Only the perturbation branch can raise it; the three
        // plain branches leave it at 0 because they have no reference to glitch.
        float glitchLevel = 0.0;
        if (u_fractalType == FT_JULIA) { // Julia
          x = x0;
          y = y0;
          for (int i = 0; i < MAX_ITER; i++) {
            if (iter >= u_maxIter) break;
            float xtemp = x * x - y * y + u_julia_cx;
            y = 2.0 * x * y + u_julia_cy;
            x = xtemp;
            escapeRadiusSq = x * x + y * y;
            if (escapeRadiusSq > BAILOUT_SQ) break;
            iter++;
          }
        } else if (u_fractalType == FT_BURNINGSHIP) { // Burning Ship
          x = 0.0;
          y = 0.0;
          for (int i = 0; i < MAX_ITER; i++) {
            if (iter >= u_maxIter) break;
            float xtemp = x * x - y * y + x0;
            y = abs(2.0 * x * y) + y0;
            x = abs(xtemp);
            escapeRadiusSq = x * x + y * y;
            if (escapeRadiusSq > BAILOUT_SQ) break;
            iter++;
          }
        } else if (u_fractalType == FT_TRICORN) { // Tricorn
          x = 0.0;
          y = 0.0;
          for (int i = 0; i < MAX_ITER; i++) {
            if (iter >= u_maxIter) break;
            float xtemp = x * x - y * y + x0;
            y = -2.0 * x * y + y0;
            x = xtemp;
            escapeRadiusSq = x * x + y * y;
            if (escapeRadiusSq > BAILOUT_SQ) break;
            iter++;
          }
        } else { // FT_MANDELBROT
${mandelbrotBody}
        }
        // D1: the smooth (continuous) escape value. This is the SAME expression
        // as the kernel's smoothIterationValue, on the same n and the same escape
        // magnitude. n is the 1-BASED INDEX of the update that produced
        // escapeRadiusSq, i.e. iter + 1 here because this loop breaks BEFORE its
        // own iter++; the kernel's loop returns that count already incremented, so
        // it passes its iter unchanged. Getting this off by one is a systematic
        // one-iteration colour difference between the renderers, which pin 5's
        // low-cap GPU/CPU parity check measures (a whole 5-unit band at maxIter 50).
        //   n + 1 - log2( log(|z|^2) / log(BAILOUT_SQ) )
        // and the iter == u_maxIter case (inside the set) is forced to exactly
        // u_maxIter so it stays black and matches the kernel exactly. A staircase
        // here is what made a precision hop visible when zooming.
        float n = float(iter) + 1.0;
        float smooth = n + 1.0 - log(log(escapeRadiusSq) * SMOOTH_LOG_BAILOUT) / log(2.0);
        if (iter == u_maxIter || !(smooth < float(u_maxIter))) smooth = float(u_maxIter);
        float t = smooth / float(u_maxIter);
        t = mod(t + u_colorOffset, 1.0);
        vec3 color;
        if (iter == u_maxIter) {
          color = vec3(0.0,0.0,0.0);
        } else if (u_colorScheme == CS_RAINBOW) {
          // Rainbow
          float a = (1.0 - t) * 4.0;
          int X = int(floor(a));
          float Y = 255.0 * (a - float(X));
          if (X == 0) color = vec3(0.0, Y/255.0, 1.0); // blue->cyan
          else if (X == 1) color = vec3(0.0, 1.0, (255.0-Y)/255.0); // cyan->green
          else if (X == 2) color = vec3(Y/255.0, 1.0, 0.0); // green->yellow
          else if (X == 3) color = vec3(1.0, (255.0-Y)/255.0, 0.0); // yellow->red
          else color = vec3(1.0, 0.0, 0.0);
        } else if (u_colorScheme == CS_FIRE) {
          // Fire
          if (t < 0.33) color = vec3(3.0*t, 0.0, 0.0);
          else if (t < 0.66) color = vec3(1.0, 3.0*(t-0.33), 0.0);
          else color = vec3(1.0, 1.0, 3.0*(t-0.66));
        } else if (u_colorScheme == CS_OCEAN) {
          // Ocean
          if (t < 0.5) color = vec3(0.0, 2.0*t, 0.50196+0.49804*2.0*t);
          else color = vec3(2.0*(t-0.5), 1.0, 1.0);
        } else if (u_colorScheme == CS_GRAYSCALE) {
          // Grayscale
          color = vec3(t, t, t);
        } else if (u_colorScheme == CS_VIRIDIS) {
          // Viridis (approximate, WebGL1 compatible, no array indexing)
          float idx = t * 8.0;
          int iidx = int(floor(idx));
          float frac = idx - float(iidx);
          vec3 c0, c1;
          if (iidx == 0) {
            c0 = vec3(0.266,0.004,0.329);
            c1 = vec3(0.278,0.173,0.478);
          } else if (iidx == 1) {
            c0 = vec3(0.278,0.173,0.478);
            c1 = vec3(0.231,0.318,0.545);
          } else if (iidx == 2) {
            c0 = vec3(0.231,0.318,0.545);
            c1 = vec3(0.173,0.443,0.557);
          } else if (iidx == 3) {
            c0 = vec3(0.173,0.443,0.557);
            c1 = vec3(0.129,0.564,0.552);
          } else if (iidx == 4) {
            c0 = vec3(0.129,0.564,0.552);
            c1 = vec3(0.153,0.678,0.506);
          } else if (iidx == 5) {
            c0 = vec3(0.153,0.678,0.506);
            c1 = vec3(0.361,0.784,0.388);
          } else if (iidx == 6) {
            c0 = vec3(0.361,0.784,0.388);
            c1 = vec3(0.667,0.862,0.196);
          } else if (iidx == 7) {
            c0 = vec3(0.667,0.862,0.196);
            c1 = vec3(0.992,0.906,0.145);
          } else {
            c0 = vec3(0.992,0.906,0.145);
            c1 = vec3(0.992,0.906,0.145);
          }
          color = mix(c0, c1, frac);
        } else {
          color = vec3(t, t, t);
        }
        // P1: the ONLY difference the diagnostic selector makes. u_diag is 0 for
        // every production draw (set in render()); the glitch observation hook is
        // the only caller that passes 1, and it reads the Pauldelbrot level the
        // perturbation branch computed instead of a palette colour.
        //
        // P2 adds u_diag == 2: the shader's OWN escape index, written in two bytes
        // so the suite can compare the GPU's ESCAPE VALUE against an independent
        // per-pixel reference instead of inferring it from a palette colour. The
        // palette compresses an iteration difference of ~8 to ~0.25 RGB units at a
        // deep budget, which is not a discriminating measurement; the escape index
        // itself is. n = iter + 1 is the kernel's own 1-based convention (the
        // escaping update), and n == u_maxIter + 1 is the INSIDE sentinel, exactly
        // as the colour branch treats iter == u_maxIter.
        if (u_diag == 1) gl_FragColor = vec4(glitchLevel, 0.0, 0.0, 1.0);
        else if (u_diag == 2) {
          float en = float(iter) + 1.0;
          gl_FragColor = vec4(floor(en / 256.0) / 255.0, mod(en, 256.0) / 255.0, 0.0, 1.0);
        }
        else gl_FragColor = vec4(color, 1.0);
      }
    `;
    // P1: TWO programs, chosen per draw by the view's depth (see draw). The deep
    // lane carries the reference orbit and the delta iteration; the shallow lane is
    // the original plain float32 loop, byte-for-byte, so shallow GPU cost and
    // shallow pixels are exactly what they were before P1. Compiling both costs one
    // extra shader and keeps the selection a per-draw decision rather than a
    // per-context one.
    const perturbFragSrc = this.hasFloatTexture
      ? makeFragSrc(perturbBranch)
      : makeFragSrc(plainBranch);
    const plainFragSrc = makeFragSrc(plainBranch);
    // Record what was ACTUALLY templated, so the suite can observe the shader's
    // loop bound rather than infer it from pixels (S3 pin 2). `shaderLoopBounds`
    // holds the bound token of every `for (int i = 0; i < ...; i++)` site: it must
    // read MAX_ITER at all four sites, and `shaderMaxIter` must equal the kernel's
    // single cap. Both lanes have exactly four sites; the PERTURBATION source is
    // the one recorded, because it is the one that carries P1's mechanisms.
    const fragSrc = perturbFragSrc;
    const maxIterDefine = fragSrc.match(/#define MAX_ITER (\d+)/);
    this.shaderMaxIter = maxIterDefine ? Number(maxIterDefine[1]) : null;
    this.shaderLoopBounds = Array.from(
      fragSrc.matchAll(/for \(int i = 0; i < ([A-Za-z_][A-Za-z0-9_]*); i\+\+\)/g),
      (m) => m[1]
    );
    // D1: the smooth-colour constants ACTUALLY templated in, so the suite can hold
    // the GPU and the kernel to the same numbers instead of trusting the source.
    const smoothDefine = fragSrc.match(/#define SMOOTH_LOG_BAILOUT ([-\d.eE+]+)/);
    this.shaderSmoothLogBailout = smoothDefine ? Number(smoothDefine[1]) : null;
    // The fragment source as an own NON-ENUMERABLE property, so a pin can read the
    // smooth expression itself (`n + 1.0 - log(...)`) rather than infer it from
    // pixels, without leaking into console dumps of the renderer.
    Object.defineProperty(this, 'shaderSource', { value: fragSrc, enumerable: false });

    // Compile a fragment source and link it with the ONE vertex shader. Every
    // handle is held on the returned object so a partially built renderer can be
    // torn down whichever step failed.
    const buildProgram = (src) => {
      const vsh = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vsh, vertSrc);
      gl.compileShader(vsh);
      const vCompiled = gl.getShaderParameter(vsh, gl.COMPILE_STATUS);
      const vLog = gl.getShaderInfoLog(vsh);
      const fsh = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fsh, src);
      gl.compileShader(fsh);
      const fCompiled = gl.getShaderParameter(fsh, gl.COMPILE_STATUS);
      const fLog = gl.getShaderInfoLog(fsh);
      if (!vCompiled || !fCompiled) {
        if (!vCompiled) console.error('[WebGL] vertex shader failed:', vLog);
        if (!fCompiled) console.error('[WebGL] fragment shader failed:', fLog);
        gl.deleteShader(vsh);
        gl.deleteShader(fsh);
        throw new Error(vCompiled ? 'Fragment shader failed: ' + fLog : 'Vertex shader failed: ' + vLog);
      }
      const program = gl.createProgram();
      gl.attachShader(program, vsh);
      gl.attachShader(program, fsh);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const linkLog = gl.getProgramInfoLog(program);
        console.error('[WebGL] program link failed:', linkLog);
        gl.deleteProgram(program);
        gl.deleteShader(vsh);
        gl.deleteShader(fsh);
        throw new Error('Program link failed: ' + linkLog);
      }
      return { program, vsh, fsh };
    };
    const perturbBuilt = buildProgram(perturbFragSrc);
    this.program = perturbBuilt.program;
    this.vsh = perturbBuilt.vsh;
    this.fsh = perturbBuilt.fsh;
    if (plainFragSrc !== perturbFragSrc) {
      const plainBuilt = buildProgram(plainFragSrc);
      this.plainProgram = plainBuilt.program;
      this.plainVsh = plainBuilt.vsh;
      this.plainFsh = plainBuilt.fsh;
    } else {
      this.plainProgram = this.program;
      this.plainVsh = this.vsh;
      this.plainFsh = this.fsh;
    }
    // --- COARSE-TO-FINE: the PRESENT pass ------------------------------------
    // A coarse pass runs the SAME fragment program with the SAME uniforms (the
    // iteration and colour arithmetic exists ONCE — DECISIONS row 52) into an
    // offscreen RGBA texture of ceil(W/step) x ceil(H/step) texels, then magnifies
    // that texture over the whole canvas with this tiny textured-quad program.
    // The cost of a pass is therefore proportional to the number of FRAGMENTS it
    // rasterises, so a step-8 pass does 1/64 of the final pass's work — which is
    // the whole point: a "coarse pass" that internally rendered every pixel and
    // merely downsampled (a mipmap of a full-res render) is not refinement and is
    // explicitly NOT what this does.
    const blitFragSrc = `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_src;
      void main() { gl_FragColor = texture2D(u_src, v_uv); }
    `;
    const blitBuilt = buildProgram(blitFragSrc);
    this.blitProgram = blitBuilt.program;
    this.blitVsh = blitBuilt.vsh;
    this.blitFsh = blitBuilt.fsh;
    this.blitU = { src: gl.getUniformLocation(this.blitProgram, 'u_src') };

    gl.useProgram(this.program);
    // Fullscreen quad
    const posBuf = gl.createBuffer();
    this.posBuf = posBuf;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    // Uniform locations. They are PER PROGRAM objects in WebGL — a location looked
    // up from one program is invalid for another — so each lane gets its own set and
    // `draw` selects the one belonging to the program it just bound. (The first cut
    // of this slice shared one set and the shallow lane silently drew nothing: the
    // S3 parity pins measured an all-zero GPU canvas.)
    const uniformSet = (program) => ({
      centerX: gl.getUniformLocation(program, 'u_centerX'),
      centerY: gl.getUniformLocation(program, 'u_centerY'),
      scale: gl.getUniformLocation(program, 'u_scale'),
      // ARBITRARY DEPTH: the exponent folded out of `scale` into `S`.
      scaleShift: gl.getUniformLocation(program, 'u_scaleShift'),
      // DIAGNOSTIC ONLY: the pre-fix seed (see the perturbation branch).
      scaleLegacy: gl.getUniformLocation(program, 'u_scaleLegacy'),
      diagLegacy: gl.getUniformLocation(program, 'u_diagLegacy'),
      aspect: gl.getUniformLocation(program, 'u_aspect'),
      maxIter: gl.getUniformLocation(program, 'u_maxIter'),
      colorScheme: gl.getUniformLocation(program, 'u_colorScheme'),
      colorOffset: gl.getUniformLocation(program, 'u_colorOffset'),
      fractalType: gl.getUniformLocation(program, 'u_fractalType'),
      juliaCx: gl.getUniformLocation(program, 'u_julia_cx'),
      juliaCy: gl.getUniformLocation(program, 'u_julia_cy'),
      // P1: the reference-orbit sampler and the diagnostic selector.
      orbit: gl.getUniformLocation(program, 'u_orbit'),
      orbitW: gl.getUniformLocation(program, 'u_orbitW'),
      diag: gl.getUniformLocation(program, 'u_diag'),
    });
    this.uPerturb = uniformSet(this.program);
    this.uPlain = uniformSet(this.plainProgram);
    // Kept as an alias for the deep lane, which is the program `shaderSource`
    // describes; nothing outside `draw` reads these.
    this.u_centerX = this.uPerturb.centerX;
    this.colorOffset = 0;
  }

  setColorOffset(offset) {
    this.colorOffset = offset;
  }

  // --- ARBITRARY DEPTH: the delta-coordinate RANGE split ----------------------
  // The defect this replaces: `dc = (v_uv - 0.5) * u_scale` with `u_scale` a
  // float32 UNIFORM. Past ~2e-38 the product is subnormal and every pixel lands on
  // the reference point before rebasing/rescaling can act (measured through the
  // REAL shader: structured at 1e-37, ONE value at 2e-38).
  //
  // The fix is a uniform split, not a new algorithm:
  //   u_scale        <- scale * 2^shift            (kept a NORMAL float32)
  //   u_scaleShift <- shift, folded into S = exp2(-shift)
  // so the shader forms the SAME physical delta (`S * dc` is untouched because
  // `2^shift * 2^-shift === 1` exactly) while neither the seeded delta nor S is
  // ever subnormal. The exponent then rides the loop's EXISTING rescaling, which
  // already walks S toward |z|.
  //
  // The shift is chosen by MEASUREMENT (docs/DECISIONS.md, GPU-ARBITRARY rows). It
  // is CAPPED at 120 because S = 2^-shift must itself stay a normal float32: past
  // that the representation's own scale underflows, which is where this slice's
  // measured reach ends. A two-factor S (S = S1*S2) was implemented and measured to
  // be WORSE at every depth it was tried on (double rounding in the quadratic term
  // turned the exact 1e-40 result into 32% misclassification), so it is not shipped.
  // `TARGET_DEEP_DELTA_EXP` is the magnitude the seeded delta is aimed at
  // (2^-40 ~ 9.1e-13): normal, comfortably above the subnormal boundary, and below
  // 1 so the first iterations stay in the linear regime the perturbation
  // formulation wants.
  deepScaleUniforms(scale, seedShiftOverride = 0) {
    const TARGET_DEEP_DELTA_EXP = -40;
    // A normal float32 spans 2^-126 .. 2^127; S = 2^-shift must land inside it.
    const MAX_SHIFT = 120;
    if (!(scale > 0) || !isFinite(scale)) {
      return { scale: scale, shift: 0 };
    }
    // The first iteration's delta is |offset * scale| with |offset| <= ~0.8, so its
    // exponent is ~log2(scale). Fold out the power of two that lands it near
    // TARGET_DEEP_DELTA_EXP; the offset ORDER never matters because the shift is an
    // integer power of two, so 2^shift * 2^-shift is exactly 1.
    const e = Math.log2(scale);                       // scale = 2^e, e < 0 for a zoom
    let shift = Math.round(TARGET_DEEP_DELTA_EXP - e);
    if (!isFinite(shift)) return { scale: scale, shift: 0 };
    if (shift < 0) shift = 0;
    shift += seedShiftOverride | 0;
    if (shift < 0) shift = 0;
    // S = 2^-shift is a normal float32 only while shift <= 120; past that the shift
    // saturates. This is a RANGE limit (the delta seed stops tracking the view scale
    // around 1e-49) and it binds LATER than the current solver's MANTISSA limit: the
    // 24-bit float32 delta accumulates relative error and is measured 7.4 %
    // misclassified at 1e-42. Since LANE-CONTINUITY there is NO zoom cap, so neither
    // is a stop — the app keeps rendering and says via the deep-precision notice that
    // the current single-factor solver is past its measured-correct reach. Widening
    // the MANTISSA (compensated / multi-component delta) is the next solver slice.
    if (shift > MAX_SHIFT) shift = MAX_SHIFT;
    // Scale by a power of two exactly (`Math.pow(2, n)` is exact for integer n).
    const scaled = scale * Math.pow(2, shift);
    if (!(scaled > 0) || !isFinite(scaled)) {
      return { scale: scale, shift: 0 };
    }
    return { scale: scaled, shift: shift };
  }

  // Keep the drawing buffer at CSS size x devicePixelRatio and the viewport in
  // step. Returns true when the backing store actually changed.
  resize(cssWidth, cssHeight, dpr) {
    const canvas = this.canvas;
    if (!canvas) return false;
    const ratio = dpr || window.devicePixelRatio || 1;
    const cssW = cssWidth || window.innerWidth;
    const cssH = cssHeight || window.innerHeight;
    const w = Math.max(1, Math.round(cssW * ratio));
    const h = Math.max(1, Math.round(cssH * ratio));
    let changed = false;
    if (canvas.width !== w) { canvas.width = w; changed = true; }
    if (canvas.height !== h) { canvas.height = h; changed = true; }
    if (changed && this.gl && !this.gl.isContextLost()) {
      this.gl.viewport(0, 0, canvas.width, canvas.height);
    }
    return changed;
  }

  // --- P1: the reference orbit -------------------------------------------------
  // The float64 orbit of the view centre, ONCE per view. This is the whole point
  // of the slice: at deep zoom no float32 absolute coordinate exists, so the
  // per-pixel coordinate is carried as a delta from this orbit instead. The loop
  // is the kernel's own float64 recurrence (Z_0 = 0, Z_{k+1} = Z_k^2 + C) — the
  // reference does not need the kernel's escape machinery, only its values.
  //
  // The result is uploaded as an RGBA FLOAT texture, one texel per reference
  // iteration, .r = Re Z_k and .g = Im Z_k. The committed probe measured this
  // transport EXACT (NEAREST round-trips 53 significant bits; MAX_TEXTURE_SIZE ==
  // the shipped cap) and measured a hi/lo split of the orbit to be INERT under a
  // float32 delta, so one float32 word per component is what is stored.
  ensureReferenceOrbit(centerX, centerY, maxIter) {
    const gl = this.gl;
    if (!gl || this.destroyed || gl.isContextLost() || !this.hasFloatTexture) return;
    const key = centerX + '|' + centerY + '|' + maxIter;
    if (this._orbitKey === key && this._orbitTex) return;
    // maxIter + 1 values are needed (Z_0 .. Z_maxIter); at the shipped cap that is
    // one more than MAX_TEXTURE_SIZE, so the last value is clamped in the shader.
    const width = Math.max(1, Math.min(maxIter + 1, this.maxOrbitWidth));
    const data = new Float32Array(width * 4);
    const zx = new Float64Array(width);
    const zy = new Float64Array(width);
    let x = 0, y = 0;
    for (let k = 0; k < width; k++) {
      zx[k] = x;
      zy[k] = y;
      const xt = x * x - y * y + centerX;
      y = 2 * x * y + centerY;
      x = xt;
      data[k * 4] = Math.fround(zx[k]);
      data[k * 4 + 1] = Math.fround(zy[k]);
    }
    if (!this._orbitTex) this._orbitTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
    // NPOT is fine with CLAMP_TO_EDGE + NEAREST (measured on this host).
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._orbitKey = key;
    this._orbitW = width;
    this._orbitZx = zx;
    this._orbitZy = zy;
    this.orbitComputations++;
  }

  // The cached orbit, as plain arrays, for the suite's float64 perturbation
  // reference. Observation only: no rendered behaviour reads this.
  getOrbit() {
    if (!this._orbitZx) return null;
    return {
      zx: Array.from(this._orbitZx),
      zy: Array.from(this._orbitZy),
      width: this._orbitW,
      key: this._orbitKey,
    };
  }

  // --- P2: the arbitrary-precision (BigInt) reference orbit -------------------
  // The exact centre arrives as a DECIMAL STRING on the view (`centerXExact` /
  // `centerYExact`), because that is the only representation that can name a point
  // past a float64 centre's own ULP. The Worker computes the orbit at the working
  // precision for the view scale and posts back the float32 transport words.
  //
  // Returns true when an orbit for this key is ALREADY uploaded (the draw can use
  // it), false while a request is in flight or after an error (the caller falls
  // back to the float64 lane for that draw). A completed orbit triggers
  // `onBigOrbitReady`, wired by app.js to the real render path.
  ensureBigOrbit(centerXStr, centerYStr, maxIter, scale) {
    if (typeof Worker === 'undefined') return false;
    const bits = this.bigOrbitBitsOverride > 0
      ? this.bigOrbitBitsOverride
      : BigOrbit.bitsForScale(scale);
    const key = BigOrbit.orbitKey(centerXStr, centerYStr, maxIter, bits);
    if (this._bigOrbit && this._bigOrbit.key === key && this._orbitTex) return true;
    if (this._bigOrbitPending === key) return false;
    this._bigOrbitPending = key;
    const reqId = ++this._orbitReqId;
    if (!this._orbitWorker) {
      try {
        this._orbitWorker = new Worker('orbitWorker.js');
        this.bigOrbitWorkerSpawns++;
      } catch (err) {
        this._orbitWorker = null;
        this._bigOrbitPending = null;
        this.bigOrbitErrors++;
        return false;
      }
      this._orbitWorker.onmessage = (event) => this._onBigOrbitMessage(event.data);
      this._orbitWorker.onerror = () => {
        this.bigOrbitErrors++;
        this._bigOrbitPending = null;
      };
    }
    this.bigOrbitRequests++;
    this._lastRequestControl = BigOrbit.getControlStepShift();
    this._orbitWorker.postMessage({
      type: 'orbit',
      id: reqId,
      key: key,
      centerX: centerXStr,
      centerY: centerYStr,
      maxIter: maxIter,
      bits: bits,
      width: this.maxOrbitWidth,
      // TEST-ONLY transition-corruption injection (default 0), carried to the
      // Worker because the control is read where the orbit is actually computed.
      control: this._lastRequestControl,
    });
    return false;
  }

  _onBigOrbitMessage(msg) {
    if (!msg) return;
    if (msg.type === 'orbit-error') {
      this.bigOrbitErrors++;
      this._bigOrbitPending = null;
      return;
    }
    if (msg.type !== 'orbit' || msg.key !== this._bigOrbitPending) return;
    this._bigOrbitPending = null;
    // Upload exactly as the float64 lane does: one float texel per iteration,
    // .r = Re Z_k, .g = Im Z_k. The BigInt module has already produced the
    // float32 words (the measured-sufficient transport).
    const gl = this.gl;
    const width = Math.max(1, Math.min(msg.width, this.maxOrbitWidth));
    if (!gl || this.destroyed || gl.isContextLost()) return;
    if (!this._orbitTex) this._orbitTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
    const data = new Float32Array(width * 4);
    for (let k = 0; k < width; k++) {
      data[k * 4] = msg.zx[k];
      data[k * 4 + 1] = msg.zy[k];
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._bigOrbit = { key: msg.key, width: width, bits: msg.bits, escapedAt: msg.escapedAt };
    this._orbitKey = msg.key;
    this._orbitW = width;
    this._orbitZx = msg.zx;
    this._orbitZy = msg.zy;
    this.orbitComputations++;
    this.bigOrbitComputations++;
    this.lastBigOrbitMs = msg.ms;
    if (typeof this.onBigOrbitReady === 'function') this.onBigOrbitReady();
  }

  // Observation only: the cached arbitrary-precision orbit's identity, so the
  // suite can assert WHICH precision was actually used and that the orbit was
  // really the BigInt one (no rendered behaviour reads this).
  getBigOrbitInfo() {
    if (!this._bigOrbit) return null;
    return {
      key: this._bigOrbit.key,
      width: this._bigOrbit.width,
      bits: this._bigOrbit.bits,
      escapedAt: this._bigOrbit.escapedAt,
      mode: this.orbitMode,
      control: this._lastRequestControl || 0,
    };
  }

  render(view, maxIter, colorSchemeIdx = 0, fractalType = 0, juliaParams = undefined) {
    this.draw(view, maxIter, colorSchemeIdx, fractalType, juliaParams, 0);
  }

  // P1 observation hook: draw the SAME perturbation pass with u_diag = 1, so the
  // fragment writes the Pauldelbrot glitch level instead of a colour, and read it
  // back. Production rendering never passes diag = 1, so this adds no production
  // path; it exists so "the glitch detector fires on N% of this frame" is measured
  // from the GPU rather than asserted from the source.
  renderGlitchFrame(view, maxIter, fractalType = 0, juliaParams = undefined) {
    this.draw(view, maxIter, 0, fractalType, juliaParams, 1);
    const gl = this.gl;
    if (!gl || this.destroyed || gl.isContextLost()) return null;
    const w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let glitched = 0, worst = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 0) glitched++;
      if (px[i] > worst) worst = px[i];
    }
    const n = w * h;
    return { n, glitched, glitchedFrac: glitched / n, worst };
  }

  // P2 observation hook: draw the SAME perturbation pass with u_diag = 2 and read
  // back the shader's OWN escape index (n = iter + 1; n == maxIter + 1 means
  // inside). The pin compares this against an independent per-pixel reference, so
  // the measurement is of the escape VALUE rather than of a palette colour that
  // compresses it. Production never passes diag = 2, so this adds no production
  // path; it is the same pattern as P1's renderGlitchFrame.
  renderOrbitFrame(view, maxIter, fractalType = 0, juliaParams = undefined) {
    this.draw(view, maxIter, 0, fractalType, juliaParams, 2);
    const gl = this.gl;
    if (!gl || this.destroyed || gl.isContextLost()) return null;
    const w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const cap = FractalKernel.clampMaxIter(maxIter);
    const n = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const k = i * 4;
      n[i] = Math.round(px[k]) * 256 + Math.round(px[k + 1]);
    }
    return { n, w, h, cap, insideSentinel: cap + 1 };
  }

  // --- COARSE-TO-FINE: the shared per-pass body --------------------------------
  // Pick the lane, build/upload the reference orbit if this view needs one, bind
  // the program and its uniforms, and issue exactly ONE full-frame drawArrays.
  // It deliberately does NOT touch the clock, the viewport or the framebuffer, so
  // the SAME body serves a full-resolution pass (straight to the canvas) and a
  // coarse pass (into the offscreen target). Both run the ONE fragment program, so
  // the iteration and colour arithmetic exists once (DECISIONS row 52) and the
  // only thing that changes between levels is the pass's SAMPLE DENSITY — a
  // parameter (how many fragments are rasterised), not a second implementation.
  _drawFractal(view, maxIter, colorSchemeIdx, fractalType, juliaParams, diag) {
    const gl = this.gl;
    const cap = FractalKernel.clampMaxIter(maxIter);
    // P1: WHICH LANE. The reference orbit buys accuracy only past where the plain
    // float32 coordinate has already lost its pixels, and it costs a texture fetch
    // per iteration, so the deep lane starts at the scale the app's deep-lane
    // boundary owns (`ITER_BUDGET_MIN_SCALE`). Above that scale the plain lane is
    // byte-for-byte the pre-P1 shader, so shallow cost and shallow pixels are
    // unchanged — measured: keeping the deep lane always on doubled the whole
    // full-gate wall time (5.9m vs 2.9m), because the startup animation alone draws
    // ~60 full-window frames.
    //
    // LANE-CONTINUITY (2026-09-22) MEASURED this program switch on its own, with the
    // effective budget held FIXED at 4096 and 8192 so D2's budget floor could not
    // contribute: across the boundary the frame moves by 0.005-0.036 mean-red units,
    // which is the same order as the sweep's own non-boundary step (0.036). The
    // visible 31.6-unit jump that made this boundary a defect was the BUDGET FLOOR
    // TURNING ON at the same scale (512 -> 2058 in one step), not the lane: the two
    // lanes agree here because at 1e-4 the plain float32 coordinate is still
    // sub-pixel accurate. So the lane choice stays a program choice and is
    // measurably invisible; the budget rule was made continuous instead (see
    // `iterBudgetForScale`). A pin (`tests/lane-continuity.spec.js`) holds BOTH
    // halves: the shipped sweep has no outlier step, and the lane switch's own
    // colour delta is below the sweep's noise. Blending the two programs across a
    // band was rejected on this measurement — it would double the draw cost in the
    // band for a difference smaller than the frame's own step-to-step change.
    const deepLane = this.hasFloatTexture
      && view.scale < FractalKernel.ITER_BUDGET_MIN_SCALE
      && (diag === 1 || fractalType === FractalKernel.indexForType('mandelbrot'));
    // P1: the reference orbit is built/uploaded HERE, keyed on the view identity,
    // so a colour change, a resize or a repeated draw of the same view reuses it
    // (counted, not inferred).
    //
    // P2: which ORBIT SOURCE. A view carrying an exact decimal centre deeper than
    // the float64 lane's reach (`BIGORBIT_MAX_SCALE`) uses the arbitrary-precision
    // Worker orbit. Until it has arrived, or when the source is forced to
    // 'float64' for observation, the float64 lane above serves the draw — which at
    // this depth is exactly the wall P2 removes. The P1 pins run at 1e-15, where
    // `scale < BIGORBIT_MAX_SCALE` is false and this branch is never taken.
    this.usePerturbation = deepLane;
    this.orbitSource = 'none';
    const exactCentre = typeof view.centerXExact === 'string'
      && typeof view.centerYExact === 'string';
    if (deepLane && exactCentre && this.orbitMode !== 'float64'
      && view.scale < BigOrbit.BIGORBIT_MAX_SCALE) {
      const ready = this.ensureBigOrbit(view.centerXExact, view.centerYExact, cap, view.scale);
      if (ready) {
        this.usePerturbation = true;
        this.orbitSource = 'bigint';
      }
    }
    if (deepLane && this.orbitSource !== 'bigint') {
      this.ensureReferenceOrbit(view.centerX, view.centerY, cap);
      this.usePerturbation = !!(this._orbitTex && this._orbitW > 0);
      if (this.usePerturbation) this.orbitSource = 'float64';
    }
    const program = this.usePerturbation ? this.program : this.plainProgram;
    gl.useProgram(program);
    // Uniform locations belong to the program that was just bound.
    const U = this.usePerturbation ? this.uPerturb : this.uPlain;
    gl.uniform1f(U.centerX, view.centerX);
    gl.uniform1f(U.centerY, view.centerY);
    // ARBITRARY DEPTH: the deep lane seeds its delta in float32's NORMAL range and
    // folds the scale exponent into the shader's `S`. The seam is the RANGE of the
    // delta coordinate, so this is a uniform SPLIT, not a change of algorithm:
    // `u_scale` carries scale*2^shift and `u_scaleShift` carries the exponent. The
    // physical per-pixel offset is identical (S * dc is unchanged), and with a
    // shift of 0 the two values are exactly the pre-change ones — which is why the
    // shallow lane is byte-for-byte identical (measured, pin 2).
    // shift 0 => scale is the true scale and both factors are exactly 1: the
    // pre-change expressions, unchanged.
    let seeded = { scale: view.scale, shift: 0 };
    if (this.usePerturbation) {
      seeded = this.deepScaleUniforms(view.scale, this.deepSeedShift);
    }
    // ARBITRARY DEPTH: the delta-coordinate RANGE split. `u_scale` carries the
    // normal-range seed and `u_scaleShift` the exponent the shader folds into S.
    // With shift 0 both are the plain pre-change values.
    gl.uniform1f(U.scale, seeded.scale);
    gl.uniform1f(U.scaleShift, seeded.shift || 0);
    // DIAGNOSTIC ONLY: default OFF, so production draws the fixed seed. The pin
    // turns it on to measure the pre-fix collapse through the same program.
    gl.uniform1i(U.diagLegacy, this.legacyDeltaSeed ? 1 : 0);
    gl.uniform1f(U.scaleLegacy, view.scale);
    gl.uniform1f(U.aspect, this.canvas.width / this.canvas.height);
    // The shader's loop bound is the constant MAX_ITER; clamping the uniform to the
    // same ONE constant is what makes `iter == u_maxIter` (the "inside" test) mean
    // the same thing on the GPU as it does in the kernel (S3/B5).
    gl.uniform1i(U.maxIter, cap);
    gl.uniform1i(U.colorScheme, colorSchemeIdx);
    gl.uniform1f(U.colorOffset, this.colorOffset || 0);
    // Fractal type index comes from the kernel's FRACTAL_TYPES table (app.js
    // passes `FractalKernel.indexForType(...)`), never from a literal here.
    gl.uniform1i(U.fractalType, fractalType);
    if (fractalType === FractalKernel.indexForType('julia') && juliaParams && Array.isArray(juliaParams.c)) {
      gl.uniform1f(U.juliaCx, juliaParams.c[0]);
      gl.uniform1f(U.juliaCy, juliaParams.c[1]);
    } else {
      gl.uniform1f(U.juliaCx, 0.0);
      gl.uniform1f(U.juliaCy, 0.0);
    }
    // P1: bind the orbit for the deep lane. `usePerturbation` is exposed so the
    // suite can assert which lane drew.
    if (this._orbitTex && this.usePerturbation) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._orbitTex);
      gl.uniform1i(U.orbit, 0);
      gl.uniform1f(U.orbitW, this._orbitW);
    } else {
      gl.uniform1f(U.orbitW, 0.0);
    }
    // The attribute index is looked up per program: the two lanes share the vertex
    // shader, but nothing guarantees the linker gives `a_position` the same index in
    // both, and the vertex attribute array is global state.
    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(U.diag, diag);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.uniform1i(U.diag, 0);
    return { cap: cap, usePerturbation: this.usePerturbation, orbitSource: this.orbitSource };
  }

  // The completion sync, and the reason it exists: a wall clock around drawArrays
  // alone reads 0.0 ms at every depth (WebGL queues the command and returns), and
  // `gl.finish()` does NOT wait on this host's ANGLE/SwiftShader (measured 0.2 ms
  // against a true 288 ms image). A ONE-PIXEL readback DOES wait, and costs ~7 % of
  // an already ~227 ms image — affordable per IMAGE, and it is what makes the
  // reported number the real cost of the image the user is looking at.
  _syncPass() {
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._syncPixel);
    }
  }

  _now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  // A FULL-RESOLUTION pass, straight to the canvas. This is the pass whose pixels
  // the shipped app has always shown, and with the same uniforms it is
  // byte-for-byte the pre-refinement frame (the final level of a refinement chain,
  // and the only level when the chain is `[1]`). `fullImagePasses` counts exactly
  // these, so "the readout covers a full image" stays a counted fact.
  draw(view, maxIter, colorSchemeIdx, fractalType, juliaParams, diag) {
    const gl = this.gl;
    // Safe to call after destroy()/context loss: draw nothing rather than throw.
    if (!gl || this.destroyed || gl.isContextLost() || !this.program) return null;
    const drawStart = this._now();
    if (gl.canvas && (gl.drawingBufferWidth !== this.canvas.width || gl.drawingBufferHeight !== this.canvas.height)) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    this._drawFractal(view, maxIter, colorSchemeIdx, fractalType, juliaParams, diag);
    this._syncPass();
    this.lastDrawMs = this._now() - drawStart;
    this.lastPassMs = this.lastDrawMs;
    this.lastPassStep = 1;
    this.gpuPasses++;
    this.fullImagePasses++;
    return { step: 1, width: this.canvas.width, height: this.canvas.height, ms: this.lastDrawMs };
  }

  // --- COARSE-TO-FINE: one refinement level ------------------------------------
  // `sampleStep > 1` renders the view into an offscreen target of
  // ceil(W/step) x ceil(H/step) texels and then magnifies it onto the canvas, so
  // the fragment work — and therefore the measured ms — is 1/step^2 of the final
  // pass. `sampleStep === 1` is exactly `draw`, i.e. the shipped full-resolution
  // pass, so the last level of every chain is the pre-refinement image unchanged.
  //
  // REJECTED ALTERNATIVES, so the choice is on the record:
  //  * a full-resolution pass with a coarser SAMPLE RASTER (a `u_sampleStep`
  //    uniform that skips the iteration for non-grid fragments). It is genuinely
  //    cheaper in the loop but still rasterises and writes EVERY canvas fragment,
  //    so its cost floor is the full framebuffer bandwidth — it cannot reach
  //    1/step^2 and it adds a branch to the shipped shader.
  //  * a mipmap / downsample of a full-resolution result. This is the trap the
  //    deliverable names: every pixel is rendered, so it is not refinement at all
  //    and it is no cheaper.
  //  * refining the ITERATION BUDGET (fewer iterations early) instead of the
  //    sample density. That is a different image, not a coarser one, and it would
  //    collide with D2's budget rule and the deep lane's correctness pins.
  // The measured level costs are in `window.__fv.lastGpuChain()` and the pins.
  renderPass(view, maxIter, colorSchemeIdx, fractalType, juliaParams, diag, sampleStep) {
    const gl = this.gl;
    if (!gl || this.destroyed || gl.isContextLost() || !this.program) return null;
    const step = Math.max(1, Math.floor(sampleStep || 1));
    if (step === 1) return this.draw(view, maxIter, colorSchemeIdx, fractalType, juliaParams, diag);
    const started = this._now();
    const w = Math.max(1, Math.ceil(this.canvas.width / step));
    const h = Math.max(1, Math.ceil(this.canvas.height / step));
    const target = this._ensureCoarseTarget(w, h);
    // If the offscreen target cannot be built, fall back to a FULL pass rather
    // than leaving the canvas stale — a slower frame is better than a wrong one.
    if (!target) return this.draw(view, maxIter, colorSchemeIdx, fractalType, juliaParams, diag);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    this._drawFractal(view, maxIter, colorSchemeIdx, fractalType, juliaParams, diag);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this._blit(target.tex);
    this._syncPass();
    this.lastDrawMs = this._now() - started;
    this.lastPassMs = this.lastDrawMs;
    this.lastPassStep = step;
    this.gpuPasses++;
    return { step: step, width: w, height: h, ms: this.lastDrawMs };
  }

  // The offscreen target for a coarse pass: ONE RGBA8 texture + FBO, reallocated
  // only when the requested size changes. Lazily created, and torn down with the
  // renderer, so a GPU→CPU toggle leaks nothing.
  _ensureCoarseTarget(w, h) {
    const gl = this.gl;
    if (!gl || !this.blitProgram) return null;
    if (!this._coarseTex) {
      this._coarseTex = gl.createTexture();
      this._coarseFbo = gl.createFramebuffer();
      this._coarseW = 0;
      this._coarseH = 0;
    }
    if (this._coarseW !== w || this._coarseH !== h) {
      gl.bindTexture(gl.TEXTURE_2D, this._coarseTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._coarseFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._coarseTex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        this._coarseW = 0;
        this._coarseH = 0;
        return null;
      }
      this._coarseW = w;
      this._coarseH = h;
    }
    return { fbo: this._coarseFbo, tex: this._coarseTex, width: w, height: h };
  }

  // Magnify the coarse texture over the whole canvas. The vertex shader is the ONE
  // shared quad VS, so `v_uv` maps the texture 1:1 onto clip space and the
  // orientation is identical to a direct draw. NEAREST: each coarse texel covers a
  // step x step block of canvas pixels exactly, which is what "coarser" means here.
  _blit(tex) {
    const gl = this.gl;
    if (!this.blitProgram) return;
    gl.useProgram(this.blitProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.blitU.src, 0);
    const posLoc = gl.getAttribLocation(this.blitProgram, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy() {
    // Idempotent: a context-loss event and an explicit teardown may both arrive,
    // and the live-renderer accounting must only be decremented once.
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.gl;
    // Release everything we allocated, then release the context itself. Without
    // this, every GPU→CPU toggle leaked a program, two shaders, a buffer and a
    // live GL context (the browser caps those, and the app degrades silently).
    if (gl && !gl.isContextLost()) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.vsh) gl.deleteShader(this.vsh);
      if (this.fsh) gl.deleteShader(this.fsh);
      // P1: the shallow lane is a SECOND program. When there is no float-texture
      // support the two lanes share one program, so a shared handle must not be
      // deleted twice.
      if (this.plainProgram && this.plainProgram !== this.program) gl.deleteProgram(this.plainProgram);
      if (this.plainVsh && this.plainVsh !== this.vsh) gl.deleteShader(this.plainVsh);
      if (this.plainFsh && this.plainFsh !== this.fsh) gl.deleteShader(this.plainFsh);
      // COARSE-TO-FINE: the present program and the offscreen target are per-
      // renderer state; without this a GPU→CPU toggle would leak them per toggle.
      if (this.blitProgram) gl.deleteProgram(this.blitProgram);
      if (this.blitVsh) gl.deleteShader(this.blitVsh);
      if (this.blitFsh) gl.deleteShader(this.blitFsh);
      if (this._coarseFbo) gl.deleteFramebuffer(this._coarseFbo);
      if (this._coarseTex) gl.deleteTexture(this._coarseTex);
      if (this.posBuf) gl.deleteBuffer(this.posBuf);
      // P1: the reference-orbit texture is per-renderer state; without this a
      // GPU→CPU toggle would leak one float texture per constructed renderer.
      if (this._orbitTex) gl.deleteTexture(this._orbitTex);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) {
        try { lose.loseContext(); } catch (_) { /* already gone */ }
      }
    }
    // P2: the orbit Worker is long-lived per renderer; a teardown must not leave
    // it running (S1's live-renderer accounting is about GPU resources, this is
    // the same discipline for the worker).
    if (this._orbitWorker) {
      try { this._orbitWorker.terminate(); } catch (_) { /* already gone */ }
      this._orbitWorker = null;
    }
    this.program = null;
    this.vsh = null;
    this.fsh = null;
    this.plainProgram = null;
    this.plainVsh = null;
    this.plainFsh = null;
    this.blitProgram = null;
    this.blitVsh = null;
    this.blitFsh = null;
    this.blitU = null;
    this._coarseTex = null;
    this._coarseFbo = null;
    this._coarseW = 0;
    this._coarseH = 0;
    this.posBuf = null;
    this._orbitTex = null;
    this._orbitKey = null;
    this._orbitW = 0;
    this._bigOrbit = null;
    this._bigOrbitPending = null;
    this.gl = null;
    trackLiveRenderer(-1);
  }
}
