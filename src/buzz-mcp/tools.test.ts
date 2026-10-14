import { expect, it, vi } from "vitest";
import type { BuzzClient, BuzzEvent, Filter, Template } from "./client";
import { respond } from "./rpc";
import { callTool } from "./tools";

const me = "c".repeat(64);
const alice = "a".repeat(64);
const bob = "b".repeat(64);
const root = "1".repeat(64);
const nested = "2".repeat(64);
const event = (fields: Partial<BuzzEvent>): BuzzEvent => ({
  id: "f".repeat(64),
  pubkey: alice,
  created_at: 100,
  kind: 9,
  tags: [["h", "chan"]],
  content: "",
  sig: "",
  ...fields,
});
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A community with `events` in it, answering filters by kind and a few tags. */
function fake(events: readonly BuzzEvent[] = []) {
  const published: Template[] = [];
  const matches = (filter: Filter, item: BuzzEvent) => {
    const tag = (name: string) =>
      item.tags.filter((t) => t[0] === name).map((t) => t[1]);
    return Object.entries(filter).every(([key, value]) => {
      if (key === "kinds") return (value as number[]).includes(item.kind);
      if (key === "ids") return (value as string[]).includes(item.id);
      if (key === "authors") return (value as string[]).includes(item.pubkey);
      if (key.startsWith("#"))
        return (value as string[]).some((v) => tag(key.slice(1)).includes(v));
      return true;
    });
  };
  const client: BuzzClient = {
    pubkey: me,
    query: vi.fn(async (filters: readonly Filter[]) =>
      events.filter((item) => filters.some((filter) => matches(filter, item))),
    ),
    publish: vi.fn(async (template: Template) => {
      published.push(template);
      return event({ ...template, pubkey: me, id: "e".repeat(64) });
    }),
    upload: vi.fn(async (_data: Uint8Array, mime: string) => ({
      url: "https://relay/media/x.png",
      sha256: "ab",
      size: 7,
      type: mime,
      dim: "1x1",
    })),
    read: vi.fn(async (path: string) =>
      path.endsWith(".png") ? PNG : new TextEncoder().encode(`# ${path}`),
    ),
    memories: vi.fn(async () => [
      { slug: "mem/notes", body: "old", createdAt: 50 },
    ]),
    remember: vi.fn(async () => undefined),
    media: vi.fn(async (url: string) =>
      btoa(String.fromCharCode(...(url.endsWith(".png") ? PNG : [1, 2, 3]))),
    ),
  };
  return { client, published };
}

const members = event({
  kind: 39002,
  tags: [
    ["d", "chan"],
    ["p", alice, "", "member"],
    ["p", bob, "", "admin"],
    ["p", me, "", "bot"],
  ],
});
const profile = (pubkey: string, name: string) =>
  event({ kind: 0, pubkey, content: JSON.stringify({ display_name: name }) });
const community = [
  members,
  profile(alice, "Alice Smith"),
  profile(bob, "Bob"),
  event({ id: root }),
  event({
    id: nested,
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
    ],
  }),
];

it("replies in the current thread and notifies the members it names", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    text: "@Alice Smith see `@Bob`",
  });
  expect(published).toEqual([
    {
      kind: 9,
      content: "@Alice Smith see `@Bob`",
      tags: [
        ["h", "chan"],
        ["e", root, "", "reply"],
        ["p", alice],
      ],
    },
  ]);
});

it("tags a message for agents, and needs the audience said", async () => {
  const { client, published } = fake(community);
  const context = { channel: "chan", root };
  await callTool(client, context, "send", {
    text: "@Bob run the suite",
    audience: "agents",
  });
  expect(published[0]?.tags).toEqual([
    ["h", "chan"],
    ["e", root, "", "reply"],
    ["p", bob],
    ["audience", "agents"],
  ]);
  await expect(
    callTool(client, context, "send", { text: "hi" }),
  ).rejects.toThrow("audience must be everyone or agents");
  await expect(
    callTool(client, context, "send", { text: "hi", audience: "humans" }),
  ).rejects.toThrow("audience must be everyone or agents");
  expect(published).toHaveLength(1);
});

