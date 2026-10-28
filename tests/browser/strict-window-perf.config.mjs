import { defineConfig } from "@playwright/test";
import gate from "./playwright.config.mjs";
if (!process.env.PERF_RUN_DIR) throw new Error("Run strict-window-run.mjs");
export default defineConfig({
  testDir: "./perf",
  testMatch: "strict-window.perf.mjs",
  outputDir: `${process.env.PERF_RUN_DIR}/browser`,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["./perf/reporter.mjs"]],
  use: {
    ...gate.use,
    browserName: process.env.PERF_BROWSER,
    trace: "off",
    video: "off",
  },
});
