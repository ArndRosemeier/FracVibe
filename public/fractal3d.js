// Colorful Fractal 3D Viewer using three.js (ESM import)
import * as THREE from './three.module.js';
import { colorSchemes } from './colorSchemes.js';

function smoothHeightmap(heights, res) {
  const out = new Float32Array(heights.length);
  for (let y = 0; y < res; ++y) {
    for (let x = 0; x < res; ++x) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; ++dy) {
        for (let dx = -1; dx <= 1; ++dx) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < res && ny >= 0 && ny < res) {
            sum += heights[ny * res + nx];
            count++;
          }
        }
      }
      out[y * res + x] = sum / count;
    }
  }
  return out;
}

export class Fractal3DViewer {
  constructor(container, fractalEngine, getFractalParams) {
    this.container = container;
    this.fractalEngine = fractalEngine;
    this.getFractalParams = getFractalParams;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.terrain = null;
    this.active = false;
    this.resolution = 128;
    this.width = 2;
    this.height = 2;
    // Camera orbit state
    this.orbit = {
      theta: Math.PI / 4, // azimuthal angle
      phi: Math.PI / 3,   // polar angle
      radius: 1.1,        // distance from center (will be set in init)
      minRadius: 0.3,
      maxRadius: 5.0,
      dragging: false,
      lastX: 0,
      lastY: 0
    };
    // Camera movement state
    this.move = { forward: false, backward: false, left: false, right: false };
    this.cameraTarget = new THREE.Vector3(0, 0, 0);
    this.cameraPos = new THREE.Vector3();
    this.animate = this.animate.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.colorScheme = 'rainbow';
    this.colorOffset = 0;
    this.getColorForHeight = this.makeColorForHeightFn('rainbow');
    // --- S5/B8 split state ---
    // `heightmapCalls` counts every kernel evaluation this viewer performs. It is
    // exposed through `window.__fv.heightmapCalls` so "a colour change evaluates
    // nothing" is COUNTED, not inferred. `heightmap` / `heightMin` / `heightMax`
    // are the cached results a colour-only rewrite reuses, so the palette mapping
    // has exactly one implementation whether the mesh was just built or only
    // recoloured.
    this.heightmapCalls = 0;
    this.heightmap = null;
    this.heightMin = 0;
    this.heightMax = 0;
  }

