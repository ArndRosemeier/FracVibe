// Render splash text along a curve that follows the Mandelbrot set silhouette
function arcAboveFractal(t, canvasWidth, canvasHeight) {
  // t in [0,1], returns [x, y] in canvas coordinates
  // Arc: theta from pi to 0 (left to right, top half)
  const margin = 0.08 * canvasWidth;
  const radius = 0.28 * Math.min(canvasWidth, canvasHeight); // smaller arc
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2 - radius;

  const theta = Math.PI - t * Math.PI; // left to right, arc opens down (frown)
  const x = centerX + radius * Math.cos(theta);
  const y = centerY - radius * Math.sin(theta); // flip sign to make arc a frown
  return [x, y];
}


export function renderSplashMandelbrotCurve(text = 'Fract Vibe') {
  let overlay = document.getElementById('fractVibeSplashOverlay');
  if (!overlay) return;
  // Remove any previous canvas
  let old = document.getElementById('fractVibeSplashCurveCanvas');
  if (old) old.remove();
  // Create overlay canvas
  let canvas = document.createElement('canvas');
  canvas.id = 'fractVibeSplashCurveCanvas';
  overlay.appendChild(canvas);
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.pointerEvents = 'none';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.zIndex = '10';

  // Match the fractalCanvas size
  let mainCanvas = document.getElementById('fractalCanvas');
  let w = mainCanvas ? mainCanvas.width : window.innerWidth;
  let h = mainCanvas ? mainCanvas.height : window.innerHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Make text big
  const fontSize = Math.min(canvas.width, canvas.height) * 0.14;
  ctx.font = `bold ${fontSize}px Arial Black, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, fontSize * 0.08);
  ctx.strokeStyle = '#222';
  ctx.fillStyle = '#fff';

  // Place letters evenly along a half-circle arc above the fractal
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const [x, y] = arcAboveFractal(t, canvas.width, canvas.height);
    // Rotate each letter to follow the arc
    let angle = 0;
    if (i > 0 && i < n - 1) {
      const [xPrev, yPrev] = arcAboveFractal((i - 1) / (n - 1), canvas.width, canvas.height);
      const [xNext, yNext] = arcAboveFractal((i + 1) / (n - 1), canvas.width, canvas.height);
      angle = Math.atan2(yNext - yPrev, xNext - xPrev);
    }
    ctx.save();
    ctx.translate(x, y - fontSize/2); // vertically center the text on the arc
    ctx.rotate(angle);
    ctx.strokeText(text[i], 0, 0);
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
  }
}

window.addEventListener('resize', () => {
  if (document.getElementById('fractVibeSplashCurveCanvas')) {
    renderSplashMandelbrotCurve();
  }
});
