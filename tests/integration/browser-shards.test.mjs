import assert from "node:assert/strict";
import test from "node:test";
import { assign, weightsFrom } from "../../scripts/browser-shards.mjs";

const files = (...names) => names.map(([file, tests]) => ({ file, tests }));

test("every file lands in exactly one shard, balanced by recorded cost rather than path order", () => {
  // Path order puts the three costly neighbours together; count sharding would too.
  const listed = files(
    ["a.spec.mjs", 2],
    ["n1.spec.mjs", 8],
    ["n2.spec.mjs", 8],
    ["n3.spec.mjs", 8],
    ["z.spec.mjs", 2],
  );
  const weights = {
    "a.spec.mjs": 20,
    "n1.spec.mjs": 300,
    "n2.spec.mjs": 290,
    "n3.spec.mjs": 280,
    "z.spec.mjs": 10,
  };
  const shards = assign(listed, weights, 3);
  assert.deepEqual(shards.flat().sort(), listed.map(({ file }) => file).sort());
  assert.deepEqual(shards, [
    ["n1.spec.mjs"],
    ["n2.spec.mjs", "z.spec.mjs"],
    ["a.spec.mjs", "n3.spec.mjs"],
  ]);
  assert.deepEqual(
    assign([...listed].reverse(), weights, 3),
    shards,
    "listing order does not matter",
  );
});

test("unrecorded files cost their test count at the median recorded per-test rate", () => {
  const listed = files(
    ["big.spec.mjs", 1],
    ["new.spec.mjs", 10],
    ["small1.spec.mjs", 2],
    ["small2.spec.mjs", 3],
  );
  // Rates 150, 10 and 10 s/test: the median makes new.spec.mjs cost 100.
  // A mean rate (567) or a bare test count (10) would place it differently.
  const weights = {
    "big.spec.mjs": 150,
    "small1.spec.mjs": 20,
    "small2.spec.mjs": 30,
  };
  assert.deepEqual(assign(listed, weights, 3), [
    ["big.spec.mjs"],
    ["new.spec.mjs"],
    ["small1.spec.mjs", "small2.spec.mjs"],
  ]);
  // Without any record, cost follows test count alone.
  assert.deepEqual(assign(listed, {}, 3), [
    ["new.spec.mjs"],
    ["small2.spec.mjs"],
    ["big.spec.mjs", "small1.spec.mjs"],
  ]);
});

test("weights sum each spec file's attempts per project in whole seconds, including imported journeys", () => {
  const report = {
    suites: [
      {
        file: "a.spec.mjs",
        specs: [
          {
            file: "a.spec.mjs",
            tests: [
              {
                projectName: "webkit",
                results: [{ duration: 1200 }, { duration: 900 }],
              },
              { projectName: "chromium", results: [{ duration: 100 }] },
            ],
          },
        ],
        suites: [
          {
            specs: [
              {
                // Declared in a journey module the spec file imports.
                file: "../../src/x/x.journey.mjs",
                tests: [
                  { projectName: "webkit", results: [{ duration: 3400 }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(weightsFrom([report]), {
    chromium: { "a.spec.mjs": 1 },
    webkit: { "a.spec.mjs": 6 },
  });
});
