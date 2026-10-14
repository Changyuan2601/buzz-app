// Runs one Playwright shard that takes every Nth test in listing order.
// Playwright's --shard takes a contiguous range by test count. Costly spec
// files sit next to each other in path order, so one shard can get several of
// them. Taking every Nth test spreads each costly file and viewport matrix
// over all shards, with no recorded timings to maintain.
//
// Usage: node scripts/browser-shard.mjs <current>/<total> <playwright test args>
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || current < 1 || current > total)
    throw new Error(`shard must be <current>/<total>, got ${value}`);
  return { current, total };
}

// Test-list lines for each listed test, in Playwright's listing order.
export function testEntries(report) {
  if (report.errors?.length)
    throw new Error(report.errors.map((error) => error.message).join("\n"));
  const entries = [];
  const walk = (suite, specFile, titles) => {
    for (const spec of suite.specs ?? [])
      for (const entry of spec.tests) {
        const line = (file) => {
          const path = [`[${entry.projectName}]`, file, ...titles, spec.title];
          // The test-list format splits on this separator.
          if (path.some((part) => part.includes("›")))
            throw new Error(`test title contains "›": ${path.join(" › ")}`);
          return path.join(" › ");
        };
        // Playwright matches a test by the file that declares it, but loads
        // only listed spec files. A spec that imports its tests from another
        // module (workflows.spec.mjs) needs a line for each file.
        entries.push(
          spec.file === specFile
            ? [line(specFile)]
            : [line(spec.file), line(specFile)],
        );
      }
    for (const child of suite.suites ?? [])
      walk(child, specFile, [...titles, child.title]);
  };
  for (const suite of report.suites) walk(suite, suite.file, []);
  return entries;
}

export const select = (entries, { current, total }) =>
  entries.filter((_, index) => index % total === current - 1);

function main([shardArg, ...args]) {
  const shard = parseShard(shardArg);
  // The JSON reporter writes to this file when it is set; the list goes to stdout.
  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: "" };
  const listed = spawnSync(
    process.execPath,
    [cli, "test", ...args, "--list", "--reporter=json"],
    { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 },
  );
  if (listed.status !== 0) {
    process.stderr.write(listed.stdout + listed.stderr);
    throw new Error(`listing tests failed with status ${listed.status}`);
  }
  const selected = select(testEntries(JSON.parse(listed.stdout)), shard);
  // An empty shard would otherwise run every test.
  if (selected.length === 0)
    throw new Error(`shard ${shardArg} selects no tests`);
  const directory = mkdtempSync(join(tmpdir(), "browser-shard-"));
  try {
    const list = join(directory, "tests.txt");
    writeFileSync(list, `${selected.flat().join("\n")}\n`);
    const result = spawnSync(
      process.execPath,
      [cli, "test", ...args, "--test-list", list],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = main(process.argv.slice(2));
