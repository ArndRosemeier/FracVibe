// Minimal WebGL Fractal Renderer (Mandelbrot/Julia)
export class WebGLFractalRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl');
    if (!this.gl) throw new Error('WebGL not supported');
    this.program = null;
    this.uniforms = {};
    this.init();
  }

  init() {
    const vertSrc = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = (a_position + 1.0) * 0.5;
        gl_Position = vec4(a_position, 0, 1);
      }
    `;
    const fragSrc = `
      precision highp float;
      varying vec2 v_uv;
      uniform float u_centerX, u_centerY, u_scale, u_aspect;
      uniform int u_maxIter;
      uniform int u_type; // 0=mandelbrot, 1=julia
      uniform vec2 u_juliaC;
      void main() {
        float zx, zy, cx, cy;
        cx = u_centerX + (v_uv.x - 0.5) * u_scale * u_aspect;
        cy = u_centerY + (v_uv.y - 0.5) * u_scale;
        if (u_type == 0) { zx = 0.0; zy = 0.0; } // Mandelbrot
        else { zx = cx; zy = cy; cx = u_juliaC.x; cy = u_juliaC.y; } // Julia
        int iter = 0;
        for (int i = 0; i < 1024; ++i) {
          if (iter >= u_maxIter) break;
          float zx2 = zx*zx, zy2 = zy*zy;
          if (zx2 + zy2 > 4.0) break;
          float xt = zx2 - zy2 + cx;
          zy = 2.0*zx*zy + cy;
          zx = xt;
          iter++;
        }
        float t = float(iter) / float(u_maxIter);
        vec3 color = vec3(0.0);
        if (iter < u_maxIter) {
          color = vec3(0.5 + 0.5*cos(6.2831*t + vec3(0,2,4)), 0.7, 1.0-t);
        }
        gl_FragColor = vec4(color, 1.0);
      }
    `;
    const gl = this.gl;
    const vsh = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vsh, vertSrc); gl.compileShader(vsh);
    const fsh = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fsh, fragSrc); gl.compileShader(fsh);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vsh);
    gl.attachShader(this.program, fsh);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('Shader compile error: ' + gl.getProgramInfoLog(this.program));
    }
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
    // Uniforms
    this.uniforms.u_centerX = gl.getUniformLocation(this.program, 'u_centerX');
    this.uniforms.u_centerY = gl.getUniformLocation(this.program, 'u_centerY');
    this.uniforms.u_scale = gl.getUniformLocation(this.program, 'u_scale');
    this.uniforms.u_aspect = gl.getUniformLocation(this.program, 'u_aspect');
    this.uniforms.u_maxIter = gl.getUniformLocation(this.program, 'u_maxIter');
    this.uniforms.u_type = gl.getUniformLocation(this.program, 'u_type');
    this.uniforms.u_juliaC = gl.getUniformLocation(this.program, 'u_juliaC');
  }

  render(view, maxIter, type, juliaParams) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.u_centerX, view.centerX);
    gl.uniform1f(this.uniforms.u_centerY, view.centerY);
    gl.uniform1f(this.uniforms.u_scale, view.scale);
    gl.uniform1f(this.uniforms.u_aspect, this.canvas.width / this.canvas.height);
    gl.uniform1i(this.uniforms.u_maxIter, maxIter);
    gl.uniform1i(this.uniforms.u_type, type === 'mandelbrot' ? 0 : 1);
    let c = juliaParams && juliaParams.c ? juliaParams.c : [0,0];
    gl.uniform2f(this.uniforms.u_juliaC, c[0], c[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy() {
    // Cleanup if needed
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
