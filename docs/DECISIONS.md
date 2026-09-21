# FracVibe — decision ledger (append-only)

One row per decision. **Append-only**: a decision is history and history never
rots, so never edit another landing's row. Each row names its provenance and what
was rejected. Where the owner's words are on file they are quoted; where they are
not, the row says so rather than inventing an authority.

| # | Decision | Why / evidence | Rejected | Provenance |
|---|----------|----------------|----------|------------|
| 1 | **Make it work again before anything else.** Phase 0 = B1–B3 only. | The deployed app was a blank canvas: `Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')` at `app.js:181` aborted module evaluation, so no worker, no WebGL init, no render (`MODERNIZATION.md` §1 row 1). Nothing else was observable, let alone improvable. | Jumping to Phase 2 (Vite / TypeScript / `three` from npm), which would have modernised a blank page. | `MODERNIZATION.md` §5 step 1. The owner's verbatim words for this round are not on file. |
| 2 | **`public/` stays the publish dir; no build step yet.** | `netlify.toml` has `publish = "public"`, `command = ""`, and the app is already static ES modules. | Moving output to `dist/` now — it churns `netlify.toml` and every path for no behaviour change. Deferred to the Vite landing. | `MODERNIZATION.md` §4 "Delivery". |
| 3 | **Defer WebGPU, WASM/SIMD kernels and OffscreenCanvas.** | None fixes a current defect; each is a rewrite with its own risk, and would add unverified surface while B4–B8 are open. | Doing them as part of "modernization". | `MODERNIZATION.md` §5 "Explicitly deferred". |
| 4 | **One gate command: `bash scripts/gate.sh`, two tiers.** | A hand-rolled `npm test` cannot hold a host-wide lock, cannot distinguish "did not run" from "passed", and does not keep a raw log. `exit 2 = compile-only` exists so a syntax check can never be quoted as verification. | Calling `npm test` directly, and a single tier. A compile tier is a convenience here (the suite is ~6s), but it keeps "did the suite run?" explicit and answerable off-browser. | Dispatcher, `session-f6d26a74`, 2026-09-21. |
| 5 | **`reuseExistingServer: false`, and the gate refuses a busy `:3000`.** | With reuse on, a server left by a dev session or another worktree is reused, and a green suite silently reports on code the run never loaded — a wrong-tree verification with no symptom. | Leaving it `true` for convenience; or letting Playwright fail on the port, which would surface as RED ("the checks ran and failed") when in fact nothing ran. | Dispatcher, `session-f6d26a74`, 2026-09-21. Low risk, trivially reversible by the owner. |
