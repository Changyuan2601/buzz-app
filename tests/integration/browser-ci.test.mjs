import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { imageEngines } from "../../scripts/check-browser-image.mjs";
import ciConfig from "../browser/playwright.ci.config.mjs";
import config from "../browser/playwright.config.mjs";
import { run } from "../browser/run-command.mjs";

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/ci.yml");
// These guards intentionally follow this workflow's small, literal job matrix.
// Unsupported YAML shapes fail rather than silently selecting fewer jobs.
const job = (name) => {
  const body = workflow.match(
    new RegExp(`^ {2}${name}:\n([\\s\\S]*?)(?=^ {2}\\w+:|$(?![\\s\\S]))`, "m"),
  )?.[1];
  assert.ok(body, `${name} job must exist`);
  return body;
};
const browser = job("browser");
const matrixValues = (key) => {
  const values = browser.match(
    new RegExp(`^ {8}${key}: \\[([^\\]]+)\\]$`, "m"),
  )?.[1];
  assert.ok(values, `literal ${key} matrix must exist`);
  return values.split(",").map((value) => value.trim());
};

test("Linux shards and macOS recording discover every functional test/project exactly once", (t) => {
  const [selection, invocation] = parse(workflow)
    .jobs.browser.steps.find((step) => step.name === "Functional journeys")
    .run.trim()
    .split("\n");
  const selector = selection.match(
    /^files=\$\(\.\/bin\/node (scripts\/browser-shards\.mjs select .+)\)$/,
  )?.[1];
  const command = invocation.match(
    / -- (\.\/bin\/pnpm test:browser:ci .+) \$files$/,
  )?.[1];
  assert.ok(selector, "shard file selection must exist");
  assert.ok(command, "functional invocation must exist");
  const discover = (args) => {
    const report = JSON.parse(
      run("pnpm", ["--silent", ...args, "--list", "--reporter=json"]),
    );
    assert.deepEqual(report.errors, []);
    const collect = (suites) =>
      suites.flatMap((suite) => [
        ...suite.specs.flatMap((spec) =>
          spec.tests.map((entry) => {
            assert.ok(
              ["chromium", "webkit"].includes(entry.projectName),
              "no measurements on functional runners",
            );
            return `${entry.projectName}:${spec.id}`;
          }),
        ),
        ...collect(suite.suites ?? []),
      ]);
    return collect(report.suites);
  };
  const expected = discover([
    "test:browser",
    "--project",
    "chromium",
    "--project",
    "webkit",
    "--no-deps",
  ]);
  assert.ok(expected.length > 0);
  const actual = [];
  for (const engine of matrixValues("engine")) {
    for (const shard of matrixValues("shard")) {
      // Exercise the actual workflow commands, including the shard denominator.
      const expand = (text) =>
        text
          .replaceAll(/\$\{\{ matrix\.engine \}\}/g, engine)
          .replaceAll(/\$\{\{ matrix\.shard \}\}/g, shard)
          .split(/\s+/);
      const files = run("node", expand(selector)).split(/\s+/).filter(Boolean);
      const selected = discover([
        ...expand(command.replace(/^\.\/bin\/pnpm /, "")),
        ...files,
      ]);
      assert.ok(selected.length > 0, `${engine}/${shard} must select tests`);
      assert.ok(selected.every((id) => id.startsWith(`${engine}:`)));
      actual.push(...selected);
      t.diagnostic(`${engine}/${shard}: ${selected.length} functional tests`);
    }
  }
  const recording = parse(workflow).jobs.media_recorder.steps.find(
    (step) => step.name === "Recording journeys",
  );
  assert.equal(recording.if, undefined);
  assert.equal(recording["continue-on-error"], undefined);
  const recordingCommand = recording.run.match(
    / -- (\.\/bin\/pnpm test:browser .+)$/,
  )?.[1];
  assert.ok(recordingCommand, "macOS must execute the recording cases");
  const mac = discover(
    recordingCommand.replace(/^\.\/bin\/pnpm /, "").split(/\s+/),
  );
  assert.ok(mac.length > 0, "macOS recording must select tests");
  assert.ok(mac.every((id) => id.startsWith("webkit:")));
  actual.push(...mac);
  t.diagnostic(`macOS WebKit: ${mac.length} recording tests`);
  assert.equal(
    new Set(actual).size,
    actual.length,
    "no duplicate test/project across Linux shards and macOS",
  );
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    "Linux and macOS must cover full local functional discovery",
  );
});

