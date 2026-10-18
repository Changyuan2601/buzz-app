import { describe, expect, it } from "vitest";
import {
  parsePull,
  pullOf,
  QUIET_MS,
  step,
  WAKE_LIMIT,
  type Feedback,
  type PullSnapshot,
  type Watch,
} from "./watch";

const url = "https://github.com/block/buzz-app/pull/7";
const watch: Watch = { agent: "a".repeat(64), url, channel: "c", wakes: 0 };
const comment = (id: string, author = "wes"): Feedback => ({
  id,
  author,
  url: `${url}#${id}`,
});
const snap = (over: Partial<PullSnapshot> = {}): PullSnapshot => ({
  state: "OPEN",
  viewer: "baxen",
  head: "1111111111aaaa",
  settled: false,
  failed: [],
  feedback: [],
  ...over,
});

describe("step", () => {
  it("learns existing feedback on the first read without waking", () => {
    const first = step(watch, snap({ feedback: [comment("1")] }), 0);
    expect(first.wake).toBeUndefined();
    expect(first.watch.seen).toEqual(["1"]);
  });

  it("wakes once per head and result when CI settles", () => {
    const running = step(watch, snap({ failed: ["e2e"] }), 0);
    expect(running.wake).toBeUndefined();
    const failed = step(
      running.watch,
      snap({ settled: true, failed: ["e2e"] }),
      1,
    );
    expect(failed.wake).toBe(`CI failed on 111111111 for ${url}:\n- e2e`);
    expect(failed.watch.wakes).toBe(1);
    // The same result on the same head is not reported twice.
    const again = step(
      failed.watch,
      snap({ settled: true, failed: ["e2e"] }),
      2,
    );
    expect(again.wake).toBeUndefined();
    // A rerun that passes is.
    const rerun = step(again.watch, snap({ settled: true }), 3);
    expect(rerun.wake).toBe(`CI passed on 111111111 for ${url}.`);
    // And so is a new push.
    const pushed = step(
      rerun.watch,
      snap({ head: "2222222222", settled: true }),
      4,
    );
    expect(pushed.wake).toBe(`CI passed on 222222222 for ${url}.`);
  });

  it("batches new feedback until it has been quiet, skipping the viewer's own", () => {
    const base = step(watch, snap(), 0).watch;
    const first = step(
      base,
      snap({ feedback: [comment("1"), comment("2", "baxen")] }),
      1_000,
    );
    expect(first.wake).toBeUndefined();
    expect(first.watch.pending?.map((item) => item.id)).toEqual(["1"]);
    const all = [comment("1"), comment("2", "baxen"), comment("3")];
    const more = step(
      first.watch,
      snap({ feedback: all }),
      1_000 + QUIET_MS - 1,
    );
    expect(more.wake).toBeUndefined();
    const quiet = step(
      more.watch,
      snap({ feedback: all }),
      1_000 + 2 * QUIET_MS,
    );
    expect(quiet.wake).toBe(
      `2 new comments on ${url}, to read with gh:\n- wes: ${url}#1\n- wes: ${url}#3`,
    );
    expect(quiet.watch.pending).toEqual([]);
  });

  it("keeps every id a read returns as seen, however many", () => {
    const many = Array.from({ length: 900 }, (_, i) => comment(String(i)));
    const first = step(watch, snap({ feedback: many }), 0);
    const second = step(first.watch, snap({ feedback: many }), QUIET_MS * 2);
    expect(second.watch.pending).toEqual([]);
    expect(second.wake).toBeUndefined();
  });

  it("sends pending feedback with a CI result without waiting", () => {
    const base = step(watch, snap(), 0).watch;
    const result = step(
      base,
      snap({ settled: true, feedback: [comment("1")] }),
      1,
    );
    expect(result.wake).toBe(
      `CI passed on 111111111 for ${url}.\n\nNew feedback on ${url}, to read with gh:\n- wes: ${url}#1`,
    );
  });

  it("ends when the pull request merges or closes, and after the wake limit", () => {
    expect(step(watch, snap({ state: "MERGED" }), 0).ended).toBe("merged");
    expect(step(watch, snap({ state: "CLOSED" }), 0).ended).toBe("closed");
    const last = step(
      { ...watch, wakes: WAKE_LIMIT - 1 },
      snap({ settled: true }),
      0,
    );
    expect(last.wake).toBeDefined();
    expect(last.ended).toBe("limit");
  });
});

describe("pullOf", () => {
  it("accepts pull request URLs only, in one spelling", () => {
    expect(
      pullOf("https://github.com/Block/Buzz-App/pull/7/files#diff"),
    ).toEqual({
      owner: "block",
      name: "buzz-app",
      number: 7,
      url,
    });
    expect(
      pullOf("https://github.com/block/buzz-app/issues/7"),
    ).toBeUndefined();
    expect(pullOf("https://example.com/block/buzz-app/pull/7")).toBeUndefined();
  });
});

describe("parsePull", () => {
  const response = ({
    rollup = "FAILURE",
    total = 3,
    e2e = "COMPLETED",
  } = {}) =>
    JSON.stringify({
      data: {
        viewer: { login: "baxen" },
        repository: {
          pullRequest: {
            state: "OPEN",
            headRefOid: "abc",
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      state: rollup,
                      contexts: {
                        totalCount: total,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "unit",
                            status: "COMPLETED",
                            conclusion: "FAILURE",
                          },
                          {
                            __typename: "CheckRun",
                            name: "e2e",
                            status: e2e,
                            conclusion: e2e === "COMPLETED" ? "SUCCESS" : null,
                          },
                          {
                            __typename: "StatusContext",
                            context: "deploy",
                            state: "SUCCESS",
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
            reviews: {
              nodes: [
                {
                  databaseId: 1,
                  author: { login: "wes" },
                  state: "CHANGES_REQUESTED",
                  body: "Fix it",
                  url: "u1",
                },
                {
                  databaseId: 2,
                  author: { login: "wes" },
                  state: "COMMENTED",
                  body: "",
                  url: "u2",
                },
              ],
            },
            comments: { nodes: [{ databaseId: 3, author: null, url: "u3" }] },
            reviewThreads: {
              nodes: [
                {
                  comments: {
                    nodes: [
                      {
                        databaseId: 4,
                        author: { login: "codex" },
                        path: "src/a.ts",
                        line: 12,
                        url: "u4",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

  it("reads failed checks, reviews, comments and inline comments", () => {
    expect(parsePull(response())).toEqual({
      state: "OPEN",
      viewer: "baxen",
      head: "abc",
      settled: true,
      failed: ["unit"],
      feedback: [
        {
          id: "review/1",
          author: "wes",
          where: "review, changes requested",
          url: "u1",
        },
        { id: "comment/3", author: "ghost", url: "u3" },
        { id: "inline/4", author: "codex", where: "src/a.ts:12", url: "u4" },
      ],
    });
  });

  it("is not settled while a check runs, more are unread, or the rollup waits", () => {
    expect(parsePull(response({ e2e: "IN_PROGRESS" }))?.settled).toBe(false);
    expect(parsePull(response({ total: 101 }))?.settled).toBe(false);
    expect(parsePull(response({ rollup: "EXPECTED" }))?.settled).toBe(false);
  });

  it("gives undefined for errors and missing pull requests", () => {
    expect(parsePull("not json")).toBeUndefined();
    expect(
      parsePull(
        JSON.stringify({ data: { repository: { pullRequest: null } } }),
      ),
    ).toBeUndefined();
  });
});
