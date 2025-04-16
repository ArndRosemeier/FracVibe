// Render recursive/self-similar 'Fract Vibe' typography in the #fractVibeSplash div
// This draws the text, then recursively draws smaller versions inside each glyph

function drawRecursiveText(ctx, text, x, y, size, depth, maxDepth) {
  if (depth > maxDepth || size < 16) return;
  ctx.save();
  ctx.font = `bold ${size}px Arial Black, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, size * 0.08);
  ctx.strokeStyle = `rgba(60,60,60,0.8)`;
  ctx.fillStyle = `hsl(${(depth*60)%360},80%,${65-10*depth}%)`;
  // Draw main text
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);

  // Get text metrics for bounding box
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;
  const textHeight = size; // Approximate

  // Recursively draw smaller text inside each letter's bounding box
  if (depth < maxDepth) {
    const n = text.length;
    for (let i = 0; i < n; i++) {
      // Compute center for each character
      const char = text[i];
      const charX = x - textWidth/2 + metrics.actualBoundingBoxLeft + (i+0.5)*textWidth/n;
      const charY = y;
      // Shrink size and increase depth
      drawRecursiveText(ctx, char, charX, charY, size*0.35, depth+1, maxDepth);
    }
  }
  ctx.restore();
}

export function renderRecursiveFractVibeSplash() {
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
  // Draw recursive text
  drawRecursiveText(ctx, 'Fract Vibe', canvas.width/2, canvas.height/2, Math.min(canvas.width,canvas.height)*0.16, 0, 3);
}

// Optional: Call this on window resize to keep the splash responsive
window.addEventListener('resize', () => {
  if (document.getElementById('fractVibeSplashCanvas')) {
    renderRecursiveFractVibeSplash();
  }
});
