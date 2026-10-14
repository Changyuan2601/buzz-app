// Pure definitions of the opt-in perf harness (tests/browser/perf,
// docs/performance-harness.md): geometry, windows, statistics, verdicts and
// the rules that make a comparison invalid.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  compare,
  fisher,
  load,
  report,
  signedRank,
} from "../browser/perf/compare.mjs";
import {
  fling,
  focused,
  frames,
  lead,
  opened,
  placement,
  shift,
  stats,
  union,
} from "../browser/perf/metrics.mjs";

/** A session from frames [raf, timeline fields, input?]; rows are [id, top, bottom, hidden?]. */
const session = (list, extra = {}) => ({
  startedAt: 0,
  stoppedAt: list.at(-1)[0] + 16,
  wheels: [],
  fetches: [],
  ...extra,
  frames: list.map(([raf, s, input = 0]) => ({
    raf,
    t: raf + 4,
    input,
    focus: s.focus ?? null,
    s: s.absent
      ? {}
      : {
          timeline: {
            st: 0,
            ch: 100,
            sh: 1000,
            lt: -1000,
            lh: 2000,
            prog: 0,
            writes: 0,
            added: 0,
            older: 0,
            cid: "c",
            ...s,
            rows: s.rows.map(([id, top, bottom, h = 0]) => [
              id,
              top,
              bottom,
              h,
            ]),
          },
        },
  })),
});
const row = (id, top, bottom, hidden = false) => ({ id, top, bottom, hidden });

test("union and lead: overlaps merge; lead stops at the first hole past each edge", () => {
  assert.equal(union([]), 0);
  assert.equal(
    union([
      [0, 10],
      [5, 20],
      [30, 40],
      [32, 35],
    ]),
    30,
  );
  const rows = [
    row("a", -50, 0),
    row("b", 0, 100),
    row("c", 100, 140),
    row("d", 150, 200),
  ];
  assert.deepEqual(lead(rows, 100), { above: 50, below: 40 });
  assert.deepEqual(lead([row("a", 10, 90)], 100), { above: 0, below: 0 });
  assert.deepEqual(lead([row("a", -50, 150, true)], 100), {
    above: 0,
    below: 0,
  });
});

test("shift: the reader's scroll is expected during input; idle motion and idle swaps are jumps", () => {
  const prev = { st: 0, ch: 100, rows: [row("a", 0, 50), row("b", 50, 100)] };
  const moved = { ...prev, st: 40, prog: 0 };
  assert.equal(shift(prev, moved, true), 0);
  assert.equal(shift(prev, moved, false), 40);
  // A correction during input moves content and scroll together: no jump.
  const corrected = {
    ...prev,
    st: 30,
    prog: 30,
    rows: [row("a", 30, 80), row("b", 80, 130)],
  };
  assert.equal(shift(prev, corrected, true), 0);
  // Every row in view replaced while idle: a survivor just outside measures it, else one viewport.
  const swapped = {
    st: 300,
    ch: 100,
    prog: 0,
    rows: [row("a", 260, 310), row("c", 310, 400)],
  };
  assert.equal(shift(prev, swapped, false), 40);
  assert.equal(
    shift(prev, { ...swapped, rows: [row("c", 300, 400)] }, false),
    100,
  );
  // Revealing hidden (unmeasured) slots replaces nothing.
  const hidden = {
    ...prev,
    rows: prev.rows.map((r) => ({ ...r, hidden: true })),
  };
  assert.equal(
    shift(hidden, { ...moved, st: 0, rows: [row("x", 0, 100)] }, false),
    0,
  );
});