test("classic-scrollbar cases run exactly once, after the measurements, without clearing their evidence", () => {
  const { steps } = parse(workflow).jobs.measurements;
  const serial = steps.findIndex(
    (step) => step.name === "Serial Chromium and WebKit measurements",
  );
  const classic = steps.find(
    (step) => step.name === "Chromium classic-scrollbar layout",
  );
  assert.ok(serial >= 0 && classic, "both Playwright steps must exist");
  assert.ok(steps.indexOf(classic) > serial, "classic cases run afterwards");
  assert.equal(classic.if, undefined);
  assert.equal(classic["continue-on-error"], undefined);
  const command = classic.run.match(
    /^\.\/bin\/node scripts\/ci-test-report\.mjs kind=playwright report=(\S+) evidence=(\S+) title="[^"]+" -- (\.\/bin\/pnpm test:browser:ci --project chromium-classic-scrollbars --no-deps --reporter=list,json)$/,
  );
  assert.ok(command, "classic step must report through ci-test-report");
  const [, report, evidence, invocation] = command;
  assert.equal(classic.env.PLAYWRIGHT_JSON_OUTPUT_FILE, report);
  // A Playwright run clears the outputDir of every project it selects. The
  // second run must therefore own a directory the measurement report and the
  // per-test evidence never live in, and the artifact must upload both. The
  // step runs the CI config, so resolve the project there and require the
  // local config to agree: a CI-only override of the launch arguments or the
  // output directory would otherwise pass this gate unnoticed.
  const classicProject = (candidate) =>
    candidate.name === "chromium-classic-scrollbars";
  const project = ciConfig.projects.find(classicProject);
  assert.ok(project, "chromium-classic-scrollbars project must exist in CI");
  assert.deepEqual(
    project,
    config.projects.find(classicProject),
    "CI must run the classic project exactly as the local gate defines it",
  );
  assert.equal(ciConfig.outputDir, config.outputDir);
  assert.equal(project.use.browserName, "chromium");
  assert.deepEqual(project.use.launchOptions.ignoreDefaultArgs, [
    "--hide-scrollbars",
  ]);
  const outputDir = (dir) => posix.normalize(posix.join("tests/browser", dir));
  const measurementDir = outputDir(ciConfig.outputDir);
  const classicDir = outputDir(project.outputDir);
  assert.notEqual(classicDir, measurementDir);
  assert.ok(!classicDir.startsWith(`${measurementDir}/`));
  assert.ok(!measurementDir.startsWith(`${classicDir}/`));
  assert.ok(
    steps[serial].env.PLAYWRIGHT_JSON_OUTPUT_FILE.startsWith(
      `${measurementDir}/`,
    ),
  );
  for (const path of [report, evidence])
    assert.ok(
      path.startsWith(`${classicDir}/`),
      `${path} stays in its own dir`,
    );
  const upload = steps.find((step) => step.name === "Measurement evidence");
  assert.deepEqual(
    upload.with.path
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .sort(),
    [measurementDir, classicDir].sort(),
  );
  // The tagged cases belong to this project alone: the engine shards above
  // exclude the tag, and this project selects nothing else.
  const list = (args) => {
    const listed = JSON.parse(
      run("pnpm", ["--silent", ...args, "--list", "--reporter=json"]),
    );
    assert.deepEqual(listed.errors, []);
    const collect = (suites) =>
      suites.flatMap((suite) => [
        ...(suite.specs ?? []),
        ...collect(suite.suites ?? []),
      ]);
    return collect(listed.suites);
  };
  const selected = list(invocation.replace(/^\.\/bin\/pnpm /, "").split(/\s+/));
  assert.ok(selected.length > 0, "the classic project must select tests");
  for (const spec of selected) {
    assert.ok(spec.tags.includes("classic-scrollbars"), spec.title);
    for (const entry of spec.tests)
      assert.equal(entry.projectName, "chromium-classic-scrollbars");
  }
  const functional = list([
    "test:browser:ci",
    "--project",
    "chromium",
    "--project",
    "webkit",
    "--no-deps",
  ]);
  assert.ok(functional.length > 0);
  for (const spec of functional)
    assert.ok(!spec.tags.includes("classic-scrollbars"), spec.title);
});

