import { enableCompileCache } from "node:module";
import { defineConfig } from "vitest/config";
import { fixtureAliases } from "./tests/relay-config.ts";
// Cache native compilation while each isolated worker still evaluates its modules.
// Avoid enabling the cache for raw V8 coverage.
if (!process.env.NODE_V8_COVERAGE) {
  const compileCache = enableCompileCache();
  if (compileCache.directory) {
    process.env.NODE_COMPILE_CACHE = compileCache.directory;
  }
}

const workerLimit = process.env.BUZZ_TEST_WORKERS;
const maxWorkers = workerLimit === undefined ? undefined : Number(workerLimit);
if (
  maxWorkers !== undefined &&
  (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1)
) {
  throw new Error("BUZZ_TEST_WORKERS must be a positive integer");
}
// The app formats dates and lists in the host's default locale, and tests
// assert en-US text. Workers read that default from the environment once, at
// startup, so pin it before they fork. C.UTF-8 resolves to en-US like CI's.
process.env.LC_ALL = "C.UTF-8";

export default defineConfig({
  define: {
    "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES":
      JSON.stringify(fixtureAliases),
  },
  test: {
    maxWorkers,
    include: [
      "src/**/*.test.{ts,tsx,mjs}",
      "browser-host/**/*.test.mjs",
      "scripts/**/*.test.{ts,mjs}",
      "tests/browser/perf/**/*.test.mjs",
      "tests/fixtures/design-system/**/*.test.{ts,tsx}",
    ],
  },
});