test("stats: DOM blank weighs its time on screen; compositor exposure counts past the painted lead", () => {
  const s = session([
    // 200px of travel past a 100px painted lead: blank for half the interval.
    [0, { st: 500, rows: [["a", 400, 700]] }],
    [100, { st: 300, rows: [["a", 200, 500]] }, 1],
    // 50px of the view uncovered in the DOM for one 100ms frame.
    [200, { st: 300, rows: [["a", 350, 500]] }],
    [300, { st: 300, rows: [["a", 200, 500]] }],
  ]);
  const series = frames(s, "timeline");
  assert.equal(stats(series, 0, 400).screenBlankMs, 50 + 100);
  assert.equal(
    stats(series, 1000, 2000),
    null,
    "an empty window is missing, not clean",
  );
  assert.ok(frames(s, "timeline", "other").every((r) => r.absent));
});

test("stats: hidden slots, dead input at a loadable top edge, overlap and dropped frames", () => {
  const s = session([
    [
      0,
      {
        st: 0,
        older: 1,
        rows: [
          ["a", 0, 60, 1],
          ["b", 60, 100],
        ],
      },
      1,
    ],
    [
      40,
      {
        st: 0,
        older: 1,
        rows: [
          ["a", 0, 60],
          ["b", 50, 100],
        ],
      },
      1,
    ],
    [
      56,
      {
        st: 0,
        rows: [
          ["a", 0, 60],
          ["b", 60, 100],
        ],
      },
    ],
  ]);
  const w = stats(frames(s, "timeline"), 0, 100);
  assert.equal(w.hiddenMs, 40);
  assert.equal(w.deadInputMs, 56);
  assert.equal(w.overlapPx, 10);
  assert.equal(w.droppedFrames, 1);
});

test("frames: exposure is not guessed across an absent stretch", () => {
  const s = session([
    [0, { st: 500, rows: [["a", 500, 600]] }],
    [16, { absent: true }],
    [32, { st: 100, rows: [["a", 100, 200]] }],
    [48, { st: 100, rows: [["a", 100, 200]] }],
  ]);
  assert.equal(stats(frames(s, "timeline"), 0, 64).screenBlankMs, 0);
});

test("fling: windows by wheel time; the stopped window starts two frames after the last movement corrections do not explain", () => {
  const rows = [["a", -500, 100]];
  const s = session(
    [
      [0, { rows, older: 1 }],
      [16, { st: -100, rows, older: 1 }, 1],
      [32, { st: -200, rows, older: 1 }, 1],
      [48, { st: -220, prog: -20, writes: 1, rows }],
      [64, { st: -220, rows }],
      [80, { st: -220, added: 1, rows: [...rows, ["b", -600, -500]] }],
      [96, { st: -220, rows: [...rows, ["b", -600, -500]] }],
    ],
    { wheels: [1, 20] },
  );
  const f = fling(s);
  assert.equal(f.wheels, 2);
  assert.equal(f.travelledPx, 200, "through the frame after the last wheel");
  assert.equal(f.loadable, true);
  assert.equal(f.afterStop.corrections, 1);
  assert.equal(f.stopped.rowsAdded, 1);
  assert.equal(
    fling(session([[0, { rows }]])).input,
    null,
    "no wheel, no window",
  );
});

test("opened, placement and focus: first painted row, final picture, displacement from first placement", () => {
  const s = session([
    [0, { rows: [] }],
    [16, { rows: [["t", 20, 60, 1]] }],
    [32, { rows: [["t", 20, 60]] }],
    [
      48,
      {
        // Remounted unmeasured, far from where it ends.
        rows: [
          ["t", -300, -260, 1],
          ["u", 0, 100],
        ],
        focus: ["t", "thread"],
      },
    ],
    [64, { rows: [["t", 0, 40]], focus: ["t", "timeline"] }],
    [80, { rows: [["t", 0, 40]] }],
  ]);
  const series = frames(s, "timeline");
  const open = opened(series, 10);
  assert.equal(open.firstRowsMs, 26);
  assert.equal(open.completeMs, 58);
  assert.equal(
    stats(series, 16, 96).shiftPx,
    100 + 100,
    "two idle swaps without survivors, one viewport each",
  );
  const target = placement(series, "t", 10);
  assert.equal(target.displacementPx, 300, "a hidden remount counts");
  assert.equal(target.inViewAtEnd, true);
  assert.equal(
    focused(series, "t", "timeline", 10),
    58,
    "the copy on the other surface does not count",
  );
  assert.equal(focused(series, "t", "inline", 10), null);
});

