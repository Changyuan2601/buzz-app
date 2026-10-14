#!/usr/bin/env node
// Comparison of perf runs (docs/performance-harness.md): a verdict per tiered
// metric over paired iterations, and keep or revert on one declared target.
//   compare.mjs <base-run,...> <candidate-run,...> [--target "<scenario>/<variant> <metric>"]
// Exit 0: comparable (with --target: keep); 1: revert; 2: invalid.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
/** Hash of the named files (relative to `root`) in order. */
const digest = (root, files, hash = createHash("sha256")) => {
  for (const file of files)
    hash.update(`${file}\0`).update(readFileSync(join(root, file)));
  return hash.digest("hex");
};

/** Harness identity: every non-spec file git sees under tests/browser and
 * tests/fixtures, and the relay config. Sides measured by different harness
 * code are not comparable. */
export function harnessHash(root) {
  const files = git(
    root,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "tests/browser",
    "tests/fixtures",
    "tests/relay-config.ts",
  )
    .split("\0")
    .filter((f) => f && !/\.spec\./.test(f) && existsSync(join(root, f)));
  return digest(root, files.sort()).slice(0, 12);
}

/** Build identity: the commit plus a hash of uncommitted changes. */
export function buildIdentity(root) {
  const head = git(root, "rev-parse", "--short=12", "HEAD").trim();
  if (!git(root, "status", "--porcelain").trim()) return head;
  const untracked = git(
    root,
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  );
  const diff = createHash("sha256").update(
    git(root, "diff", "HEAD", "--binary"),
  );
  return `${head}+${digest(root, untracked.split("\0").filter(Boolean).sort(), diff).slice(0, 8)}`;
}

export const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Exact one-sided p-values of the Wilcoxon signed-rank test on paired
 * differences: `lower` that candidates are lower, `upper` that they are higher.
 * Zero differences drop out; ties take average ranks. */
export function signedRank(diffs) {
  const d = diffs.filter((v) => Math.abs(v) > 1e-9);
  const order = d.map((v, i) => [Math.abs(v), i]).sort((a, b) => a[0] - b[0]);
  const rank = []; // doubled, so average ranks stay integers
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) rank[order[k][1]] = i + j + 2;
    i = j + 1;
  }
  let dist = [1];
  for (const r of rank) {
    const next = Array(dist.length + r).fill(0);
    for (const [s, c] of dist.entries()) {
      next[s] += c;
      next[s + r] += c;
    }
    dist = next;
  }
  const w = d.reduce((sum, v, i) => sum + (v > 0 ? rank[i] : 0), 0);
  const tail = (keep) =>
    dist.reduce((sum, c, s) => sum + (keep(s) ? c : 0), 0) / 2 ** d.length;
  return { lower: tail((s) => s <= w), upper: tail((s) => s >= w) };
}

/** Exact one-sided Fisher p-values for k1/n1 (base) vs k2/n2 (candidate):
 * `lower` that the candidate's rate is lower, `upper` that it is higher. */
export function fisher(k1, n1, k2, n2) {
  const lc = (n, k) => {
    let v = 0;
    for (let i = 1; i <= k; i++) v += Math.log((n - k + i) / i);
    return v;
  };
  const p = (k) =>
    Math.exp(lc(n1, k) + lc(n2, k1 + k2 - k) - lc(n1 + n2, k1 + k2));
  // p(k): k of the hits fall on the base side.
  const tail = (keep) => {
    let sum = 0;
    for (let k = Math.max(0, k1 + k2 - n2); k <= Math.min(n1, k1 + k2); k++)
      if (keep(k)) sum += p(k);
    return Math.min(1, sum);
  };
  return { lower: tail((k) => k >= k1), upper: tail((k) => k <= k1) };
}

/** Passed iterations and every failure of the run directories (each holds
 * Playwright's report.json); a missing report or a test that did not pass is a failure. */