it("refuses to post a name it cannot resolve unless told who it means", async () => {
  const { client, published } = fake(community);
  const context = { channel: "chan", root };
  await expect(
    callTool(client, context, "send", {
      audience: "everyone",
      text: "hi @Carol",
    }),
  ).rejects.toThrow("No single channel member is @carol");
  await callTool(client, context, "send", {
    audience: "everyone",
    text: "hi @Carol",
    mentions: [bob],
  });
  expect(published[0]?.tags).toContainEqual(["p", bob]);
});

it("replies to a message inside a thread at the thread's root, and posts a file's text and images", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    reply: nested,
    path: "notes.md",
    files: ["shot.png"],
  });
  expect(published[0]).toEqual({
    kind: 9,
    content: "# notes.md\n![image](https://relay/media/x.png)",
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
      [
        "imeta",
        "url https://relay/media/x.png",
        "m image/png",
        "x ab",
        "size 7",
        "dim 1x1",
      ],
    ],
  });
});

it("posts at the channel's top level when given a channel", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    channel: "other",
    text: "hello",
  });
  expect(published[0]?.tags).toEqual([["h", "other"]]);
});

it("keeps a top-level chat out of threads, wherever a reply would resolve", async () => {
  const elsewhere = "3".repeat(64);
  const { client, published } = fake([
    ...community,
    event({ id: elsewhere, tags: [["h", "other"]] }),
  ]);
  const context = { channel: "chan", topLevel: true };
  const refused = "This chat stays at the top level: send again without reply.";
  // A reply alone takes its target's channel; a stale one is refused too.
  for (const args of [
    { reply: root },
    { reply: nested },
    { reply: root, channel: "chan" },
  ])
    await expect(
      callTool(client, context, "send", {
        audience: "everyone",
        text: "hi",
        ...args,
      }),
    ).rejects.toThrow(refused);
  expect(published).toEqual([]);
  await callTool(client, context, "send", { audience: "everyone", text: "hi" });
  await callTool(client, context, "send", {
    audience: "everyone",
    text: "there",
    reply: elsewhere,
  });
  expect(published.map((sent) => sent.tags)).toEqual([
    [["h", "chan"]],
    [
      ["h", "other"],
      ["e", elsewhere, "", "reply"],
    ],
  ]);
});

it("reads the current thread with each message's latest edit", async () => {
  const { client } = fake([
    ...community,
    event({
      kind: 40003,
      created_at: 120,
      content: "edited",
      tags: [
        ["h", "chan"],
        ["e", nested],
      ],
    }),
  ]);
  const text = (await callTool(
    client,
    { channel: "chan", root },
    "read",
    {},
  )) as string;
  expect(text.split("\n")).toEqual([
    `${root} Alice Smith 1970-01-01T00:01Z: `,
    `${nested} Alice Smith 1970-01-01T00:01Z: edited`,
  ]);
});

it("takes back its own reaction", async () => {
  const reaction = event({
    id: "9".repeat(64),
    kind: 7,
    pubkey: me,
    content: "👍",
    tags: [["e", root]],
  });
  const { client, published } = fake([...community, reaction]);
  await callTool(client, {}, "react", { id: root, emoji: "👍", off: true });
  expect(published).toEqual([
    { kind: 5, content: "", tags: [["e", reaction.id]] },
  ]);
});

it("writes memory under mem/, newer than the entry it replaces", async () => {
  const { client } = fake();
  await callTool(client, {}, "mem_set", { slug: "notes", text: "new" });
  expect(client.remember).toHaveBeenCalledWith("mem/notes", "new", 50);
  await expect(
    callTool(client, {}, "mem_get", { slug: "notes" }),
  ).resolves.toBe("old");
});

it("answers MCP requests, reporting a failed call as a tool error", async () => {
  const { client } = fake(community);
  const init = await respond(
    client,
    {},
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    },
  );
  expect(init).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
  const list = (await respond(
    client,
    {},
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    },
  )) as { result: { tools: { name: string }[] } };
  expect(list.result.tools.map((tool) => tool.name)).toContain("send");
  await expect(
    respond(
      client,
      {},
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send", arguments: { text: "hi" } },
      },
    ),
  ).resolves.toEqual({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ type: "text", text: "channel is required here." }],
      isError: true,
    },
  });
});

