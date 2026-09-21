// The ONE kernel (iteration cap + type/palette tables). Imported for its side
// effect: it deliberately has no `export`, so both the classic worker and this ES
// module can load the same file (see public/fractalKernel.js and
// docs/DECISIONS.md row 14).
import './fractalKernel.js';
const FractalKernel = globalThis.FractalKernel;

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
          float dcx = (v_uv.x - 0.5) * u_scale * u_aspect;
          float dcy = ((1.0 - v_uv.y) - 0.5) * u_scale;
          float S = 1.0;                 // z = S*w, dc = S*d
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
        if (u_diag == 1) gl_FragColor = vec4(glitchLevel, 0.0, 0.0, 1.0);
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

  draw(view, maxIter, colorSchemeIdx, fractalType, juliaParams, diag) {
    const gl = this.gl;
    // Safe to call after destroy()/context loss: draw nothing rather than throw.
    if (!gl || this.destroyed || gl.isContextLost() || !this.program) return;
    if (gl.canvas && (gl.drawingBufferWidth !== this.canvas.width || gl.drawingBufferHeight !== this.canvas.height)) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    const cap = FractalKernel.clampMaxIter(maxIter);
    // P1: WHICH LANE. The reference orbit buys accuracy only past where the plain
    // float32 coordinate has already lost its pixels, and it costs a texture fetch
    // per iteration, so the deep lane starts at the SAME scale the shipped GPU zoom
    // cap already owns (`ITER_BUDGET_MIN_SCALE`, the one constant the D2 floor and
    // `app.js`'s WEBGL_MIN_SCALE are pinned equal to). Above that scale the plain
    // lane is byte-for-byte the pre-P1 shader, so shallow cost and shallow pixels
    // are unchanged — measured: keeping the deep lane always on doubled the whole
    // full-gate wall time (5.9m vs 2.9m), because the startup animation alone draws
    // ~60 full-window frames. The lane boundary is a depth boundary, not a
    // precision transition inside one zoom: nothing in the P1 pins sweeps across it.
    const deepLane = this.hasFloatTexture
      && view.scale < FractalKernel.ITER_BUDGET_MIN_SCALE
      && (diag === 1 || fractalType === FractalKernel.indexForType('mandelbrot'));
    // P1: the reference orbit is built/uploaded HERE, keyed on the view identity,
    // so a colour change, a resize or a repeated draw of the same view reuses it
    // (counted, not inferred).
    this.usePerturbation = deepLane;
    if (deepLane) {
      this.ensureReferenceOrbit(view.centerX, view.centerY, cap);
      this.usePerturbation = !!(this._orbitTex && this._orbitW > 0);
    }
    const program = this.usePerturbation ? this.program : this.plainProgram;
    gl.useProgram(program);
    // Uniform locations belong to the program that was just bound.
    const U = this.usePerturbation ? this.uPerturb : this.uPlain;
    gl.uniform1f(U.centerX, view.centerX);
    gl.uniform1f(U.centerY, view.centerY);
    gl.uniform1f(U.scale, view.scale);
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
  };

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
      if (this.posBuf) gl.deleteBuffer(this.posBuf);
      // P1: the reference-orbit texture is per-renderer state; without this a
      // GPU→CPU toggle would leak one float texture per constructed renderer.
      if (this._orbitTex) gl.deleteTexture(this._orbitTex);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) {
        try { lose.loseContext(); } catch (_) { /* already gone */ }
      }
    }
    this.program = null;
    this.vsh = null;
    this.fsh = null;
    this.plainProgram = null;
    this.plainVsh = null;
    this.plainFsh = null;
    this.posBuf = null;
    this._orbitTex = null;
    this._orbitKey = null;
    this._orbitW = 0;
    this.gl = null;
    trackLiveRenderer(-1);
  }
}