  async init() {
    this.active = true;
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x222233);
    // Get fractal params and set mesh size
    const params = this.getFractalParams();
    const view = params.view;
    this.width = 2 / view.scale * (window.innerWidth / window.innerHeight);
    this.height = 2 / view.scale;
    // Camera
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
    this.orbit.radius = 1.1 * Math.max(this.width, this.height);
    this.updateCamera();
    // Renderer
    this.renderer = new THREE.WebGLRenderer({antialias: true});
    this.renderer.setClearColor(0x222233);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // Lighting
    const ambient = new THREE.AmbientLight(0x8888aa, 0.7);
    this.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(2, 5, 2);
    this.scene.add(dirLight);
    // Build mesh
    await this.regenerateMesh();
    // Render loop
    this.animate();
  }

  async changeResolution(delta) {
    const minRes = 16, maxRes = 4096; // Much higher max resolution
    let newRes = this.resolution;
    if (delta > 0) newRes = Math.min(maxRes, this.resolution * 2);
    if (delta < 0) newRes = Math.max(minRes, Math.floor(this.resolution / 2));
    if (newRes === this.resolution && delta !== 0) return;
    this.resolution = newRes;
    await this.regenerateMesh();
  }

  // The ONLY fractal evaluation in this file (S5/B8). Every heightmap is
  // computed here and counted, so a colour change can be PROVEN not to evaluate
  // the fractal. Called by `regenerateMesh` when the fractal parameters or the
  // resolution actually changed; never by a colour setter.
  async evaluateHeightmap() {
    this.heightmapCalls++;
    const params = this.getFractalParams();
    const heights = await this.fractalEngine.calculateHeightmap(
      this.resolution,
      this.resolution,
      {...params, exaggeration: 0.03}
    );
    return smoothHeightmap(heights, this.resolution);
  }

  // The SEPARATE half of the mesh work (S5/B8): rewrite the geometry's `color`
  // attribute from the CACHED heightmap and height range. It never calls the
  // kernel and never touches the position attribute, so a colour tick is O(n)
  // palette lookups instead of a resolution^2 fractal evaluation. Runs once at
  // the end of a rebuild and on every colour change.
  applyColors() {
    const geometry = this.terrain && this.terrain.geometry;
    const heights = this.heightmap;
    if (!geometry || !heights) return;
    const count = geometry.attributes.position.count;
    let attr = geometry.attributes.color;
    if (!attr || !attr.array || attr.array.length !== count * 3) {
      // Reuse the live buffer once it exists: replacing the attribute on every
      // colour tick would orphan its GL buffer each frame.
      attr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      geometry.setAttribute('color', attr);
    }
    const colors = attr.array;
    const minH = this.heightMin;
    const maxH = this.heightMax;
    for (let i = 0; i < count; ++i) {
      const h = (heights[i] - minH) / (maxH - minH + 1e-6);
      const color = this.getColorForHeight(h);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    attr.needsUpdate = true;
  }

  async regenerateMesh() {
    // Show progress bar (reuse logic from changeResolution)
    const progress = document.getElementById('fractal3d-progress');
    const bar = document.getElementById('fractal3d-progress-bar');
    if (progress && bar) {
      progress.style.display = 'block';
      bar.style.width = '30%';
      bar.style.transition = 'none';
      setTimeout(() => { bar.style.width = '90%'; bar.style.transition = 'width 1.5s linear'; }, 50);
    }
    await new Promise(requestAnimationFrame);
    if (!this.active) return; // exited while this rebuild was suspended
    // Remove old mesh
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
      this.terrain.material.dispose();
      this.terrain = null;
    }
    // The fractal is evaluated HERE and only here (S5/B8): a colour change must
    // never reach this method.
    const heights = await this.evaluateHeightmap();
    if (!this.active || !this.scene) return; // torn down during the evaluation
    this.heightmap = heights;
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < heights.length; ++i) {
      if (heights[i] < minH) minH = heights[i];
      if (heights[i] > maxH) maxH = heights[i];
    }
    this.heightMin = minH;
    this.heightMax = maxH;
    const geometry = new THREE.PlaneGeometry(
      this.width,
      this.height,
      this.resolution - 1,
      this.resolution - 1
    );
    for (let i = 0; i < geometry.attributes.position.count; ++i) {
      geometry.attributes.position.setZ(i, heights[i]);
    }
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      metalness: 0.2,
      roughness: 0.7
    });
    this.terrain = new THREE.Mesh(geometry, material);
    this.terrain.rotation.x = -Math.PI / 2;
    this.scene.add(this.terrain);
    // Colours come from the heightmap-free path, so a rebuild and a colour tick
    // share ONE implementation of the palette mapping.
    this.applyColors();
    // Hide progress bar
    if (progress && bar) {
      bar.style.width = '100%';
      setTimeout(() => { progress.style.display = 'none'; bar.style.width = '0'; }, 400);
    }
  }

  setColorScheme(scheme) {
    this.colorScheme = scheme;
    this.getColorForHeight = this.makeColorForHeightFn(scheme);
    // B8: rewrite the colour attribute only — never re-evaluate the fractal.
    if (this.active) this.applyColors();
  }

  setColorOffset(offset) {
    this.colorOffset = offset;
    // B8: rewrite the colour attribute only — never re-evaluate the fractal.
    if (this.active) this.applyColors();
  }

  updateCamera() {
    const { theta, phi, radius } = this.orbit;
    const offset = new THREE.Vector3(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
    );
    this.cameraPos.copy(this.cameraTarget).add(offset);
    this.camera.position.copy(this.cameraPos);
    this.camera.lookAt(this.cameraTarget);
  }

  onMouseDown(e) {
    if (e.button !== 0) return;
    this.orbit.dragging = true;
    this.orbit.lastX = e.clientX;
    this.orbit.lastY = e.clientY;
  }

  onMouseUp(e) {
    this.orbit.dragging = false;
  }

  onMouseMove(e) {
    if (!this.orbit.dragging) return;
    const dx = e.clientX - this.orbit.lastX;
    const dy = e.clientY - this.orbit.lastY;
    this.orbit.lastX = e.clientX;
    this.orbit.lastY = e.clientY;
    // Free-look: rotate direction vector from camera position
    // Calculate direction vector
    const dir = new THREE.Vector3();
    dir.subVectors(this.cameraTarget, this.cameraPos);
    // Convert to spherical
    const radius = dir.length();
    let theta = Math.atan2(dir.z, dir.x);
    let phi = Math.acos(dir.y / radius);
    // Adjust angles
    theta += dx * 0.01; // Inverted as before
    phi -= dy * 0.01;
    phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));
    // Convert back to Cartesian
    dir.x = radius * Math.sin(phi) * Math.cos(theta);
    dir.y = radius * Math.cos(phi);
    dir.z = radius * Math.sin(phi) * Math.sin(theta);
    // Update cameraTarget
    this.cameraTarget.copy(this.cameraPos).add(dir);
    this.camera.lookAt(this.cameraTarget);
  }

  onWheel(e) {
    e.preventDefault();
    let delta = e.deltaY > 0 ? 1.1 : 0.9;
    this.orbit.radius *= delta;
    this.orbit.radius = Math.max(this.orbit.minRadius, Math.min(this.orbit.maxRadius, this.orbit.radius));
    this.updateCamera();
  }

  onKeyDown(e) {
    if (e.repeat) return;
    if (e.code === 'KeyW') this.move.forward = true;
    if (e.code === 'KeyS') this.move.backward = true;
    if (e.code === 'KeyA') this.move.left = true;
    if (e.code === 'KeyD') this.move.right = true;
    // + increases, - decreases resolution
    if (e.key === '+' || e.key === '=') {
      this.changeResolution(1);
    }
    if (e.key === '-') {
      this.changeResolution(-1);
    }
  }

  onKeyUp(e) {
    if (e.code === 'KeyW') this.move.forward = false;
    if (e.code === 'KeyS') this.move.backward = false;
    if (e.code === 'KeyA') this.move.left = false;
    if (e.code === 'KeyD') this.move.right = false;
  }

  onResize() {
    if (!this.active || !this.renderer) return;
    // three.js keeps the drawing buffer at CSS size x pixelRatio; deviceScaleFactor
    // must be applied on every resize, not only at construction (S1/B4).
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  animate() {
    if (!this.active) return;
    // WASD movement (true 3D fly mode)
    const moveSpeed = 0.03 * this.orbit.radius;
    let forward = 0, right = 0;
    if (this.move.forward) forward += 1;
    if (this.move.backward) forward -= 1;
    if (this.move.right) right += 1;
    if (this.move.left) right -= 1;
    if (forward || right) {
      // Camera forward direction (from cameraPos to cameraTarget, normalized)
      const forwardDir = new THREE.Vector3();
      forwardDir.subVectors(this.cameraTarget, this.cameraPos).normalize();
      // Camera right direction (perpendicular to forward and up)
      const up = new THREE.Vector3(0, 1, 0);
      const rightDir = new THREE.Vector3();
      rightDir.crossVectors(forwardDir, up).normalize();
      // Move in 3D
      const moveVec = new THREE.Vector3();
      moveVec.addScaledVector(forwardDir, forward * moveSpeed);
      moveVec.addScaledVector(rightDir, right * moveSpeed);
      this.cameraPos.add(moveVec);
      this.cameraTarget.add(moveVec);
      this.camera.position.copy(this.cameraPos);
      this.camera.lookAt(this.cameraTarget);
    }
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.animate);
  }

  exit() {
    this.active = false;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    if (this.renderer && this.renderer.domElement) {
      this.renderer.domElement.removeEventListener('mousedown', this.onMouseDown);
      this.renderer.domElement.removeEventListener('wheel', this.onWheel);
      if (this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
    // Release the three.js renderer (programs, buffers and the GL context)
    // instead of leaking one on every enter/exit of 3D mode (S5). Guarded
    // because exit() also runs on a FAILED init, where the renderer may never
    // have been constructed.
    if (this.renderer && typeof this.renderer.dispose === 'function') {
      try { this.renderer.dispose(); } catch (_) { /* already unusable */ }
    }
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.terrain = null;
    this.heightmap = null;
    const progress = document.getElementById('fractal3d-progress');
    if (progress) progress.style.display = 'none';
  }

  makeColorForHeightFn(scheme) {
    const fn = colorSchemes[scheme] || colorSchemes.rainbow;
    const self = this;
    return function(h) {
      // h in [0,1] for normalized height
      let t = (h + (self.colorOffset || 0)) % 1;
      const rgb = fn(t);
      return { r: rgb[0]/255, g: rgb[1]/255, b: rgb[2]/255 };
    };
  }
}
