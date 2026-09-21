// colorSchemes.js — the palette functions now live in the ONE kernel,
// public/fractalKernel.js, because they are part of the app's single
// type/palette table (docs/DECISIONS.md row 16). This module exists only so
// existing ES-module consumers (`fractalViewer.js`, `fractal3d.js`) can keep
// importing `colorSchemes` by name: the kernel has no `export` statements, so
// the canonical value is read off the global it publishes.
import './fractalKernel.js';

export const colorSchemes = globalThis.FractalKernel.colorSchemes;
