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

// Minimal WebGL Fractal Renderer (Mandelbrot/Julia)
export class WebGLFractalRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.vsh = null;
    this.fsh = null;
    this.posBuf = null;
    this.destroyed = false;
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
      ...FractalKernel.FRACTAL_TYPES.map((t) => '#define FT_' + t.glsl + ' ' + t.index),
      ...FractalKernel.COLOR_SCHEMES.map((s) => '#define CS_' + s.glsl + ' ' + s.index)
    ].join('\n') + '\n';
    const fragSrc = defines + `
      precision highp float;
      varying vec2 v_uv;
      uniform float u_centerX, u_centerY, u_scale, u_aspect;
      uniform int u_maxIter;
      uniform int u_colorScheme;
      uniform float u_colorOffset;
      uniform int u_fractalType;
      uniform float u_julia_cx;
      uniform float u_julia_cy;
      void main() {
        float x0 = u_centerX + (v_uv.x - 0.5) * u_scale * u_aspect;
        float y0 = u_centerY + ((1.0 - v_uv.y) - 0.5) * u_scale;
        float x, y;
        int iter = 0;
        if (u_fractalType == FT_JULIA) { // Julia
          x = x0;
          y = y0;
          for (int i = 0; i < MAX_ITER; i++) {
            if (iter >= u_maxIter) break;
            float xtemp = x * x - y * y + u_julia_cx;
            y = 2.0 * x * y + u_julia_cy;
            x = xtemp;
            if (x * x + y * y > 4.0) break;
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
            if (x * x + y * y > 4.0) break;
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
            if (x * x + y * y > 4.0) break;
            iter++;
          }
        } else { // FT_MANDELBROT
          x = 0.0;
          y = 0.0;
          for (int i = 0; i < MAX_ITER; i++) {
            if (iter >= u_maxIter) break;
            float xtemp = x * x - y * y + x0;
            y = 2.0 * x * y + y0;
            x = xtemp;
            if (x * x + y * y > 4.0) break;
            iter++;
          }
        }
        float t = float(iter) / float(u_maxIter);
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
        gl_FragColor = vec4(color, 1.0);
      }
    `;
    // Record what was ACTUALLY templated, so the suite can observe the shader's
    // loop bound rather than infer it from pixels (S3 pin 2). `shaderLoopBounds`
    // holds the bound token of every `for (int i = 0; i < ...; i++)` site: it must
    // read MAX_ITER at all four sites, and `shaderMaxIter` must equal the kernel's
    // single cap.
    const maxIterDefine = fragSrc.match(/#define MAX_ITER (\d+)/);
    this.shaderMaxIter = maxIterDefine ? Number(maxIterDefine[1]) : null;
    this.shaderLoopBounds = Array.from(
      fragSrc.matchAll(/for \(int i = 0; i < ([A-Za-z_][A-Za-z0-9_]*); i\+\+\)/g),
      (m) => m[1]
    );
    // Compile shaders with debug
    const vsh = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vsh, vertSrc);
    gl.compileShader(vsh);
    const vCompiled = gl.getShaderParameter(vsh, gl.COMPILE_STATUS);
    const vLog = gl.getShaderInfoLog(vsh);
    const fsh = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fsh, fragSrc);
    gl.compileShader(fsh);
    const fCompiled = gl.getShaderParameter(fsh, gl.COMPILE_STATUS);
    const fLog = gl.getShaderInfoLog(fsh);
    // Hold the handles so a partially-built renderer can still be torn down.
    this.vsh = vsh;
    this.fsh = fsh;
    if (!vCompiled || !fCompiled) {
      if (!vCompiled) console.error('[WebGL] vertex shader failed:', vLog);
      if (!fCompiled) console.error('[WebGL] fragment shader failed:', fLog);
      gl.deleteShader(vsh);
      gl.deleteShader(fsh);
      this.vsh = null;
      this.fsh = null;
      throw new Error(vCompiled ? 'Fragment shader failed: ' + fLog : 'Vertex shader failed: ' + vLog);
    }
    // Create program
    this.program = gl.createProgram();
    gl.attachShader(this.program, vsh);
    gl.attachShader(this.program, fsh);
    gl.linkProgram(this.program);
    const linked = gl.getProgramParameter(this.program, gl.LINK_STATUS);
    const linkLog = gl.getProgramInfoLog(this.program);
    if (!linked) {
      console.error('[WebGL] program link failed:', linkLog);
      gl.deleteProgram(this.program);
      gl.deleteShader(vsh);
      gl.deleteShader(fsh);
      this.program = null;
      this.vsh = null;
      this.fsh = null;
      throw new Error('Program link failed: ' + linkLog);
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
    // Uniform locations
    this.u_centerX = gl.getUniformLocation(this.program, 'u_centerX');
    this.u_centerY = gl.getUniformLocation(this.program, 'u_centerY');
    this.u_scale = gl.getUniformLocation(this.program, 'u_scale');
    this.u_aspect = gl.getUniformLocation(this.program, 'u_aspect');
    this.u_maxIter = gl.getUniformLocation(this.program, 'u_maxIter');
    this.u_colorScheme = gl.getUniformLocation(this.program, 'u_colorScheme');
    this.u_colorOffset = gl.getUniformLocation(this.program, 'u_colorOffset');
    this.u_fractalType = gl.getUniformLocation(this.program, 'u_fractalType');
    this.u_julia_cx = gl.getUniformLocation(this.program, 'u_julia_cx');
    this.u_julia_cy = gl.getUniformLocation(this.program, 'u_julia_cy');
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

  render(view, maxIter, colorSchemeIdx = 0, fractalType = 0, juliaParams = undefined) {
    const gl = this.gl;
    // Safe to call after destroy()/context loss: draw nothing rather than throw.
    if (!gl || this.destroyed || gl.isContextLost() || !this.program) return;
    if (gl.canvas && (gl.drawingBufferWidth !== this.canvas.width || gl.drawingBufferHeight !== this.canvas.height)) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    gl.useProgram(this.program);
    gl.uniform1f(this.u_centerX, view.centerX);
    gl.uniform1f(this.u_centerY, view.centerY);
    gl.uniform1f(this.u_scale, view.scale);
    gl.uniform1f(this.u_aspect, this.canvas.width / this.canvas.height);
    // The shader's loop bound is the constant MAX_ITER; clamping the uniform to the
    // same ONE constant is what makes `iter == u_maxIter` (the "inside" test) mean
    // the same thing on the GPU as it does in the kernel (S3/B5).
    gl.uniform1i(this.u_maxIter, FractalKernel.clampMaxIter(maxIter));
    gl.uniform1i(this.u_colorScheme, colorSchemeIdx);
    gl.uniform1f(this.u_colorOffset, this.colorOffset || 0);
    // Fractal type index comes from the kernel's FRACTAL_TYPES table (app.js
    // passes `FractalKernel.indexForType(...)`), never from a literal here.
    gl.uniform1i(this.u_fractalType, fractalType);
    if (fractalType === FractalKernel.indexForType('julia') && juliaParams && Array.isArray(juliaParams.c)) {
      gl.uniform1f(this.u_julia_cx, juliaParams.c[0]);
      gl.uniform1f(this.u_julia_cy, juliaParams.c[1]);
    } else {
      gl.uniform1f(this.u_julia_cx, 0.0);
      gl.uniform1f(this.u_julia_cy, 0.0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
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
      if (this.posBuf) gl.deleteBuffer(this.posBuf);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) {
        try { lose.loseContext(); } catch (_) { /* already gone */ }
      }
    }
    this.program = null;
    this.vsh = null;
    this.fsh = null;
    this.posBuf = null;
    this.gl = null;
    trackLiveRenderer(-1);
  }
}