test("statistics: exact signed-rank tails and Fisher exact", () => {
  assert.deepEqual(signedRank([1, 2, 3, 4, 5]), { lower: 1, upper: 1 / 32 });
  assert.equal(
    signedRank([-1, -2, -3, -4]).lower,
    1 / 16,
    "4 pairs can never reach 0.05",
  );
  assert.deepEqual(signedRank([0, 0, 0]), { lower: 1, upper: 1 });
  assert.ok(signedRank([-3, 1, 2, -1, 4, -2, 3]).upper > 0.3);
  assert.equal(
    signedRank([2, 2, 2, 2, 2]).upper,
    1 / 32,
    "ties take average ranks",
  );
  assert.ok(Math.abs(fisher(5, 5, 0, 5).lower - 1 / 252) < 1e-9);
  assert.ok(fisher(5, 5, 0, 5).upper > 0.999);
  assert.ok(
    fisher(0, 7, 3, 7).upper > 0.05,
    "0 of 7 to 3 of 7 is not evidence",
  );
  assert.ok(fisher(0, 7, 4, 7).upper <= 0.05);
});

const iteration = (m, env = {}, build = "b") => ({
  perf: 1,
  scenario: "s",
  variant: "v",
  env: { harness: "h", ...env },
  build,
  targets: { aMs: m[0] },
  defects: { bPx: m[1] },
  guards: { cMs: m[2] },
  work: { reads: 3 },
});
const side = (list, { env, failures = [], build } = {}) => ({
  iterations: list.map((m) => iteration(m, env, build)),
  failures,
});
const BASE = [
  [400, 0, 100],
  [410, 0, 101],
  [405, 0, 99],
  [395, 0, 100],
  [402, 0, 100],
];
const printed = [];
const quiet = (fn) => {
  const log = console.log;
  printed.length = 0;
  console.log = (line) => printed.push(line);
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

test("compare: paired verdicts per tier, and keep or revert on a declared target", () => {
  const better = side(BASE.map(([a, b, c]) => [a - 100, b, c]));
  const result = compare(side(BASE), better);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.rows.map((r) => r.verdict),
    ["improved", "absent", "no verdict", undefined],
  );
  assert.equal(
    quiet(() => report(result, "s/v aMs")),
    0,
  );
  // Jumps in 4 of 5 iterations: introduced, and the keep is blocked. One
  // jump is no verdict: intermittent defects do that on the same build.
  const jumps = (hits) =>
    side(BASE.map(([a, b, c], i) => [a - 100, i < hits ? 3 : b, c]));
  assert.equal(compare(side(BASE), jumps(4)).rows[1].verdict, "introduced");
  assert.equal(
    quiet(() => report(compare(side(BASE), jumps(4)), "s/v aMs")),
    1,
  );
  assert.equal(compare(side(BASE), jumps(1)).rows[1].verdict, "no verdict");
  assert.equal(
    quiet(() => report(compare(side(BASE), jumps(1)), "s/v aMs")),
    0,
  );
  // A guard that regresses blocks; a target with no verdict reverts.
  const slower = side(BASE.map(([a, b, c]) => [a - 100, b, c + 50]));
  assert.equal(
    quiet(() => report(compare(side(BASE), slower), "s/v aMs")),
    1,
  );
  assert.equal(
    quiet(() => report(compare(side(BASE), side(BASE)), "s/v aMs")),
    1,
  );
  // Inside the practical threshold (16.7ms) is no verdict, however consistent.
  const nudged = side(BASE.map(([a, b, c]) => [a - 10, b, c]));
  assert.equal(compare(side(BASE), nudged).rows[0].verdict, "no verdict");
});