it("replies in the channel of the message it answers", async () => {
  const elsewhere = event({ id: "3".repeat(64), tags: [["h", "other"]] });
  const { client, published } = fake([...community, elsewhere]);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    reply: elsewhere.id,
    text: "over here",
  });
  expect(published[0]?.tags).toEqual([
    ["h", "other"],
    ["e", elsewhere.id, "", "reply"],
  ]);
});

it("refuses a memory slug the community would not list", async () => {
  const { client } = fake();
  await expect(
    callTool(client, {}, "mem_set", { slug: "My Notes", text: "x" }),
  ).rejects.toThrow("Bad slug");
});

it("lists its tools before it can call them", async () => {
  const list = (await respond(
    undefined,
    {},
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    },
  )) as { result: { tools: unknown[] } };
  expect(list.result.tools).toHaveLength(13);
  await expect(
    respond(
      undefined,
      {},
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read", arguments: {} },
      },
    ),
  ).resolves.toMatchObject({ result: { isError: true } });
});

it("shows a media image to the agent, and nothing else", async () => {
  const { client } = fake();
  const png = btoa(String.fromCharCode(...PNG));
  await expect(
    respond(
      client,
      {},
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "media_get", arguments: { url: "abc.png" } },
      },
    ),
  ).resolves.toEqual({
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "image", data: png, mimeType: "image/png" }] },
  });
  expect(client.media).toHaveBeenCalledWith("abc.png");
  await expect(
    callTool(client, {}, "media_get", { url: "abc.txt" }),
  ).rejects.toThrow("Only JPEG, PNG, GIF and WebP");
});

const room = "0e4c2f1a-8b3d-4c5e-9f60-718293a4b5c6";
type Tags = readonly (readonly string[])[];
/** A community that makes the channel changes it accepts, refusing any that
 * target a pubkey in `refused`. */
function relay(refused: Readonly<Record<string, string>> = {}) {
  const state: BuzzEvent[] = [
    event({
      kind: 39000,
      tags: [
        ["d", room],
        ["name", "plans"],
        ["about", "roadmap"],
        ["t", "stream"],
      ],
    }),
    event({
      kind: 39002,
      tags: [
        ["d", room],
        ["p", me, "", "owner"],
        ["p", alice, "", "member"],
      ],
    }),
    profile(alice, "Alice Smith"),
  ];
  const { client, published } = fake(state);
  /** Replaces channel `id`'s state event of `kind` with one tagged anew. */
  const put = (kind: number, id: string, change: (tags: Tags) => Tags) => {
    const at = state.findIndex((e) => e.kind === kind && e.tags[0]?.[1] === id);
    const now = state[at];
    if (now)
      state[at] = { ...now, tags: [["d", id], ...change(now.tags.slice(1))] };
  };
  const without = (tags: Tags, key: string) =>
    tags.filter((t) => t[0] !== key && t[1] !== key);
  client.publish = vi.fn(async (template: Template) => {
    const id = template.tags.find((t) => t[0] === "h")?.[1] ?? "";
    const target = template.tags.find((t) => t[0] === "p")?.[1] ?? "";
    if (refused[target]) throw new Error(refused[target]);
    published.push(template);
    const { kind } = template;
    if (kind === 9007)
      state.push(
        event({ kind: 39000, tags: [["d", id], ...template.tags.slice(1)] }),
        event({
          kind: 39002,
          tags: [
            ["d", id],
            ["p", me, "", "owner"],
          ],
        }),
      );
    if (kind === 9000 || kind === 9021) {
      const key = kind === 9021 ? me : target;
      const role = template.tags.find((t) => t[0] === "role")?.[1] ?? "member";
      put(39002, id, (tags) => [...without(tags, key), ["p", key, "", role]]);
    }
    if (kind === 9001 || kind === 9022)
      put(39002, id, (tags) => without(tags, kind === 9022 ? me : target));
    if (kind === 9002)
      for (const [key = "", value = ""] of template.tags.slice(1))
        put(39000, id, (tags) => {
          if (key === "visibility")
            return [
              ...without(tags, "private"),
              ...(value === "private" ? [["private"]] : []),
            ];
          return [
            ...without(tags, key),
            ...(value && value !== "false" ? [[key, value]] : []),
          ];
        });
    if (kind === 9008)
      state.splice(
        0,
        state.length,
        ...state.filter((e) => e.tags[0]?.[1] !== id),
      );
    return event({ ...template, pubkey: me, id: "e".repeat(64) });
  });
  return { client, published, state };
}

