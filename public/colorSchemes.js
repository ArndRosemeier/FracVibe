// colorSchemes.js - Shared color palettes for 2D/3D fractal rendering

// t in [0,1], returns [r,g,b] (0-255)
function rainbow(t) {
  const a = (1 - t) * 4;
  const X = Math.floor(a);
  const Y = Math.floor(255 * (a - X));
  switch (X) {
    case 0: return [0, Y, 255]; // blue->cyan
    case 1: return [0, 255, 255-Y]; // cyan->green
    case 2: return [Y, 255, 0]; // green->yellow
    case 3: return [255, 255-Y, 0]; // yellow->red
    default: return [255, 0, 0];
  }
}

function fire(t) {
  // Black -> red -> yellow -> white
  if (t < 0.33) return [Math.floor(255 * t * 3), 0, 0];
  if (t < 0.66) return [255, Math.floor(255 * (t - 0.33) * 3), 0];
  return [255, 255, Math.floor(255 * (t - 0.66) * 3)];
}

function ocean(t) {
  // Deep blue -> cyan -> white
  if (t < 0.5) return [0, Math.floor(255 * t * 2), Math.floor(128 + 127 * t * 2)];
  return [Math.floor(255 * (t - 0.5) * 2), 255, 255];
}

function grayscale(t) {
  const g = Math.floor(255 * t);
  return [g, g, g];
}

function viridis(t) {
  // Approximate viridis colormap
  const stops = [
    [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142],
    [33, 144, 141], [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37]
  ];
  const idx = Math.floor(t * (stops.length - 1));
  const frac = t * (stops.length - 1) - idx;
  if (idx >= stops.length - 1) return stops[stops.length - 1];
  const c0 = stops[idx], c1 = stops[idx + 1];
  return [
    Math.floor(c0[0] + (c1[0] - c0[0]) * frac),
    Math.floor(c0[1] + (c1[1] - c0[1]) * frac),
    Math.floor(c0[2] + (c1[2] - c0[2]) * frac)
  ];
}

export const colorSchemes = {
  rainbow,
  fire,
  ocean,
  grayscale,
  viridis
};
