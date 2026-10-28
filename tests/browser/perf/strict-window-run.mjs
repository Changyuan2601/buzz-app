import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const root = fileURLToPath(new URL("../../../", import.meta.url));
try {
  const { values } = parseArgs({
    options: {
      browser: { type: "string", default: "chromium" },
      repeat: { type: "string", default: "5" },
      cpu: { type: "string", default: "4" },
      out: { type: "string" },
    },
  });
  const repeat = Number(values.repeat),
    cpu = Number(values.cpu);
  if (!["chromium", "webkit"].includes(values.browser))
    throw new Error("browser must be chromium or webkit");
  if (!Number.isSafeInteger(repeat) || repeat < 1)
    throw new Error("repeat must be a positive integer");
  if (
    !Number.isFinite(cpu) ||
    cpu < 1 ||
    (values.browser === "webkit" && cpu !== 1)
  )
    throw new Error("cpu must be >=1; WebKit supports only cpu1");
  const parent = resolve(root, "test-results/perf");
  mkdirSync(parent, { recursive: true });
  const runDir = mkdtempSync(`${parent}/strict-window-`);
  const out = resolve(values.out ?? `${runDir}/results.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({
      schemaVersion: 1,
      status: "running",
      evidenceDir: runDir,
    }),
  );
  const child = spawnSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve("@playwright/test/cli"),
      "test",
      "--config",
      "tests/browser/strict-window-perf.config.mjs",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        PERF_SCENARIO: "thread-open-strict-window",
        PERF_REPEAT: String(repeat),
        PERF_CPU: String(cpu),
        PERF_BROWSER: values.browser,
        PERF_RUN_DIR: runDir,
        PERF_OUT: out,
      },
    },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
  if (
    process.exitCode === 0 &&
    JSON.parse(readFileSync(out, "utf8")).status !== "passed"
  )
    throw new Error("No successful results file");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
