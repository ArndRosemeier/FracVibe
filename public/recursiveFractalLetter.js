// Render each letter as recursively composed of smaller versions of itself
function drawRecursiveLetter(ctx, letter, x, y, size, depth, maxDepth) {
  if (depth > maxDepth || size < 10) return;
  ctx.save();
  ctx.font = `bold ${size}px Arial Black, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.strokeStyle = `rgba(60,60,60,0.8)`;
  ctx.fillStyle = `hsl(${(depth*80)%360},80%,${65-10*depth}%)`;
  // Draw main letter
  ctx.strokeText(letter, x, y);
  ctx.fillText(letter, x, y);

  // Get text metrics for bounding box
  const metrics = ctx.measureText(letter);
  const width = metrics.width;
  const height = size; // Approximate

  // Recursively draw smaller letters inside the main letter's bounding box
  if (depth < maxDepth) {
    // Arrange smaller letters in a grid inside the bounding box
    const grid = 3;
    const subSize = size / grid;
    for (let gx = 0; gx < grid; gx++) {
      for (let gy = 0; gy < grid; gy++) {
        // Skip center cell so the recursion is hollow
        if (gx === 1 && gy === 1) continue;
        const subX = x - width/2 + (gx+0.5)*width/grid;
        const subY = y - height/2 + (gy+0.5)*height/grid;
        drawRecursiveLetter(ctx, letter, subX, subY, subSize, depth+1, maxDepth);
      }
    }
  }
  ctx.restore();
}

export function renderRecursiveFractVibeLetters(text = 'Fract Vibe', maxDepth = 3) {
  let splash = document.getElementById('fractVibeSplash');
  // Create overlay canvas
  let canvas = document.getElementById('fractVibeSplashCanvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'fractVibeSplashCanvas';
    splash.appendChild(canvas);
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '2';
  }
  // Set canvas size
  canvas.width = splash.offsetWidth;
  canvas.height = splash.offsetHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Draw each letter recursively, spaced evenly
  const n = text.length;
  const totalWidth = n * Math.min(canvas.width,canvas.height)*0.11;
  let x = (canvas.width - totalWidth) / 2 + Math.min(canvas.width,canvas.height)*0.055;
  let y = canvas.height/2;
  for (let i = 0; i < n; i++) {
    if (text[i] === ' ') {
      x += Math.min(canvas.width,canvas.height)*0.11;
      continue;
    }
    drawRecursiveLetter(ctx, text[i], x, y, Math.min(canvas.width,canvas.height)*0.11, 0, maxDepth);
    x += Math.min(canvas.width,canvas.height)*0.11;
  }
}

// Optional: Call this on window resize to keep the splash responsive
window.addEventListener('resize', () => {
  if (document.getElementById('fractVibeSplashCanvas')) {
    renderRecursiveFractVibeLetters();
  }
});
