// @ts-check
const { defineConfig } = require('@playwright/test');

// The suite drives the real app in a real browser. Chrome is used from the host
// (channel: 'chrome') so no ~150 MB browser download is needed; on a machine
// without Chrome, run `npx playwright install chromium` and drop the channel.
module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    channel: 'chrome',
    viewport: { width: 1000, height: 700 },
  },
  webServer: {
    command: 'node server/server.js',
    url: 'http://127.0.0.1:3000',
    // NEVER reuse a server this run did not start: one left behind by a dev
    // session or another worktree serves DIFFERENT files, so reuse would make a
    // green suite report on code the run never loaded. scripts/gate.sh refuses
    // on a busy :3000; this is the second line of the same defence.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