it("lists channels it can join as well as its own", async () => {
  const { client, state } = relay();
  state.push(
    event({
      kind: 39000,
      tags: [["d", "other"], ["name", "lobby"], ["t", "forum"], ["private"]],
    }),
  );
  await expect(callTool(client, {}, "channels", { all: true })).resolves.toBe(
    `${room} plans\nother lobby (forum, private, not joined)`,
  );
  await expect(callTool(client, {}, "channels", {})).resolves.toBe(
    `${room} plans`,
  );
});

it("creates a channel from its owner's template, reporting each agent it could not add", async () => {
  const { client, published } = relay({
    [bob]: "policy:owner_only — only the agent owner can add this agent",
  });
  client.templates = vi.fn(async () => [
    { name: "Launch", canvas: "# Plan", agents: [alice, bob, me] },
  ]);
  const answer = await callTool(client, {}, "channel", {
    action: "create",
    name: "#launch ",
    visibility: "private",
    template: "launch",
  });
  const id = published[0]?.tags[0]?.[1] as string;
  expect(published).toEqual([
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "launch"],
        ["visibility", "private"],
        ["channel_type", "stream"],
      ],
    },
    {
      kind: 40100,
      content: "# Plan",
      tags: [
        ["h", id],
        ["expected-revision", "none"],
      ],
    },
    {
      kind: 9000,
      content: "",
      tags: [
        ["h", id],
        ["p", alice],
      ],
    },
  ]);
  expect(answer).toBe(
    [
      `created ${id}`,
      "started the Canvas",
      `added ${alice} Alice Smith`,
      `not added ${bob}: policy:owner_only — only the agent owner can add this agent`,
    ].join("\n"),
  );
});

it("adds no template agents when it cannot start the Canvas", async () => {
  const { client, published } = relay();
  const publish = client.publish;
  client.publish = vi.fn(async (template: Template) => {
    if (template.kind === 40100) throw new Error("canvas refused");
    return publish(template);
  });
  client.templates = vi.fn(async () => [
    { name: "Launch", canvas: "# Plan", agents: [alice] },
  ]);
  const answer = await callTool(client, {}, "channel", {
    action: "create",
    name: "launch",
    visibility: "private",
    template: "Launch",
  });
  const id = published[0]?.tags[0]?.[1] as string;
  expect(published.map((template) => template.kind)).toEqual([9007]);
  expect(answer).toBe(
    `created ${id}\nCanvas not started, so no agents were added: canvas refused`,
  );
});

it("creates nothing from a template it cannot name exactly", async () => {
  const { client, published } = relay();
  const create = (template: string) =>
    callTool(client, {}, "channel", {
      action: "create",
      name: "x",
      visibility: "open",
      template,
    });
  await expect(create("a")).rejects.toThrow(
    "Channel templates are kept in Buzz Desktop and are unavailable here.",
  );
  client.templates = vi.fn(async () => [
    { name: "Team", canvas: "", agents: [] },
    { name: "team", canvas: "", agents: [] },
  ]);
  await expect(create("TEAM")).rejects.toThrow(
    "2 templates are named TEAM; your owner should rename one.",
  );
  await expect(create("other")).rejects.toThrow(
    "No template named other. Templates: Team, team.",
  );
  expect(published).toEqual([]);
});

it("refuses channel arguments that do not fit, before publishing", async () => {
  const { client, published } = relay();
  const channel = (args: Record<string, unknown>) =>
    callTool(client, { channel: room }, "channel", args);
  await expect(channel({ action: "toString" })).rejects.toThrow(
    "action must be one of",
  );
  await expect(channel({ action: "join", name: "x" })).rejects.toThrow(
    "name cannot be used with join.",
  );
  await expect(
    channel({ action: "create", channel: room, name: "x", visibility: "open" }),
  ).rejects.toThrow("leave out channel");
  await expect(channel({ action: "create", name: "x" })).rejects.toThrow(
    "visibility must be open or private.",
  );
  await expect(
    channel({ action: "create", name: "#", visibility: "open" }),
  ).rejects.toThrow("Enter a channel name");
  await expect(
    channel({ action: "create", name: "x", visibility: "open", ttl: 1.5 }),
  ).rejects.toThrow("ttl must be a whole number of seconds.");
  await expect(channel({ action: "update" })).rejects.toThrow(
    "Give name, about, visibility, ttl, topic or purpose.",
  );
  await expect(
    callTool(client, { channel: "chan" }, "channel", { action: "leave" }),
  ).rejects.toThrow("Invalid channel ID");
  expect(published).toEqual([]);
});

