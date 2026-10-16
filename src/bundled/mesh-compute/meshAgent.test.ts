import { describe, expect, it, vi } from "vitest";
import type { Delivery } from "../../features/agents/service";
import {
  compileFilter,
  watchMatches,
  type EventWatch,
} from "../../features/agents/attention";
import {
  conversationKey,
  instructions,
  type MeshAgentConfig,
  type MeshAgentDeps,
  MeshAgentRuntime,
  meshAgentConfig,
} from "./meshAgent";
import type { InlineTurn } from "./inlineAgent";

const OWNER = "a".repeat(64);
const AGENT = "b".repeat(64);
const EVENT = {
  id: "c".repeat(64),
  pubkey: OWNER,
  kind: 9,
  created_at: 1,
  content: "hello",
  tags: [["h", "chan"]],
  sig: "",
};

function setup(
  over: Partial<MeshAgentDeps> = {},
  from = OWNER,
  config: object = { prompt: "be brief", mode: "agent", buzz: false },
) {
  const inline = {
    run: vi.fn(async (_input: InlineTurn) => ({ text: "hi from mesh" })),
    dispose: vi.fn(),
  };
  const publish = vi.fn(async (event: object) => event);
  const query = vi.fn(async (_filters: unknown) => [] as object[]);
  const deps: MeshAgentDeps = {
    inline,
    spawn: vi.fn(async (_id, options) => {
      options?.onStdout?.("/home/u/.buzz\n");
      return {
        exited: Promise.resolve(0),
        write: async () => {},
        end: async () => {},
        kill: async () => {},
      };
    }),
    origin: () => "https://community.example",
    prepare: async () => ({
      baseUrl: "http://127.0.0.1:19337/v1",
      model: "mesh",
      lease: "L1",
    }),
    current: async () => true,
    chat: vi.fn(async () => "chat answer"),
    ...over,
  };
  const delivery = (event: object = {}) =>
    ({
      trigger: { type: "mention", event: { ...EVENT, pubkey: from, ...event } },
      channelId: "chan",
      agent: { pubkey: AGENT, name: "M", owner: OWNER, publish, query },
      config,
      signal: new AbortController().signal,
    }) as unknown as Delivery<MeshAgentConfig>;
  const runtime = new MeshAgentRuntime(deps);
  return { deps, delivery, publish, query, inline, runtime };
}
const inThread = (id: string, at: number) => ({
  id,
  created_at: at,
  tags: [
    ["h", "chan"],
    ["e", "9".repeat(64), "", "root"],
    ["e", "9".repeat(64), "", "reply"],
  ],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Mesh agent runtime", () => {
  it("answers in chat mode with one completion and no inline agent", async () => {
    const chat = vi.fn(async () => "chat answer");
    const { delivery, publish, query, inline, runtime } = setup(
      { chat },
      OWNER,
      {
        prompt: "summarize",
        mode: "chat",
      },
    );
    query.mockResolvedValueOnce([
      { ...EVENT, id: "9".repeat(64), content: "root", created_at: 0 },
      {
        ...EVENT,
        pubkey: AGENT,
        content: "earlier answer",
        ...inThread("2".repeat(64), 1),
      },
    ]);
    await runtime.run(delivery(inThread("1".repeat(64), 2)));
    expect(inline.run).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ lease: "L1" }),
      [
        { role: "system", content: "summarize" },
        { role: "user", content: "[aaaaaaaa] root" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "[aaaaaaaa] hello" },
      ],
    );
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: "chat answer",
    });
  });

  it("drops a reply whose lease went stale mid-turn", async () => {
    const { delivery, publish, runtime } = setup({
      current: async () => false,
    });
    await runtime.run(delivery());
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports unavailable shared compute instead of falling back", async () => {
    const spawn = vi.fn();
    const { delivery, publish, runtime } = setup({
      spawn,
      prepare: async () => {
        throw new Error("Shared compute inference did not become ready");
      },
    });
    await runtime.run(delivery());
    expect(spawn).not.toHaveBeenCalled();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining("did not become ready"),
    });
  });

  it("ignores anyone but its owner", async () => {
    const { delivery, publish, runtime } = setup({}, "d".repeat(64));
    await runtime.run(delivery());
    expect(publish).not.toHaveBeenCalled();
  });

  it("answers the owner's watched reply in Chat mode, in the same thread", async () => {
    const sender = OWNER;
    const { delivery, publish, query, deps, inline, runtime } = setup(
      {},
      sender,
      {
        mode: "chat",
        prompt: "You are Palmer. Be concise.",
      },
    );
    query.mockResolvedValue([
      { ...EVENT, id: "9".repeat(64), content: "Which MUD is best?" },
    ]);
    const watch: EventWatch = {
      type: "event",
      interest_id: "follow",
      enabled: true,
      since: 1,
      channels: ["chan"],
      kinds: [9],
      filter: `author == "${sender}"`,
    };
    const reply = delivery({
      ...inThread("e".repeat(64), 2),
      content: "I recommend a time-travel MUD with branching histories.",
    });
    if (reply.trigger.type !== "mention") throw new Error("Expected message");
    const filter = compileFilter(watch.filter ?? "");
    expect(
      watchMatches(
        watch,
        { ...reply.trigger.event, pubkey: "d".repeat(64) },
        filter,
      ),
    ).toBe(false);
    expect(
      watchMatches(watch, { ...reply.trigger.event, pubkey: AGENT }, filter),
    ).toBe(false);
    expect(watchMatches(watch, reply.trigger.event, filter)).toBe(true);
    await runtime.run({
      ...reply,
      trigger: {
        ...reply.trigger,
        type: "watch",
        slug: "watch/follow",
        watch,
        interest: {
          type: "interest",
          instructions:
            "Respond to Moonpal's idea with one concrete improvement.",
        },
      },
    });
    expect(deps.chat).toHaveBeenCalledTimes(1);
    const messages = vi.mocked(deps.chat).mock.calls[0]?.[1];
    expect(messages?.[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining(
        "Respond to Moonpal's idea with one concrete improvement.",
      ),
    });
    expect(messages?.[0]?.content).toContain("You are Palmer. Be concise.");
    expect(messages?.[0]?.content).toContain("earlier messages are context");
    expect(messages?.at(-1)).toEqual({
      role: "user",
      content:
        "[aaaaaaaa] I recommend a time-travel MUD with branching histories.",
    });
    expect(inline.run).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "chat answer",
        tags: [
          ["h", "chan"],
          ["e", "9".repeat(64), "", "root"],
          ["e", "e".repeat(64), "", "reply"],
          ["p", sender],
        ],
      }),
    );
    // A later direct request must not inherit the previous watch's instructions.
    await runtime.run(
      delivery({ ...inThread("f".repeat(64), 3), pubkey: OWNER }),
    );
    expect(vi.mocked(deps.chat).mock.calls[1]?.[1]?.[0]).toEqual({
      role: "system",
      content: "You are Palmer. Be concise.",
    });
  });

  it.each([
    ["chat", "d".repeat(64), `author == "${"d".repeat(64)}"`],
    ["agent", "d".repeat(64), `author == "${"d".repeat(64)}"`],
    ["chat", "d".repeat(64), undefined],
    ["chat", "d".repeat(64), "true"],
    ["chat", "d".repeat(64), `author == "${"e".repeat(64)}"`],
    ["chat", "d".repeat(64), `author == "${"d".repeat(64)}" || true`],
    ["chat", AGENT, `author == "${AGENT}"`],
  ])(
    "refuses a non-owner watch in %s mode from %s with filter %s",
    async (mode, sender, filter) => {
      const { delivery, deps, publish, runtime } = setup({}, sender, { mode });
      const turn = delivery();
      if (turn.trigger.type !== "mention") throw new Error("Expected message");
      await runtime.run({
        ...turn,
        trigger: {
          ...turn.trigger,
          type: "watch",
          slug: "watch/follow",
          watch: {
            type: "event",
            interest_id: "follow",
            enabled: true,
            since: 1,
            channels: "all",
            kinds: [9],
            ...(filter === undefined ? {} : { filter }),
          },
        },
      });
      expect(deps.chat).not.toHaveBeenCalled();
      expect(deps.spawn).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("keys conversations like Codex and Claude Code", () => {
    const reply = { ...EVENT, ...inThread("1".repeat(64), 2) };
    expect(conversationKey("chan", reply, false, "thread")).toBe(
      `chan/${"9".repeat(64)}`,
    );
    expect(conversationKey("chan", EVENT, false, "thread")).toBe(
      `chan/${EVENT.id}`,
    );
    expect(conversationKey("chan", reply, false, "channel")).toBe("chan");
    expect(conversationKey("chan", reply, true, "thread")).toBe("chan");
  });

  it("defaults to an agent with Buzz access, thread sessions and a ~/.buzz workspace", () => {
    expect(meshAgentConfig({})).toMatchObject({
      mode: "agent",
      scope: "thread",
      workspace: "~/.buzz",
    });
    expect(meshAgentConfig({ workspace: "relative" }).workspace).toBe(
      "~/.buzz",
    );
    expect(meshAgentConfig({ buzz: false })).not.toHaveProperty("buzz");
    expect(meshAgentConfig({ mode: "chat" }).mode).toBe("chat");
    expect(meshAgentConfig({ preset: "nope" }).preset).toBeUndefined();
  });

  it("gives Buzz access automatic response delivery guidance", () => {
    const tools = instructions(meshAgentConfig({ prompt: "be brief" }));
    expect(tools).not.toContain("## Posting Conventions");
    expect(tools).toContain("final prose response is automatically delivered");
    expect(tools).not.toContain("Engineering Discipline");
    expect(tools).not.toContain("pass `final: true`");
    expect(tools.length).toBeLessThan(2_000);
    expect(tools).toContain(
      "<agent-instructions>\nbe brief\n</agent-instructions>",
    );
    expect(
      instructions(meshAgentConfig({ prompt: "be brief", mode: "chat" })),
    ).toBe("be brief");
  });

  it.each(["chat", "agent"])(
    "%s posts directly in DMs without thread tags",
    async (mode) => {
      const { runtime, delivery, publish } = setup({ dm: () => true }, OWNER, {
        mode,
        buzz: false,
      });
      try {
        await runtime.run(delivery());
        expect(publish.mock.calls[0]?.[0]).toMatchObject({
          tags: [
            ["h", "chan"],
            ["p", OWNER],
          ],
        });
      } finally {
        runtime.dispose();
      }
    },
  );

  it.each(["chat", "agent"])(
    "%s aborts held history and the next turn recovers",
    async (mode) => {
      const { runtime, delivery, query, inline, deps, publish } = setup(
        {},
        OWNER,
        { mode, buzz: false },
      );
      let release!: (value: object[]) => void;
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      query.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const controller = new AbortController();
      const turn = runtime.run({
        ...delivery(inThread("d".repeat(64), 2)),
        signal: controller.signal,
      });
      try {
        await reading;
        controller.abort();
        await turn;
        expect(inline.run).not.toHaveBeenCalled();
        expect(deps.chat).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        release([]);
        await runtime.run(delivery(inThread("e".repeat(64), 3)));
        expect(publish).toHaveBeenCalledTimes(1);
      } finally {
        release([]);
        runtime.dispose();
      }
    },
  );

  it.each([false, true])(
    "posts final prose independently of optional sends (DM %s)",
    async (dm) => {
      const { runtime, delivery, inline, publish } = setup({ dm: () => dm });
      inline.run.mockImplementationOnce(async ({ delivery, context }) => {
        expect(context).toEqual({
          channel: "chan",
          ...(dm ? {} : { root: EVENT.id }),
        });
        await delivery.agent.publish({
          kind: 9,
          content: "optional update",
          tags: [["h", "chan"]],
        });
        return { text: '```json\n{"answer":42}\n```' };
      });
      await runtime.run(delivery());
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls[1]?.[0]).toEqual({
        kind: 9,
        content: '```json\n{"answer":42}\n```',
        tags: [
          ["h", "chan"],
          ...(dm ? [] : [["e", EVENT.id, "", "reply"]]),
          ["p", OWNER],
        ],
      });
    },
  );

  it("routes an owner's Me chat like a DM, deciding once per delivery", async () => {
    const meChat = vi.fn(async () => true);
    const { runtime, delivery, inline, publish } = setup({ meChat });
    inline.run.mockImplementation(async ({ context }) => {
      expect(context).toEqual({ channel: "chan" });
      return { text: "done" };
    });
    await runtime.run(delivery());
    await runtime.run(delivery());
    expect(meChat).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({
      kind: 9,
      content: "done",
      tags: [
        ["h", "chan"],
        ["p", OWNER],
      ],
    });
  });

  it("keeps the admitted Me decision when placement changes while queued", async () => {
    let me = true;
    const meChat = vi.fn(async () => me);
    const { runtime, delivery, inline, publish } = setup({ meChat });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    inline.run.mockImplementation(async () => {
      await gate;
      return { text: "done" };
    });
    const first = runtime.run(delivery());
    await vi.waitFor(() => expect(inline.run).toHaveBeenCalledTimes(1));
    me = false;
    release();
    await first;
    expect(meChat).toHaveBeenCalledTimes(1);
    expect(inline.run.mock.calls[0]?.[0].context).toEqual({ channel: "chan" });
    expect(publish).toHaveBeenLastCalledWith({
      kind: 9,
      content: "done",
      tags: [
        ["h", "chan"],
        ["p", OWNER],
      ],
    });
  });

  it("does not answer when the Me placement can't be read", async () => {
    const { runtime, delivery, inline, publish } = setup({
      meChat: async () => {
        throw new Error("placement unreadable");
      },
    });
    await expect(runtime.run(delivery())).rejects.toThrow(
      "placement unreadable",
    );
    expect(inline.run).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports missing final prose without replacing it with optional sends", async () => {
    const { runtime, delivery, inline, publish } = setup();
    inline.run.mockResolvedValueOnce({ text: "" });
    await runtime.run(delivery());
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "⚠️ Mesh agent couldn't answer: The mesh model returned no text",
      }),
    );
  });

  it.each(["thread", "channel", "dm"])(
    "retrieves fresh %s history for each turn",
    async (scope) => {
      const { runtime, delivery, inline, query } = setup(
        { dm: () => scope === "dm" },
        OWNER,
        { scope, workspace: "/work" },
      );
      const root = { ...EVENT, id: "9".repeat(64), content: "root" };
      const answer = {
        ...EVENT,
        ...inThread("answer", 2),
        pubkey: AGENT,
        content: "earlier answer",
      };
      const event = { ...EVENT, ...inThread("latest", 3), content: "latest" };
      query.mockResolvedValue([answer, root, root, event]);
      await runtime.run(delivery(event));
      await runtime.run(
        delivery({ ...inThread("next", 4), content: "follow-up" }),
      );
      expect(query.mock.calls[0]).toEqual([
        scope === "thread"
          ? [
              {
                kinds: [9],
                "#h": ["chan"],
                until: 3,
                ids: [root.id],
                limit: 1,
              },
              {
                kinds: [9],
                "#h": ["chan"],
                until: 3,
                "#e": [root.id],
                limit: 50,
              },
            ]
          : [{ kinds: [9], "#h": ["chan"], until: 3, limit: 50 }],
      ]);
      expect(inline.run.mock.calls[0]?.[0].prompt).toBe(
        "Earlier in this conversation:\n[aaaaaaaa] root\n[bbbbbbbb] earlier answer\n\nLatest message from [aaaaaaaa]:\nlatest",
      );
      expect(inline.run.mock.calls[1]?.[0].prompt).toContain("earlier answer");
      expect(inline.run.mock.calls[1]?.[0].prompt).toContain("follow-up");
      expect(inline.run.mock.calls[0]?.[0].cwd).toBe("/work");
    },
  );

  it("refreshes core memory and ignores the retired Buzz-access flag", async () => {
    const coreMemory = vi
      .fn()
      .mockResolvedValueOnce("first memory")
      .mockResolvedValue("updated memory");
    const { runtime, delivery, inline } = setup({ coreMemory }, OWNER, {});
    await runtime.run(delivery());
    await runtime.run(delivery());
    await runtime.run({
      ...delivery(),
      config: meshAgentConfig({ buzz: false }),
    });
    expect(inline.run.mock.calls[0]?.[0].system).toContain("first memory");
    expect(inline.run.mock.calls[1]?.[0].system).toContain("updated memory");
    expect(inline.run.mock.calls[2]?.[0].system).toContain("updated memory");
    expect(coreMemory).toHaveBeenCalledTimes(3);
  });

  it("queues follow-ups while other conversations proceed independently", async () => {
    const { runtime, delivery, inline, publish } = setup();
    const gate = deferred<{ text: string }>();
    const started = deferred<void>();
    inline.run.mockImplementationOnce(() => {
      started.resolve();
      return gate.promise;
    });
    const first = runtime.run(delivery(inThread("first", 2)));
    await started.promise;
    const followup = runtime.run(
      delivery({ ...inThread("second", 3), content: "follow-up" }),
    );
    try {
      await runtime.run(delivery({ id: "other" }));
      expect(inline.run).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve({ text: "first answer" });
    }
    await Promise.all([first, followup]);
    expect(inline.run).toHaveBeenCalledTimes(3);
    expect(inline.run.mock.calls[2]?.[0].prompt).toContain("follow-up");
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it.each(["abort", "dispose", "retire"])(
    "drops an active result after %s and fences queued work",
    async (action) => {
      const { runtime, delivery, inline, publish } = setup();
      const gate = deferred<{ text: string }>();
      const started = deferred<void>();
      const controller = new AbortController();
      let current = true;
      inline.run.mockImplementationOnce(({ delivery }) => {
        expect(delivery.signal).toBe(controller.signal);
        started.resolve();
        return gate.promise;
      });
      const first = runtime.run({
        ...delivery(),
        signal: controller.signal,
        current: () => current,
      });
      await started.promise;
      const next = runtime.run({
        ...delivery(),
        signal: controller.signal,
        current: () => current,
      });
      try {
        if (action === "abort") controller.abort();
        else if (action === "dispose") runtime.dispose();
        else current = false;
      } finally {
        gate.resolve({ text: "late answer" });
      }
      await Promise.all([first, next]);
      expect(publish).not.toHaveBeenCalled();
      expect(inline.run).toHaveBeenCalledTimes(1);
      if (action === "dispose") expect(inline.dispose).toHaveBeenCalledOnce();
      else {
        await runtime.run(delivery());
        expect(publish).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each(["prepare", "memory"])(
    "cancels held %s before inference and recovers",
    async (stage) => {
      const gate = deferred<void>();
      const started = deferred<void>();
      const { runtime, delivery, inline, deps, publish } = setup({}, OWNER, {});
      const prepare = deps.prepare;
      if (stage === "prepare")
        vi.spyOn(deps, "prepare").mockImplementationOnce(async (origin) => {
          started.resolve();
          await gate.promise;
          return prepare(origin);
        });
      else
        Object.assign(deps, {
          coreMemory: vi.fn().mockImplementationOnce(async () => {
            started.resolve();
            await gate.promise;
            return "memory";
          }),
        });
      const controller = new AbortController();
      const first = runtime.run({ ...delivery(), signal: controller.signal });
      try {
        await started.promise;
        controller.abort();
        await first;
        expect(inline.run).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
      }
      await runtime.run(delivery());
      expect(publish).toHaveBeenCalledTimes(1);
    },
  );

  it("reports inline failure and still runs the next queued turn", async () => {
    const { runtime, delivery, inline, publish } = setup();
    inline.run.mockRejectedValueOnce(new Error("inference failed"));
    await Promise.all([runtime.run(delivery()), runtime.run(delivery())]);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      content: "⚠️ Mesh agent couldn't answer: inference failed",
    });
    expect(publish.mock.calls[1]?.[0]).toMatchObject({
      content: "hi from mesh",
    });
  });
});
