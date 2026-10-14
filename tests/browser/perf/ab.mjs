#!/usr/bin/env node
// Interleaved A/B campaign (docs/performance-harness.md): runs the suite in
// two trees in ABBA order, each with its own copy of the harness, then
// compares the pairs (compare.mjs).
//   ab.mjs --base <tree> (--candidate <tree> | --sabotage <name>) --out <dir>
//          [--n 7] [--target "<scenario>/<variant> <metric>"] [-- <playwright args>]
// --sabotage builds a scratch worktree of the base (its commit plus its
// uncommitted changes) with one deliberate regression, each edit applied
// exactly once. Exit codes as compare.mjs: 0 keep, 1 revert, 2 invalid.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { compare, harnessHash, load, report } from "./compare.mjs";

const TIMELINE = "src/features/messages/ChannelTimeline.tsx";
const ROW = "src/features/messages/MessageRow.tsx";
/** Deliberate regressions each metric must detect: [file, find, replace]. */
export const SABOTAGE = {
  // No prepend anchoring: older pages push the view (history jumps fire).
  noShift: [
    [
      TIMELINE,
      "shift={prepend && !!handle.current?.viewportSize}",
      "shift={false}",
    ],
  ],
  buffer0: [[TIMELINE, "bufferSize={1600}", "bufferSize={0}"]],
  buffer6000: [[TIMELINE, "bufferSize={1600}", "bufferSize={6000}"]],
  // 5ms of main-thread work per message row render.
  slowRow: [
    [
      ROW,
      "function MessageRowContent({",
      "const perfBusy = () => { for (const end = performance.now() + 5; performance.now() < end; ); };\nfunction MessageRowContent({",
    ],
    [
      ROW,
      "  const reactions = row.reactions;",
      "  perfBusy();\n  const reactions = row.reactions;",
    ],
  ],
};

const invalid = (message) => {
  console.log(`INVALID ${message}`);
  process.exit(2);
};
// Any failure to set up, run or compare is an invalid campaign, not a revert.
process.on("uncaughtException", (error) => invalid(error.message));
const { values, positionals: args } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    ["base", "candidate", "sabotage", "out", "n", "target"].map((name) => [
      name,
      { type: "string" },
    ]),
  ),
});
const n = Number(values.n ?? 7);
if (
  !values.base ||
  !values.out ||
  !values.candidate === !values.sabotage ||
  (values.sabotage && !Object.hasOwn(SABOTAGE, values.sabotage)) ||
  !(n >= 5)
)
  invalid(
    `usage: ab.mjs --base <tree> (--candidate <tree> | --sabotage ${Object.keys(SABOTAGE).join("|")}) --out <dir> [--n 7, at least 5] [--target <key>] [-- <playwright args>]`,
  );
const [base, out] = [values.base, values.out].map((path) => resolve(path));
let candidate = values.candidate && resolve(values.candidate);
// Git hooks resolve the tree's pinned tools (bin/) first.
const env = {
  ...process.env,
  PATH: `${join(base, "bin")}:${process.env.PATH}`,
};
const git = (cwd, args, input) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env,
    input,
    maxBuffer: 1 << 30,
  });
// Run directories inside a tree would change its build identity.
for (const tree of [base, candidate].filter(Boolean))
  if (
    (out === tree || out.startsWith(`${tree}/`)) &&
    spawnSync("git", ["-C", tree, "check-ignore", "-q", out]).status !== 0
  )
    invalid(`--out lies inside ${tree} but is not ignored there`);
mkdirSync(out, { recursive: true });
if (values.sabotage) {
  candidate = join(out, `tree-${values.sabotage}`);
  if (existsSync(candidate))
    git(base, ["worktree", "remove", "--force", candidate]);
  git(base, ["worktree", "add", "--detach", candidate, "HEAD"]);
  process.on("exit", () => {
    try {
      git(base, ["worktree", "remove", "--force", candidate]);
    } catch (error) {
      console.log(`Could not remove ${candidate}: ${error.message}`);
    }
  });
  // An interrupted campaign exits (so the tree is removed) once its run returns.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => process.exit(130));
  // The base's uncommitted changes: staged and unstaged diffs, then untracked files.
  const diff = git(base, ["diff", "HEAD", "--binary"]);
  if (diff) git(candidate, ["apply", "--binary"], diff);
  const untracked = git(base, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  for (const file of untracked.split("\0").filter(Boolean)) {
    mkdirSync(dirname(join(candidate, file)), { recursive: true });
    copyFileSync(join(base, file), join(candidate, file));
  }
  for (const [file, find, replace] of SABOTAGE[values.sabotage]) {
    const text = readFileSync(join(candidate, file), "utf8");
    if (text.split(find).length !== 2)
      invalid(`${file} must contain exactly one ${JSON.stringify(find)}`);
    writeFileSync(join(candidate, file), text.replace(find, replace));
  }
  execFileSync(join(candidate, "scripts/bootstrap-worktree.sh"), [base], {
    stdio: "inherit",
    env,
  });
}
if (harnessHash(base) !== harnessHash(candidate))
  invalid(
    "the candidate changes harness paths (tests/browser, tests/fixtures)",
  );

const sides = { base: [], candidate: [] };
const exits = [];
// A failed invocation already makes the campaign invalid: stop there.
for (let i = 0; i < n && !exits.length; i++)
  for (const side of i % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
    const tree = side === "base" ? base : candidate;
    const dir = join(out, `${side}-${i}`);
    rmSync(dir, { recursive: true, force: true });
    const { status } = spawnSync(
      join(tree, "bin/pnpm"),
      ["test:perf", ...args],
      {
        cwd: tree,
        stdio: "inherit",
        env: { ...process.env, PERF_RUN_DIR: dir, PERF_ITERATION: String(i) },
      },
    );
    sides[side].push(dir);
    if (status !== 0) {
      exits.push(`failed: ${side}-${i} exited ${status}`);
      break;
    }
  }
const result = compare(load(sides.base), load(sides.candidate));
result.problems.unshift(...exits);
process.exitCode = report(result, values.target);