it("shows a channel's details and changes them as the channel shows", async () => {
  const { client, published } = relay();
  const context = { channel: room };
  await expect(callTool(client, context, "channel", {})).resolves.toBe(
    `${room} plans (stream, open)\nabout: roadmap\nyou: owner`,
  );
  await expect(
    callTool(client, context, "channel", {
      action: "update",
      name: "launch",
      about: "",
      visibility: "private",
      ttl: 3600,
    }),
  ).resolves.toBe(`updated ${room}`);
  expect(published[0]?.tags).toEqual([
    ["h", room],
    ["name", "launch"],
    ["about", ""],
    ["visibility", "private"],
    ["ttl", "3600"],
  ]);
  await expect(callTool(client, context, "channel", {})).resolves.toBe(
    `${room} launch (stream, private, archives after 3600s idle)\nyou: owner`,
  );
  await expect(
    callTool(client, { channel: "gone" }, "channel", {}),
  ).rejects.toThrow("No channel gone that you can see.");
});

it("changes only the name of a session", async () => {
  const { client, state, published } = relay();
  state[0] = event({
    kind: 39000,
    tags: [
      ["d", room],
      ["about", "Buzz session (buzz.sessions/v1)"],
    ],
  });
  await expect(
    callTool(client, { channel: room }, "channel", {
      action: "update",
      topic: "x",
    }),
  ).rejects.toThrow("Only the name of a session can be changed.");
  expect(published).toEqual([]);
});

it("leaves, joins, archives, unarchives and deletes a channel", async () => {
  const { client, published } = relay();
  const context = { channel: room };
  for (const [action, done] of [
    ["leave", "left"],
    ["join", "joined"],
    ["archive", "archived"],
    ["unarchive", "unarchived"],
    ["delete", "deleted"],
  ])
    await expect(
      callTool(client, context, "channel", { action }),
    ).resolves.toBe(`${done} ${room}`);
  expect(published.map((template) => template.kind)).toEqual([
    9022, 9021, 9002, 9002, 9008,
  ]);
  expect(published[2]?.tags).toEqual([
    ["h", room],
    ["archived", "true"],
  ]);
});

it("reports a change the community accepted but does not show", async () => {
  vi.useFakeTimers();
  try {
    const { client } = fake([]);
    const answer = callTool(client, { channel: room }, "channel", {
      action: "archive",
    });
    await vi.runAllTimersAsync();
    await expect(answer).resolves.toBe(
      "The community accepted archive but does not show it yet.",
    );
    expect(client.query).toHaveBeenCalledTimes(5);
  } finally {
    vi.useRealTimers();
  }
});

it("adds members with a role and removes others, reporting each", async () => {
  const { client, published } = relay({ [nested]: "restricted: not an admin" });
  const answer = await callTool(client, { channel: room }, "members", {
    add: [bob, nested],
    remove: [alice],
    role: "admin",
  });
  expect(published).toEqual([
    {
      kind: 9000,
      content: "",
      tags: [
        ["h", room],
        ["p", bob],
        ["role", "admin"],
      ],
    },
    {
      kind: 9001,
      content: "",
      tags: [
        ["h", room],
        ["p", alice],
      ],
    },
  ]);
  expect(answer).toBe(
    [
      `added ${bob} as admin`,
      `not added ${nested}: restricted: not an admin`,
      `removed ${alice} Alice Smith`,
    ].join("\n"),
  );
  await expect(
    callTool(client, { channel: room }, "members", { add: [nested] }),
  ).rejects.toThrow(`not added ${nested}: restricted: not an admin`);
});

