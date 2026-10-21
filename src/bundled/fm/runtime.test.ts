import { describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../features/agents/service";
import {
  alice,
  bob,
  channel,
  message,
  reply,
  root,
  self,
  setup,
} from "./fm-testing";
import { SHORT_LATEST_CHARS } from "./prompt";

describe("FmRuntime", () => {
  it("answers a mention that starts a thread in that thread", async () => {
    const { runs, published, read, deliver } = setup();
    const acknowledged = vi.fn();
    const mention = message("2", "@Orchard what's 2+2?");
    await deliver(mention, { acknowledged });
    expect(read).not.toHaveBeenCalled();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("respond");
    const [system = ""] = runs[0]?.args ?? [];
    expect(system.startsWith("--instructions=You are Orchard")).toBe(true);
    expect(system).toContain("working for Alice");
    expect(system).toContain("Your owner's instructions:\nBe brief.");
    expect(runs[0]?.stdin).toBe(
      "Latest message in #general, from Alice:\n@Orchard what's 2+2?",
    );
    expect(acknowledged).toHaveBeenCalled();
    expect(published).toEqual([
      {
        kind: 9,
        content: "Four.",
        tags: [
          ["h", channel],
          ["e", mention.id, "", "reply"],
        ],
      },
    ]);
  });

  it("shows the model the thread so far, its own replies as its own", async () => {
    const thread = [
      message("1", "Let's plan the offsite.", { id: root }),
      reply("2", "Sure, when?", { pubkey: self }),
      reply("3", "Next week works", { pubkey: bob }),
      // Newer than the mention: not shown.
      reply("9", "late"),
    ];
    const { runs, published, deliver } = setup({ thread });
    await deliver(reply("4", "@Orchard summarize"));
    expect(runs[0]?.stdin).toBe(
      [
        "Earlier messages in #general, in a thread:",
        "Alice: Let's plan the offsite.\nYou (Orchard): Sure, when?\nBob: Next week works",
        "",
        "Latest message in #general, in a thread, from Alice:",
        "@Orchard summarize",
      ].join("\n"),
    );
    expect(published[0]?.tags).toEqual([
      ["h", channel],
      ["e", root, "", "reply"],
    ]);
  });

  it("answers a Solo chat at its top level, with its recent messages", async () => {
    const { runs, published, read, deliver } = setup({
      channelType: "solo",
      thread: [message("1", "Remember: blue")],
    });
    await deliver(message("2", "What did I say?"));
    expect(read.mock.calls[0]?.[0]).toEqual([
      { kinds: [9, 40002], "#h": [channel], limit: 31 },
    ]);
    expect(runs[0]?.stdin).toContain("Earlier messages in your Solo chat:");
    expect(runs[0]?.stdin).toContain("Alice: Remember: blue");
    expect(published[0]?.tags).toEqual([["h", channel]]);
  });

  it("ignores mentions from others, and watches", async () => {
    const { runs, published, deliver, runtime } = setup();
    const ignored = vi.fn();
    await deliver(message("2", "hi", { pubkey: bob }), { ignored });
    await runtime.run({
      trigger: { type: "timer" },
      ignored,
    } as unknown as Delivery);
    expect(ignored).toHaveBeenCalledTimes(2);
    expect(runs).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("asks again with the latest message alone when the thread is too long", async () => {
    const thread = [message("1", "root", { id: root }), reply("2", "long")];
    const { runs, published, deliver } = setup({
      thread,
      answers: [
        {
          stderr:
            "Error: The session's transcript exceeded the model's context size.\n",
          code: 1,
        },
        { stdout: "Short answer." },
      ],
    });
    await deliver(reply("3", "@Orchard go"));
    expect(runs).toHaveLength(2);
    expect(runs[0]?.stdin).toContain("Earlier messages");
    expect(runs[1]?.stdin).not.toContain("Earlier messages");
    expect(published.map((item) => item.content)).toEqual(["Short answer."]);
  });

  it("clips the latest message when it alone is too long, then reports", async () => {
    // With nothing earlier, the latest message alone is the first prompt.
    const overflow = {
      stderr:
        "Error: The session's transcript exceeded the model's context size.\n",
      code: 1,
    };
    const { runs, published, deliver } = setup({
      answers: [overflow, overflow, overflow],
    });
    await deliver(
      message("2", `@Orchard ${"f".repeat(SHORT_LATEST_CHARS * 2)}`),
    );
    expect(runs).toHaveLength(2);
    expect(
      runs[1]?.stdin.endsWith(`${"f".repeat(SHORT_LATEST_CHARS - 9)}…`),
    ).toBe(true);
    expect(published.map((item) => item.content)).toEqual([
      "⚠️ I couldn't finish that: The session's transcript exceeded the model's context size.",
    ]);
  });

  it("reports a failure in the thread and tags the owner", async () => {
    const { published, deliver } = setup({
      answers: [
        { stderr: "Error: Apple Intelligence is not enabled.\n", code: 1 },
      ],
    });
    const mention = message("2", "@Orchard hi");
    await deliver(mention);
    expect(published).toEqual([
      {
        kind: 9,
        content: "⚠️ I couldn't finish that: Apple Intelligence is not enabled.",
        tags: [
          ["h", channel],
          ["e", mention.id, "", "reply"],
          ["p", alice],
        ],
      },
    ]);
  });

  it("says so when fm answers nothing", async () => {
    const { published, deliver } = setup({ answers: [{ stdout: "  \n" }] });
    await deliver(message("2", "@Orchard hi"));
    expect(published.map((item) => item.content)).toEqual([
      "⚠️ I couldn't finish that: fm gave no answer.",
    ]);
  });

  it("stops fm and posts nothing when the owner stops the turn", async () => {
    const { runs, published, deliver } = setup({ answers: ["hold"] });
    let stop: (() => Promise<void>) | undefined;
    const done = deliver(message("2", "@Orchard write an essay"), {
      interruptible: (next: () => Promise<void>) => {
        stop = next;
      },
    });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    await stop?.();
    await done;
    expect(runs[0]?.killed).toBe(true);
    expect(published).toHaveLength(0);
  });

  it("stops fm when the run is aborted", async () => {
    const { runs, published, deliver } = setup({ answers: ["hold"] });
    const controller = new AbortController();
    const done = deliver(message("2", "@Orchard hi"), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    controller.abort();
    await done;
    expect(runs[0]?.killed).toBe(true);
    expect(published).toHaveLength(0);
  });

  it("stops fm and says so when the turn runs past its deadline", async () => {
    const { runs, published, deliver } = setup({ answers: ["hold"] });
    const controller = new AbortController();
    const done = deliver(message("2", "@Orchard hi"), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await done;
    expect(runs[0]?.killed).toBe(true);
    expect(published.map((item) => item.content)).toEqual([
      "⚠️ I couldn't finish that: fm took longer than 3 minutes.",
    ]);
  });

  it("reports fm ending on a signal nobody here sent", async () => {
    const { published, deliver } = setup({
      answers: [{ stderr: "", code: null }],
    });
    await deliver(message("2", "@Orchard hi"));
    expect(published.map((item) => item.content)).toEqual([
      "⚠️ I couldn't finish that: fm exited with a signal",
    ]);
  });

  it("reads whether the model is available", async () => {
    const { runtime } = setup();
    await expect(runtime.available()).resolves.toEqual({
      ready: true,
      detail: "System model available",
    });
  });

  it("says when this computer has no fm", async () => {
    const { runtime, spawn } = setup();
    spawn.mockRejectedValueOnce(new Error("No such file or directory"));
    const result = await runtime.available();
    expect(result.ready).toBe(false);
    expect(result.detail).toContain("no fm command");
  });
});
