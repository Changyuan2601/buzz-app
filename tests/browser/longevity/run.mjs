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
      repeat: { type: "string", default: "1" },
      cpu: { type: "string", default: "4" },
      out: { type: "string" },
    },
  });
  const repeat = Number(values.repeat);
  const cpu = Number(values.cpu);
  if (!Number.isSafeInteger(repeat) || repeat < 1)
    throw new Error("--repeat must be a positive integer");
  if (!Number.isFinite(cpu) || cpu < 1)
    throw new Error("--cpu must be at least 1");
  if (values.out !== undefined && !values.out.trim())
    throw new Error("--out must name a file");
  const parent = resolve(root, "test-results/perf");
  mkdirSync(parent, { recursive: true });
  const runDir = mkdtempSync(`${parent}/repeat-navigation-`);
  const out = resolve(values.out ?? `${runDir}/results.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ status: "running", evidenceDir: runDir })}\n`,
  );
  console.log(`Results: ${out}\nEvidence: ${runDir}`);
  const result = spawnSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve("@playwright/test/cli"),
      "test",
      "--config",
      "tests/browser/repeat-navigation.config.mjs",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        PERF_SCENARIO: "repeat-navigation",
        PERF_REPEAT: String(repeat),
        PERF_CPU: String(cpu),
        PERF_BROWSER: "chromium",
        PERF_RUN_DIR: runDir,
        PERF_OUT: out,
      },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0) {
    const data = JSON.parse(readFileSync(out, "utf8"));
    if (data.status !== "passed" || data.evidenceDir !== runDir)
      throw new Error("Missing successful results");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
