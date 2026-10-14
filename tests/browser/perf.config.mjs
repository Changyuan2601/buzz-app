import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import gate from "./playwright.config.mjs";

// Opt-in performance suite (docs/performance-harness.md): never part of the
// *.spec.mjs gate or CI. One run directory per invocation holds report.json
// and results/ (perf/ab.mjs sets it per side and iteration).
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
process.env.PERF_RUN_DIR ??= fileURLToPath(
  new URL(`../../test-results/perf-runs/${stamp}/`, import.meta.url),
);
const runDir = process.env.PERF_RUN_DIR;
if (!isAbsolute(runDir)) throw new Error("PERF_RUN_DIR must be absolute");

export default defineConfig({
  testDir: "./perf",
  testMatch: "*.perf.mjs",
  outputDir: join(runDir, "results"),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: join(runDir, "report.json") }]],
  use: {
    ...gate.use,
    trace: "off",
    screenshot: "off",
    video: "off",
    // No external host resolves; the corpus fixture records any attempt.
    launchOptions: {
      args: ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
