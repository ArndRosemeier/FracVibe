// Minimal WebGL Fractal Renderer (Mandelbrot/Julia)
export class WebGLFractalRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    if (!canvas) {
      console.error('[WebGL] ERROR: Canvas is null or undefined!');
      throw new Error('WebGL initialization failed: canvas is null or undefined');
    }
    if (!canvas.parentNode) {
      console.error('[WebGL] ERROR: Canvas has no parentNode (not attached to DOM)!', canvas);
      throw new Error('WebGL initialization failed: canvas not attached to DOM');
    }
    // Use the minimal working context creation
    this.gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!this.gl) {
      console.error('[WebGL] getContext failed. Canvas:', canvas, 'Parent:', canvas.parentNode);
      throw new Error('WebGL context creation failed');
    }
    this.initFractalShader();
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
    // Fragment shader with dynamic color palette
    const fragSrc = `
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
        if (u_fractalType == 1) { // Julia
          x = x0;
          y = y0;
          for (int i = 0; i < 1024; i++) {
            if (iter >= u_maxIter) break;
            float xtemp = x * x - y * y + u_julia_cx;
            y = 2.0 * x * y + u_julia_cy;
            x = xtemp;
            if (x * x + y * y > 4.0) break;
            iter++;
          }
        } else if (u_fractalType == 2) { // Burning Ship
          x = 0.0;
          y = 0.0;
          for (int i = 0; i < 1024; i++) {
            if (iter >= u_maxIter) break;
            float xtemp = x * x - y * y + x0;
            y = abs(2.0 * x * y) + y0;
            x = abs(xtemp);
            if (x * x + y * y > 4.0) break;
            iter++;
          }
        } else if (u_fractalType == 3) { // Tricorn
          x = 0.0;
          y = 0.0;
          for (int i = 0; i < 1024; i++) {
            if (iter >= u_maxIter) break;
            float xtemp = x * x - y * y + x0;
            y = -2.0 * x * y + y0;
            x = xtemp;
            if (x * x + y * y > 4.0) break;
            iter++;
          }
        } else { // Mandelbrot
          x = 0.0;
          y = 0.0;
          for (int i = 0; i < 1024; i++) {
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
        } else if (u_colorScheme == 0) {
          // Rainbow
          float a = (1.0 - t) * 4.0;
          int X = int(floor(a));
          float Y = 255.0 * (a - float(X));
          if (X == 0) color = vec3(0.0, Y/255.0, 1.0); // blue->cyan
          else if (X == 1) color = vec3(0.0, 1.0, (255.0-Y)/255.0); // cyan->green
          else if (X == 2) color = vec3(Y/255.0, 1.0, 0.0); // green->yellow
          else if (X == 3) color = vec3(1.0, (255.0-Y)/255.0, 0.0); // yellow->red
          else color = vec3(1.0, 0.0, 0.0);
        } else if (u_colorScheme == 1) {
          // Fire
          if (t < 0.33) color = vec3(3.0*t, 0.0, 0.0);
          else if (t < 0.66) color = vec3(1.0, 3.0*(t-0.33), 0.0);
          else color = vec3(1.0, 1.0, 3.0*(t-0.66));
        } else if (u_colorScheme == 2) {
          // Ocean
          if (t < 0.5) color = vec3(0.0, 2.0*t, 0.50196+0.49804*2.0*t);
          else color = vec3(2.0*(t-0.5), 1.0, 1.0);
        } else if (u_colorScheme == 3) {
          // Grayscale
          color = vec3(t, t, t);
        } else if (u_colorScheme == 4) {
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
    // Compile shaders with debug
    const vsh = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vsh, vertSrc);
    gl.compileShader(vsh);
    const vCompiled = gl.getShaderParameter(vsh, gl.COMPILE_STATUS);
    const vLog = gl.getShaderInfoLog(vsh);
    if (!vCompiled) throw new Error('Vertex shader failed: ' + vLog);
    const fsh = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fsh, fragSrc);
    gl.compileShader(fsh);
    const fCompiled = gl.getShaderParameter(fsh, gl.COMPILE_STATUS);
    const fLog = gl.getShaderInfoLog(fsh);
    if (!fCompiled) throw new Error('Fragment shader failed: ' + fLog);
    // Create program
    this.program = gl.createProgram();
    gl.attachShader(this.program, vsh);
    gl.attachShader(this.program, fsh);
    gl.linkProgram(this.program);
    const linked = gl.getProgramParameter(this.program, gl.LINK_STATUS);
    const linkLog = gl.getProgramInfoLog(this.program);
    if (!linked) throw new Error('Program link failed: ' + linkLog);
    gl.useProgram(this.program);
    // Fullscreen quad
    const posBuf = gl.createBuffer();
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

  render(view, maxIter, colorSchemeIdx = 0, fractalType = 0, juliaParams = undefined) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.uniform1f(this.u_centerX, view.centerX);
    gl.uniform1f(this.u_centerY, view.centerY);
    gl.uniform1f(this.u_scale, view.scale);
    gl.uniform1f(this.u_aspect, this.canvas.width / this.canvas.height);
    gl.uniform1i(this.u_maxIter, maxIter);
    gl.uniform1i(this.u_colorScheme, colorSchemeIdx);
    gl.uniform1f(this.u_colorOffset, this.colorOffset || 0);
    // Fractal type: 0=mandelbrot, 1=julia, 2=burningship, 3=tricorn
    gl.uniform1i(this.u_fractalType, fractalType);
    if (fractalType === 1 && juliaParams && Array.isArray(juliaParams.c)) {
      gl.uniform1f(this.u_julia_cx, juliaParams.c[0]);
      gl.uniform1f(this.u_julia_cy, juliaParams.c[1]);
    } else {
      gl.uniform1f(this.u_julia_cx, 0.0);
      gl.uniform1f(this.u_julia_cy, 0.0);
    }
    // Debug log
    console.log('[WebGL] render: fractalType', fractalType, 'juliaParams', juliaParams);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  destroy() {
    // No longer forcibly lose the context! Just null out the reference.
    this.gl = null;
  }
}
