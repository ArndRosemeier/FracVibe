// Colorful Fractal 3D Viewer using three.js (ESM import)
import * as THREE from './three.module.js';

function getColorForHeight(h) {
  // h in [0, max], map to a rainbow gradient
  // Blue (low) -> Green -> Yellow -> Red (high)
  const c = new THREE.Color();
  if (h < 0.2) {
    // Deep blue to cyan
    c.setRGB(0, h * 2, 1);
  } else if (h < 0.5) {
    // Cyan to green
    c.setRGB(0, 1, 1 - (h - 0.2) * 3.33);
  } else if (h < 0.8) {
    // Green to yellow
    c.setRGB((h - 0.5) * 3.33, 1, 0);
  } else {
    // Yellow to red/white
    c.setRGB(1, 1 - (h - 0.8) * 5, (h > 0.95) ? (h - 0.95) * 20 : 0);
  }
  return c;
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
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
    this.orbit.radius = 1.1 * Math.max(this.width, this.height);
    // Set initial camera position and target
    this.updateCamera();
    // Renderer
    this.renderer = new THREE.WebGLRenderer({antialias: true});
    this.renderer.setClearColor(0x222233);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // Heightmap
    const heights = await this.fractalEngine.calculateHeightmap(
      this.resolution,
      this.resolution,
      {...params, exaggeration: 0.07}
    );
    // Build mesh with vertex colors
    const geometry = new THREE.PlaneGeometry(
      this.width,
      this.height,
      this.resolution - 1,
      this.resolution - 1
    );
    // Compute min/max for normalization
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < heights.length; ++i) {
      if (heights[i] < minH) minH = heights[i];
      if (heights[i] > maxH) maxH = heights[i];
    }
    // Assign vertex colors
    const colors = [];
    for (let i = 0; i < geometry.attributes.position.count; ++i) {
      const h = (heights[i] - minH) / (maxH - minH + 1e-6);
      const color = getColorForHeight(h);
      colors.push(color.r, color.g, color.b);
      geometry.attributes.position.setZ(i, heights[i]);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      wireframe: false,
      metalness: 0.2,
      roughness: 0.7
    });
    this.terrain = new THREE.Mesh(geometry, material);
    this.terrain.rotation.x = -Math.PI / 2;
    this.scene.add(this.terrain);
    // Lighting
    const ambient = new THREE.AmbientLight(0x8888aa, 0.7);
    this.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(2, 5, 2);
    this.scene.add(dirLight);
    // Render loop
    this.animate();
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
  }

  onKeyUp(e) {
    if (e.code === 'KeyW') this.move.forward = false;
    if (e.code === 'KeyS') this.move.backward = false;
    if (e.code === 'KeyA') this.move.left = false;
    if (e.code === 'KeyD') this.move.right = false;
  }

  onResize() {
    if (!this.active) return;
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
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.terrain = null;
  }
}
