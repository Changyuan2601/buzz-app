// @vitest-environment jsdom
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { POLL_MS, watchPulls } from "./watcher";
import { QUIET_MS } from "./watch";

const agent = "a".repeat(64);
const root = "f".repeat(64);
const url = "https://github.com/block/buzz-app/pull/7";

/** A gh GraphQL answer for an open pull request. */
const answer = ({
  head = "1111111111",
  checks = [] as { name: string; conclusion: string | null }[],
  comments = [] as { id: number; login: string; body: string }[],
  state = "OPEN",
} = {}) =>
  JSON.stringify({
    data: {
      viewer: { login: "baxen" },
      repository: {
        pullRequest: {
          state,
          headRefOid: head,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: checks.some((check) => !check.conclusion)
                      ? "PENDING"
                      : "SUCCESS",
                    contexts: {
                      totalCount: checks.length,
                      nodes: checks.map(({ name, conclusion }) => ({
                        __typename: "CheckRun",
                        name,
                        status: conclusion ? "COMPLETED" : "IN_PROGRESS",
                        conclusion,
                      })),
                    },
                  },
                },
              },
            ],
          },
          reviews: { nodes: [] },
          comments: {
            nodes: comments.map(({ id, login, body }) => ({
              databaseId: id,
              author: { login },
              body,
              url: `${url}#${id}`,
            })),
          },
          reviewThreads: { nodes: [] },
        },
      },
    },
  });

function setup(initial: string | null = answer()) {
  let gh = initial;
  const runCommand = vi.fn(async () => gh);
  const reply = vi.fn();
  const send = vi.fn();
  let status = "ready";
  const tools: AddedTool[] = [];
  const disposers: (() => void)[] = [];
  const ctx = {
    host: { runCommand },
    agents: {
      addTool: (tool: AddedTool) => tools.push(tool),
      find: () => ({ name: "mbot" }),
      relay: () => ({
        snapshot: () => ({ status, session: { messages: { reply, send } } }),
      }),
    },
    effect: (fn: () => () => void) => disposers.push(fn()),
  } as unknown as Context;
  watchPulls(ctx);
  const tool = tools[0] as AddedTool;
  const call = (args: Record<string, unknown>, topLevel = false) =>
    tool.call(
      { pubkey: agent } as BuzzClient,
      { channel: "c", root, topLevel },
      args,
    );
  return {
    call,
    reply,
    send,
    runCommand,
    gh: (value: string | null) => {
      gh = value;
    },
    status: (value: string) => {
      status = value;
    },
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

describe("watch_pr", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("wakes the agent in its thread when CI finishes, as the owner mentioning it", async () => {
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    expect(await app.call({ url })).toMatch(/^Watching https:/);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "FAILURE" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.reply).toHaveBeenCalledTimes(1);
    const [channel, thread, content, mentions] = app.reply.mock.calls[0] ?? [];
    expect([channel, thread, mentions]).toEqual(["c", root, [agent]]);
    expect(content).toMatch(
      /^@mbot CI failed on 111111111 for https:\/\/github\.com\/block\/buzz-app\/pull\/7:\n- unit\n\n_Sent by the GitHub plugin/,
    );
    // Reported once per head commit.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.reply).toHaveBeenCalledTimes(1);
    app.dispose();
  });

  it("answers what is already there instead of waking, and posts top-level in a Solo chat", async () => {
    const app = setup();
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: 1, login: "wes", body: "body-old" }],
      }),
    );
    expect(await app.call({ url }, true)).toContain(
      "Already there:\nCI passed on 111111111",
    );
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [
          { id: 1, login: "wes", body: "body-old" },
          { id: 2, login: "wes", body: "body-new" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUIET_MS + POLL_MS);
    expect(app.send).toHaveBeenCalledTimes(1);
    expect(app.send.mock.calls[0]?.[1]).toContain(`wes: ${url}#2`);
    expect(app.send.mock.calls[0]?.[1]).not.toContain(`${url}#1`);
    // Nobody else's words are sent as the owner.
    expect(app.send.mock.calls[0]?.[1]).not.toContain("body-");
    app.dispose();
  });

  it("keeps news it could not send, and survives a restart", async () => {
    const app = setup();
    await app.call({ url });
    app.status("connecting");
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.reply).not.toHaveBeenCalled();
    app.dispose();
    // The restarted app reads at once.
    const next = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(next.reply).toHaveBeenCalledTimes(1);
    next.dispose();
  });

  it("stops on request, when merged, and refuses unreadable pull requests", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url, stop: true })).toBe(
      `Stopped watching ${url}.`,
    );
    app.gh(null);
    await expect(app.call({ url })).rejects.toThrow(/gh/);
    await expect(app.call({ url: "https://example.com/x" })).rejects.toThrow(
      /pull request URL/,
    );
    app.gh(answer());
    await app.call({ url });
    app.gh(answer({ state: "MERGED" }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(
      JSON.parse(localStorage.getItem("buzz.github.pull-watches.v1") ?? ""),
    ).toEqual([]);
    expect(app.reply).not.toHaveBeenCalled();
    app.dispose();
  });

  it("ends a watch it cannot read for half an hour, telling the agent", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.reply).not.toHaveBeenCalled();
    // A good read in between starts the count again.
    app.gh(answer());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.reply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.reply).toHaveBeenCalledTimes(1);
    expect(app.reply.mock.calls[0]?.[2]).toContain(`Stopped watching ${url}`);
    expect(
      JSON.parse(localStorage.getItem("buzz.github.pull-watches.v1") ?? ""),
    ).toEqual([]);
    app.dispose();
  });

  it("says when a watch moves to another conversation", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url }, true)).toContain(
      "no longer in the conversation that asked before",
    );
    app.dispose();
  });
});