it("changes each member once, however their key is written", async () => {
  const { client, published } = relay();
  const answer = await callTool(client, { channel: room }, "members", {
    add: [bob, bob.toUpperCase()],
    remove: [alice, alice.toUpperCase()],
  });
  expect(published.map((template) => template.kind)).toEqual([9000, 9001]);
  expect(answer).toBe(`added ${bob}\nremoved ${alice} Alice Smith`);
});

it("refuses member changes that do not fit, before publishing", async () => {
  const { client, published } = relay();
  const members = (args: Record<string, unknown>) =>
    callTool(client, { channel: room }, "members", args);
  await expect(members({ add: [me] })).rejects.toThrow(
    "For yourself, use channel with action join or leave.",
  );
  await expect(members({ add: [bob], remove: [bob] })).rejects.toThrow(
    "Add or remove someone, not both.",
  );
  await expect(members({ add: ["Bob"] })).rejects.toThrow("Not a pubkey: Bob");
  await expect(members({ add: [bob], role: "root" })).rejects.toThrow(
    "role must be one of owner, admin, member, guest, bot.",
  );
  await expect(members({ remove: [alice], role: "admin" })).rejects.toThrow(
    "role is for the members you add.",
  );
  expect(published).toEqual([]);
});

it("defaults to the current channel only when channel is left out", async () => {
  const { client, published } = relay();
  const call = (name: string, args: Record<string, unknown>) =>
    respond(
      client,
      { channel: room },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
    );
  for (const [name, args, message] of [
    [
      "channel",
      { action: "delete", channel: 123 },
      "channel must be a channel ID.",
    ],
    [
      "channel",
      { action: "delete", channel: "   " },
      "channel must be a channel ID.",
    ],
    ["channel", { action: 5 }, "action must be one of"],
    [
      "members",
      { channel: null, remove: [alice] },
      "channel must be a channel ID.",
    ],
    ["members", { remove: [alice, 123] }, "remove must be a list of pubkeys."],
    ["members", { add: alice }, "add must be a list of pubkeys."],
    [
      "channel",
      { action: "create", name: "x", visibility: "open", about: 5 },
      "about must be text.",
    ],
  ] as const)
    await expect(call(name, args)).resolves.toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining(message) }],
      },
    });
  expect(published).toEqual([]);
});

it("keeps what it changed when a read after the change fails", async () => {
  const { client, published } = relay();
  const query = client.query;
  let failing = [0];
  client.query = vi.fn(async (filters: readonly Filter[]) => {
    if (
      filters.some((f) =>
        (f.kinds as number[]).some((kind) => failing.includes(kind)),
      )
    )
      throw new Error(`kind ${failing} unavailable`);
    return query(filters);
  });
  client.templates = vi.fn(async () => [
    { name: "Launch", canvas: "", agents: [bob] },
  ]);
  const create = () =>
    callTool(client, {}, "channel", {
      action: "create",
      name: "launch",
      visibility: "open",
      template: "Launch",
    });
  // A display name that cannot be read leaves the pubkey.
  let answer = await create();
  let id = published.at(-2)?.tags[0]?.[1] as string;
  expect(answer).toBe(`created ${id}\nadded ${bob}`);
  // A roster that cannot be read leaves each accepted change unconfirmed.
  failing = [39002];
  answer = await create();
  id = published.at(-2)?.tags[0]?.[1] as string;
  expect(answer).toBe(
    `created ${id}\n${bob}: the community accepted it but its state could not be read back: kind 39002 unavailable`,
  );
  // A channel that cannot be read back still names the channel created.
  failing = [39000];
  answer = await create();
  id = published.at(-1)?.tags[0]?.[1] as string;
  expect(published.at(-1)?.kind).toBe(9007);
  expect(answer).toBe(
    `The community accepted channel ${id} but its state could not be read back: kind 39000 unavailable; the template was not applied.`,
  );
  await expect(
    callTool(client, { channel: room }, "channel", { action: "archive" }),
  ).resolves.toBe(
    "The community accepted archive but its state could not be read back: kind 39000 unavailable.",
  );
  await expect(
    callTool(client, { channel: room }, "channel", {
      action: "update",
      topic: "x",
    }),
  ).rejects.toThrow("kind 39000 unavailable");
});
