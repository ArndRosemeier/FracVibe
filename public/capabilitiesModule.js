// capabilitiesModule.js — the ES-module face of the capability detector.
//
// public/capabilities.js deliberately has NO `import` and NO `export` (the
// dual-consumption pattern, docs/DECISIONS.md row 14) so that ONE source serves a
// classic `<script src>`/`importScripts` load AND an ES-module side-effect import.
// This module exists only so an ES-module consumer can import the detector by NAME:
// the detector has no `export` statements, so the canonical value is read off the
// global it publishes. Same shape and same reason as public/colorSchemes.js (which
// does this for the kernel's palette table).
//
// Nothing in the shipped app imports this yet — wiring the ladder into the live
// dispatch is a LATER slice, deliberately (see docs/RENDERER-CONTRACT.md §6).
import './capabilities.js';

export const capabilities = globalThis.FractalCapabilities;
export const detectCapabilities = globalThis.FractalCapabilities.detect;
export const selectTier = globalThis.FractalCapabilities.selectTier;
export const WEBGPU_STATUS = globalThis.FractalCapabilities.WEBGPU_STATUS;
export default globalThis.FractalCapabilities;