export function load(dirs) {
  const iterations = [];
  const failures = [];
  const visit = (suite, dir) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        for (const result of test.results ?? []) {
          if (result.status !== "passed") {
            failures.push(`${dir}: ${spec.title}: ${result.status}`);
            continue;
          }
          const body = result.attachments?.find(
            (a) => a.name === "browser-evidence",
          )?.body;
          const found = body
            ? JSON.parse(Buffer.from(body, "base64")).measurements.filter(
                (m) => m.perf,
              )
            : [];
          if (!found.length) failures.push(`${dir}: ${spec.title}: no result`);
          iterations.push(...found);
        }
    for (const child of suite.suites ?? []) visit(child, dir);
  };
  for (const dir of dirs) {
    const file = join(dir, "report.json");
    if (!existsSync(file)) {
      failures.push(`${dir}: no report.json`);
      continue;
    }
    const report = JSON.parse(readFileSync(file, "utf8"));
    for (const error of report.errors ?? [])
      failures.push(`${dir}: ${error.message?.split("\n")[0]}`);
    const before = iterations.length + failures.length;
    visit(report, dir);
    if (iterations.length + failures.length === before)
      failures.push(`${dir}: no tests ran`);
  }
  return { iterations, failures };
}

const TIERS = ["targets", "defects", "guards", "work"];
const unit = (name) =>
  /Ms$/.test(name) ? "ms" : /Px$/.test(name) ? "px" : "count";
/** The smallest shift that matters: the larger of a frame at 60Hz (16.7ms)
 * and 5% of the base median; 2px; one count. */
const practical = (name, center) =>
  unit(name) === "ms"
    ? Math.max(16.7, Math.abs(center) * 0.05)
    : unit(name) === "px"
      ? 2
      : 1;
const present = (name, value) => value > (unit(name) === "px" ? 0.5 : 0);

/** Direction of a paired shift (-1 lower, 1 higher, 0 none): one-sided exact
 * p ≤ 0.05 (with 5 pairs, all 5 agree) and a median difference that matters. */
function direction(name, base, candidate) {
  const diffs = candidate.map((v, i) => v - base[i]);
  const { lower, upper } = signedRank(diffs);
  const estimate = median(diffs);
  if (Math.abs(estimate) < practical(name, median(base))) return [0, estimate];
  const sign =
    lower <= 0.05 && estimate < 0 ? -1 : upper <= 0.05 && estimate > 0 ? 1 : 0;
  return [sign, estimate];
}

/** Defects are judged per iteration: how many of n were non-zero (one-sided
 * Fisher, p ≤ 0.05), and by how much: as for targets, or by how many
 * candidate iterations lie beyond the base's whole range (the same count as
 * from none, so a constant defect that worsens in most iterations is seen).
 * Several defects are intermittent today, so one hit is not a verdict. */
function defectVerdict(name, base, candidate) {
  const [kx, ky] = [base, candidate].map(
    (side) => side.filter((v) => present(name, v)).length,
  );
  if (!kx && !ky) return "absent";
  const { lower, upper } = fisher(kx, base.length, ky, candidate.length);
  const rate = upper <= 0.05 ? 1 : lower <= 0.05 ? -1 : 0;
  const margin = practical(name, median(base));
  const beyond = (keep) =>
    fisher(0, base.length, candidate.filter(keep).length, candidate.length)
      .upper <= 0.05;
  const [paired] = direction(name, base, candidate);
  const size =
    paired ||
    (beyond((v) => v > Math.max(...base) + margin)
      ? 1
      : beyond((v) => v < Math.min(...base) - margin)
        ? -1
        : 0);
  if (rate > 0 && !kx) return "introduced";
  if (rate < 0 && !ky) return "fixed";
  if (rate * size < 0) return "mixed";
  const sign = rate || size;
  return sign > 0 ? "worse" : sign < 0 ? "better" : "no verdict";
}