test("required gate executes its real shell and rejects every unsuccessful lane", () => {
  const required = job("required");
  const { jobs } = parse(workflow);
  assert.equal(
    jobs.required.name,
    `\${{ github.event_name == 'workflow_dispatch' && 'Automatic CI (not requested)' || 'CI required' }}`,
  );
  assert.equal(
    jobs.required.if,
    "always() && github.event_name != 'workflow_dispatch'",
  );
  assert.doesNotMatch(required, /^ {8}if:/m);
  assert.match(
    required,
    /^ {4}needs: \[javascript, native, measurements, browser_fixture, browser, media_recorder\]$/m,
  );
  assert.doesNotMatch(required, /continue-on-error/);
  const lanes = [
    "JAVASCRIPT",
    "NATIVE",
    "MEASUREMENTS",
    "FIXTURE",
    "BROWSER",
    "MEDIA_RECORDER",
  ];
  for (const lane of lanes)
    assert.ok(
      required.includes(
        `${lane}: \${{ needs.${lane === "FIXTURE" ? "browser_fixture" : lane.toLowerCase()}.result }}`,
      ),
    );
  const script = required.match(/^ {8}run: \|\n((?: {10}.+\n?)+)/m)?.[1];
  assert.ok(script, "required shell must exist");
  const execute = (results) =>
    spawnSync("bash", ["-e", "-c", script], {
      env: { PATH: process.env.PATH, ...results },
      encoding: "utf8",
      timeout: 5000,
    });
  const success = Object.fromEntries(lanes.map((lane) => [lane, "success"]));
  assert.equal(execute(success).status, 0);
  for (const lane of lanes) {
    for (const result of ["failure", "skipped", "cancelled", "", undefined]) {
      const results = { ...success, [lane]: result };
      if (result === undefined) delete results[lane];
      assert.equal(execute(results).status, 1, `${lane}=${result} must fail`);
    }
  }
});

test("image verification rejects version/image mismatch and never silently omits an engine", () => {
  const version = JSON.parse(read("package.json")).devDependencies[
    "@playwright/test"
  ];
  const info = {
    driverVersion: version,
    dockerImageName: `mcr.microsoft.com/playwright:v${version}-noble`,
  };
  assert.deepEqual(imageEngines(info, version, "all"), ["chromium", "webkit"]);
  for (const engine of ["chromium", "webkit"])
    assert.deepEqual(imageEngines(info, version, engine), [engine]);
  for (const engine of [
    "",
    "firefox",
    "chromium webkit",
    "chromium;echo unexpected",
  ])
    assert.throws(() => imageEngines(info, version, engine));
  for (const bad of [
    {},
    { ...info, driverVersion: "0.0.0" },
    { ...info, dockerImageName: "untrusted/image" },
  ])
    assert.throws(() => imageEngines(bad, version, "all"));
});

test("setup calls pinned entry points and fails before caching an empty pnpm path", (t) => {
  const { steps } = parse(read(".github/actions/setup/action.yml")).runs;
  const verify = steps.find(
    (step) => step.name === "Verify pinned tool entry points",
  );
  const store = steps.find((step) => step.id === "pnpm");
  assert.ok(steps.indexOf(verify) < steps.indexOf(store));
  assert.match(verify.run, /\.\/bin\/node --version/);
  assert.match(verify.run, /\.\/bin\/pnpm --version/);
  assert.doesNotMatch(
    read(".github/actions/setup/action.yml"),
    /GITHUB_PATH|HERMIT_PREPEND_PATH/,
  );
  const cwd = mkdtempSync(join(tmpdir(), "buzz-pnpm-path-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "bin"));
  writeFileSync(
    join(cwd, "bin", "pnpm"),
    '#!/bin/sh\n[ "$1 $2 $3" = "store path --silent" ] || exit 2\nprintf "%s" "$STORE"\nexit "$RESULT"\n',
    { mode: 0o755 },
  );
  const output = join(cwd, "output");
  const execute = (path, result = "0") => {
    writeFileSync(output, "");
    return spawnSync("bash", ["-eo", "pipefail", "-c", store.run], {
      cwd,
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        STORE: path,
        RESULT: result,
      },
      encoding: "utf8",
      timeout: 5000,
    });
  };
  assert.equal(execute("/pinned store").status, 0);
  assert.equal(readFileSync(output, "utf8"), "path=/pinned store\n");
  assert.notEqual(execute("").status, 0);
  assert.equal(readFileSync(output, "utf8"), "");
  assert.equal(execute("", "7").status, 7);
  assert.equal(readFileSync(output, "utf8"), "");
});
