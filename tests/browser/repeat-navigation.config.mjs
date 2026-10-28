import { defineConfig } from "@playwright/test";
import gate from "./playwright.config.mjs";

if (!process.env.PERF_RUN_DIR) throw new Error("Run longevity/run.mjs");
export default defineConfig({
  testDir: "./longevity",
  testMatch: "repeat-navigation.perf.mjs",
  outputDir: `${process.env.PERF_RUN_DIR}/browser`,
  workers: 1,
  retries: 0,
  // 100 cycles each complete seven pointer actions and three reversible edits.
  // The bound covers the entire session; individual action/settle limits stay unchanged.
  timeout: 20 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["./perf/reporter.mjs"]],
  use: { ...gate.use, browserName: "chromium", trace: "off", video: "off" },
});