/** Verdict per metric over iterations paired by order; `problems` make the comparison invalid. */
export function compare(base, candidate, minN = 5) {
  const problems = [...base.failures, ...candidate.failures].map(
    (f) => `failed: ${f}`,
  );
  for (const [name, side] of Object.entries({ base, candidate })) {
    const builds = new Set(side.iterations.map((m) => m.build));
    if (builds.size > 1)
      problems.push(`${name} mixes builds: ${[...builds].join(", ")}`);
  }
  const series = (side) => {
    const out = new Map();
    for (const m of side.iterations)
      for (const tier of TIERS)
        for (const [name, value] of Object.entries(m[tier] ?? {})) {
          const key = `${m.scenario}/${m.variant} ${name}`;
          if (!out.has(key))
            out.set(key, { tier, values: [], envs: new Set() });
          out.get(key).values.push(value);
          out.get(key).envs.add(JSON.stringify(m.env));
        }
    return out;
  };
  const [a, b] = [series(base), series(candidate)];
  const rows = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const [x, y] = [a.get(key), b.get(key)];
    if (!x || !y) {
      problems.push(`${key}: missing on the ${x ? "candidate" : "base"}`);
      continue;
    }
    const group = key.slice(0, key.indexOf(" "));
    const envs = new Set([...x.envs, ...y.envs]);
    if (envs.size > 1)
      problems.push(`${group}: not comparable: ${[...envs].join(" vs ")}`);
    if (x.values.length !== y.values.length || x.values.length < minN)
      problems.push(
        `${group}: n ${x.values.length} vs ${y.values.length}, need ${minN} pairs`,
      );
    const name = key.slice(key.indexOf(" ") + 1);
    const row = {
      key,
      name,
      tier: x.tier,
      base: x.values,
      candidate: y.values,
    };
    if (x.values.length === y.values.length && x.tier !== "work") {
      const [sign, estimate] = direction(name, x.values, y.values);
      row.estimate = estimate;
      row.verdict =
        x.tier === "defects"
          ? defectVerdict(name, x.values, y.values)
          : ["improved", "no verdict", "regressed"][sign + 1];
    }
    if (x.tier === "defects")
      row.k = [x.values, y.values].map(
        (v) => v.filter((value) => present(name, value)).length,
      );
    rows.push(row);
  }
  const loads = [base, candidate].map((side) =>
    median(side.iterations.map((m) => m.load)),
  );
  return { rows, problems: [...new Set(problems)], loads };
}

const fmt = (v) =>
  v == null || Number.isNaN(v)
    ? "–"
    : Math.abs(v) >= 100
      ? v.toFixed(0)
      : v.toFixed(1);
const range = (v) =>
  v.length
    ? `${fmt(median(v))} [${fmt(Math.min(...v))}–${fmt(Math.max(...v))}]`
    : "–";
const cell = (row, side, i) => {
  if (!row.k) return range(row[side]);
  const hits = row[side].filter((v) => present(row.name, v));
  return `${row.k[i]}/${row[side].length}${hits.length ? `, ${fmt(median(hits))} (max ${fmt(Math.max(...hits))})` : ""}`;
};

/** Prints the table; returns the exit code. With a target: 0 keep (it improved,
 * or its defect was fixed or got better, and nothing else regressed or got
 * worse), 1 revert (including no verdict), 2 invalid. */
export function report({ rows, problems, loads = [] }, target) {
  const goal = target && rows.find((r) => r.key === target);
  if (target && !["targets", "defects"].includes(goal?.tier))
    problems.push(
      `target ${target} is ${goal ? `a ${goal.tier} metric, not a target or defect` : "not measured"}`,
    );
  for (const p of problems) console.log(`INVALID ${p}`);
  console.log(
    `Load average (median): base ${fmt(loads[0])}, candidate ${fmt(loads[1])}\n`,
  );
  console.log(
    "| tier | metric | base | candidate | Δ median | verdict |\n|---|---|---|---|---|---|",
  );
  for (const r of rows)
    console.log(
      `| ${r.tier} | ${r.key} | ${cell(r, "base", 0)} | ${cell(r, "candidate", 1)} | ${fmt(r.estimate)} | ${r.verdict ?? ""} |`,
    );
  if (problems.length) {
    if (target) console.log(`\nDECISION\tINVALID\t${target}`);
    return 2;
  }
  if (!target) return 0;
  const blocked = rows.filter(
    (r) =>
      r !== goal &&
      (r.verdict === "regressed" ||
        ["introduced", "worse", "mixed"].includes(r.verdict)),
  );
  const keep =
    ["improved", "fixed", "better"].includes(goal.verdict) && !blocked.length;
  console.log(
    `\nDECISION\t${keep ? "KEEP" : "REVERT"}\t${target}\t${goal.verdict}\t${fmt(goal.estimate)}\t${blocked.map((r) => `${r.key} ${r.verdict}`).join(", ")}`,
  );
  return keep ? 0 : 1;
}

if (import.meta.main)
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { target: { type: "string" } },
    });
    if (positionals.length !== 2)
      throw new Error(
        "usage: compare.mjs <base-run,...> <candidate-run,...> [--target <key>]",
      );
    const [base, candidate] = positionals.map((list) =>
      load(list.split(",").map((dir) => resolve(dir))),
    );
    process.exitCode = report(compare(base, candidate), values.target);
  } catch (error) {
    console.log(`INVALID ${error.message}`);
    process.exitCode = 2;
  }
