// Duration-balanced browser journey shards. Playwright's --shard splits files
// by test count in path order, so costly neighbours (navigation-*, nested-replies)
// share one shard. This assigns whole files by their recorded per-engine cost.
// `select` prints one shard's files; `weights` refreshes the recorded costs
// from CI Playwright JSON reports (the browser-journeys-* evidence artifacts).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwrightSpecs } from "./ci-test-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const weightsFile = `${root}tests/browser/shard-weights.json`;

// Tests per spec file in a Playwright JSON report or listing. Top-level suites
// are spec files; their tests may be declared in an imported journey module.
const testsPerFile = (report) =>
  new Map(
    report.suites.map((suite) => [
      suite.file,
      playwrightSpecs([suite]).flatMap((spec) => spec.tests ?? []),
    ]),
  );

// Greedy longest-first assignment to the least-loaded shard. Files without a
// recorded cost are estimated from their test count at the median known rate.
export function assign(files, weights, total) {
  const rates = files
    .filter(({ file }) => weights[file] !== undefined)
    .map(({ file, tests }) => weights[file] / tests)
    .sort((a, b) => a - b);
  const rate = rates[Math.floor(rates.length / 2)] ?? 1;
  const cost = ({ file, tests }) => weights[file] ?? tests * rate;
  const shards = Array.from({ length: total }, () => ({ cost: 0, files: [] }));
  for (const file of [...files].sort(
    (a, b) => cost(b) - cost(a) || a.file.localeCompare(b.file),
  )) {
    const shard = shards.reduce((min, next) =>
      next.cost < min.cost ? next : min,
    );
    shard.files.push(file.file);
    shard.cost += cost(file);
  }
  return shards.map((shard) => shard.files.sort());
}

// Seconds of summed test execution per file, by project.
export function weightsFrom(reports) {
  const weights = {};
  for (const report of reports)
    for (const [file, entries] of testsPerFile(report))
      for (const entry of entries) {
        weights[entry.projectName] ??= {};
        const project = weights[entry.projectName];
        const seconds = (entry.results ?? []).reduce(
          (sum, result) => sum + result.duration / 1000,
          0,
        );
        project[file] = (project[file] ?? 0) + seconds;
      }
  for (const project of Object.values(weights))
    for (const file of Object.keys(project))
      project[file] = Math.max(1, Math.round(project[file]));
  return Object.fromEntries(
    Object.keys(weights)
      .sort()
      .map((project) => [
        project,
        Object.fromEntries(Object.entries(weights[project]).sort()),
      ]),
  );
}

// Files and test counts exactly as the CI engine project selects them.
function list(project) {
  const env = { ...process.env };
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  const result = spawnSync(
    `${root}bin/pnpm`,
    [
      "--silent",
      "test:browser:ci",
      "--project",
      project,
      "--no-deps",
      "--list",
      "--reporter=json",
    ],
    { cwd: root, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout);
  if (result.status !== 0 || report.errors.length)
    throw new Error(
      `playwright --list: ${report.errors.map((error) => error.message).join("\n")}`,
    );
  return [...testsPerFile(report)].map(([file, tests]) => ({
    file,
    tests: tests.length,
  }));
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "select" && args.length === 3) {
    const [project, current, total] = [
      args[0],
      Number(args[1]),
      Number(args[2]),
    ];
    if (Number.isInteger(total) && current >= 1 && current <= total) {
      const weights =
        JSON.parse(readFileSync(weightsFile, "utf8"))[project] ?? {};
      const files = assign(list(project), weights, total)[current - 1];
      // An empty filter list would run every file, so refuse it.
      if (!files.length)
        throw new Error(`shard ${current}/${total} has no files`);
      process.stdout.write(
        files.map((file) => `tests/browser/${file}\n`).join(""),
      );
      return;
    }
  }
  if (command === "weights" && args.length > 0) {
    const reports = args.map((path) => JSON.parse(readFileSync(path, "utf8")));
    writeFileSync(
      weightsFile,
      `${JSON.stringify(weightsFrom(reports), null, 2)}\n`,
    );
    return;
  }
  throw new Error(
    "usage: browser-shards select <project> <shard> <total> | weights <playwright-report.json…>",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