test("compare: defects by how many of n were non-zero, and by how much", () => {
  const verdict = (base, candidate) =>
    compare(
      side(base.map((b) => [400, b, 100])),
      side(candidate.map((b) => [400, b, 100])),
    ).rows[1].verdict;
  const seven = (v) => Array(7).fill(v);
  assert.equal(verdict(seven(0), seven(0)), "absent");
  assert.equal(verdict(seven(100), seven(0)), "fixed");
  assert.equal(
    verdict([100, 100, 0, 0, 0, 0, 0], seven(0)),
    "no verdict",
    "2 of 7 to 0 of 7 is not shown fixed",
  );
  assert.equal(verdict(seven(100), seven(140)), "worse");
  assert.equal(verdict(seven(140), seven(100)), "better");
  assert.equal(verdict(seven(100), seven(101)), "no verdict");
  assert.equal(
    verdict(seven(293), [600, 600, 600, 600, 600, 293, 293]),
    "worse",
    "a constant defect that worsens in most iterations",
  );
  assert.equal(
    quiet(() =>
      report(
        compare(
          side(seven(0).map((b) => [400, b + 100, 100])),
          side(seven(0).map((b) => [400, b, 100])),
        ),
        "s/v bPx",
      ),
    ),
    0,
  );
});

test("compare fails closed: failures, other harness code, mixed builds, unpaired, too few or missing values", () => {
  const invalid = (base, candidate, target) =>
    quiet(() => report(compare(base, candidate), target));
  assert.equal(invalid(side(BASE), side(BASE, { failures: ["x: failed"] })), 2);
  assert.equal(
    invalid(side(BASE), side(BASE, { env: { harness: "other" } })),
    2,
  );
  assert.equal(invalid(side(BASE), side(BASE.slice(0, 4))), 2);
  assert.equal(invalid(side(BASE.slice(0, 4)), side(BASE.slice(0, 4))), 2);
  const mixed = side(BASE);
  mixed.iterations[0].build = "other";
  assert.equal(invalid(side(BASE), mixed), 2);
  const missing = side(BASE);
  for (const m of missing.iterations) delete m.defects;
  assert.equal(invalid(side(BASE), missing), 2);
  assert.equal(
    invalid(side(BASE), side(BASE), "s/v nothingMs"),
    2,
    "an unmeasured target is invalid, not a revert",
  );
  assert.equal(
    invalid(side(BASE), side(BASE), "s/v reads"),
    2,
    "a work counter is never a target",
  );
  assert.equal(invalid(side(BASE), side(BASE), "s/v cMs"), 2, "nor a guard");
  assert.ok(
    printed.includes(
      "INVALID target s/v cMs is a guards metric, not a target or defect",
    ),
  );
});

test("load: a missing report, a test that did not pass or reported nothing, and a global error are failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-load-"));
  const evidence = (measurements) => [
    {
      name: "browser-evidence",
      body: Buffer.from(JSON.stringify({ measurements })).toString("base64"),
    },
  ];
  const result = (status, attachments = []) => ({ status, attachments });
  writeFileSync(
    join(dir, "report.json"),
    JSON.stringify({
      errors: [{ message: "Build failed\nstack" }],
      suites: [
        {
          specs: [
            {
              title: "ok",
              tests: [
                { results: [result("passed", evidence([iteration(BASE[0])]))] },
              ],
            },
            {
              title: "silent",
              tests: [{ results: [result("passed", evidence([]))] }],
            },
            { title: "skipped", tests: [{ results: [result("skipped")] }] },
            { title: "broken", tests: [{ results: [result("failed")] }] },
          ],
        },
      ],
    }),
  );
  const { iterations, failures } = load([dir, join(dir, "absent")]);
  assert.equal(iterations.length, 1);
  assert.equal(failures.length, 5);
  assert.match(
    failures.join("\n"),
    /Build failed[^\n]*\n.*silent: no result\n.*skipped: skipped\n.*broken: failed\n.*no report\.json/,
  );
});
