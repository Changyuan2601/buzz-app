import { expect, it, vi } from "vitest";
import type { BuzzClient, BuzzEvent, Filter, Memory, Template } from "./client";
import { respond } from "./rpc";
import { ATTENTION_TOOLS } from "./attention";
import { callTool, TOOLS } from "./tools";

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

/** A community with `events` in it, answering filters by kind and a few tags,
 * newest first and a page at a time, as the relay does. */
function fake(events: readonly BuzzEvent[] = []) {
  const published: Template[] = [];
  const matches = (filter: Filter, item: BuzzEvent) => {
    const tag = (name: string) =>
      item.tags.filter((t) => t[0] === name).map((t) => t[1]);
    const { until, before_id } = filter as {
      until?: number;
      before_id?: string;
    };
    if (until !== undefined && item.created_at > until) return false;
    if (item.created_at === until && before_id && item.id <= before_id)
      return false;
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
    query: vi.fn(async (filters: readonly Filter[]) => {
      const newest = [...events].sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      );
      const found = filters.map((filter) =>
        newest
          .filter((item) => matches(filter, item))
          .slice(0, (filter.limit as number | undefined) ?? Infinity),
      );
      return newest.filter((item) => found.some((page) => page.includes(item)));
    }),
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
    memories: vi.fn(async () => ({
      entries: [{ slug: "mem/notes", body: "old", createdAt: 50 }],
      partial: false,
    })),
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
  // Both read the one entry by its slug, not the whole listing.
  expect(vi.mocked(client.memories).mock.calls).toEqual([
    ["mem/notes"],
    ["mem/notes"],
  ]);
});

it("never reports memory cut short by a limit as missing", async () => {
  const { client } = fake();
  const partial = (entries: Memory[]) =>
    vi.mocked(client.memories).mockResolvedValue({ entries, partial: true });
  partial([]);
  await expect(callTool(client, {}, "mem_get", {})).rejects.toThrow(
    "Memory could not be read; try again.",
  );
  await expect(
    callTool(client, {}, "mem_get", { slug: "notes" }),
  ).rejects.toThrow("Memory mem/notes could not be read; try again.");
  // A write needs the entry it replaces: a partial read that missed it, or a
  // failed read, writes nothing.
  await expect(
    callTool(client, {}, "mem_set", { slug: "notes", text: "new" }),
  ).rejects.toThrow("Memory mem/notes could not be read; try again.");
  // A failed lookup reaches the caller as it is, so denial or a lost
  // connection is not reported as a retryable read.
  const denied = new Error("Buzz is not connected");
  vi.mocked(client.memories).mockRejectedValueOnce(denied);
  await expect(
    callTool(client, {}, "mem_set", { slug: "notes", text: "new" }),
  ).rejects.toBe(denied);
  expect(client.remember).not.toHaveBeenCalled();
  partial([{ slug: "mem/a", body: "a", createdAt: 0 }]);
  await expect(callTool(client, {}, "mem_get", {})).resolves.toMatch(
    /^mem\/a .*\nThis list is incomplete: some memory could not be read\.$/,
  );
  vi.mocked(client.memories).mockResolvedValue({ entries: [], partial: false });
  await expect(callTool(client, {}, "mem_get", {})).resolves.toBe("No memory.");
  await expect(
    callTool(client, {}, "mem_get", { slug: "notes" }),
  ).resolves.toBe("No memory mem/notes.");
  // Only a complete read that confirms the entry is missing writes it fresh.
  await callTool(client, {}, "mem_set", { slug: "notes", text: "new" });
  expect(client.remember).toHaveBeenCalledWith("mem/notes", "new", 0);
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
  // Every app session lists the same tools: the Buzz and attention tools.
  expect(list.result.tools).toHaveLength(TOOLS.length + ATTENTION_TOOLS.length);
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

it("finds a channel past the relay's first page, by name and then by ID", async () => {
  const { client, state, published } = relay();
  const channel = (n: number, name: string, created_at: number) => {
    const d = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const id = (k: number) => (k * 1000 + n).toString(16).padStart(64, "0");
    state.push(
      event({
        id: id(1),
        kind: 39000,
        created_at,
        tags: [["d", d], ["name", name], ["private"]],
      }),
      event({
        id: id(2),
        kind: 39002,
        created_at,
        tags: [
          ["d", d],
          ["p", me, "", "bot"],
        ],
      }),
    );
    return d;
  };
  for (let n = 1; n <= 500; n++) channel(n, `busy-${n}`, 1000 + n);
  const fixers = channel(501, "fixers", 10);
  const row = `${fixers} fixers (private)`;
  await expect(callTool(client, {}, "channels", { q: "fixers" })).resolves.toBe(
    row,
  );
  await expect(
    callTool(client, {}, "channels", { all: true, q: "FIXERS" }),
  ).resolves.toBe(row);
  await expect(
    callTool(client, {}, "channel", { channel: fixers }),
  ).resolves.toBe(`${fixers} fixers (private)\nyou: bot`);
  await expect(
    callTool(client, {}, "canvas", { channel: fixers }),
  ).resolves.toBe("No canvas.");
  const unseen =
    "No channel fixers that you can see (it may not be visible yet). If you supplied a name, channels with q finds its ID.";
  await expect(
    callTool(client, {}, "channel", { channel: "fixers" }),
  ).rejects.toThrow(unseen);
  await expect(
    callTool(client, {}, "canvas", { channel: "fixers" }),
  ).rejects.toThrow(unseen);
  await expect(
    callTool(client, {}, "canvas", { channel: "fixers", text: "# Plan" }),
  ).rejects.toThrow(unseen);
  expect(published).toEqual([]);
});

/** Large tied-timestamp datasets without the general fake's quadratic matching. */
function channelListing(count: number, joined: boolean) {
  const metadata = Array.from({ length: count }, (_, n) =>
    event({
      id: n.toString(16).padStart(64, "0"),
      kind: 39000,
      tags: [
        ["d", `room-${n}`],
        ["name", n === 0 || n === count - 1 ? "needle" : "busy"],
      ],
    }),
  );
  const memberships = joined
    ? metadata.map((item) =>
        event({
          id: item.id,
          kind: 39002,
          tags: [
            ["d", item.tags[0]?.[1] ?? ""],
            ["p", me],
          ],
        }),
      )
    : [];
  const { client } = fake();
  const cursors = new Map<number, string | undefined>();
  client.query = vi.fn(async ([filter]: readonly Filter[]) => {
    if (!filter) throw new Error("Expected one filter");
    expect(filter.limit).toBeLessThanOrEqual(500);
    const kind = (filter.kinds as number[])[0] as number;
    expect(filter.before_id).toBe(cursors.get(kind));
    const membership = (filter.kinds as number[])[0] === 39002;
    if (membership) expect(filter["#p"]).toEqual([me]);
    const ids = filter["#d"] as string[] | undefined;
    const scope = ids && new Set(ids);
    const source = membership ? memberships : metadata;
    const before = filter.before_id as string | undefined;
    if (before) expect(filter.until).toBe(100);
    const page = source
      .filter(
        (item) =>
          (!before || item.id > before) &&
          (!scope || scope.has(item.tags[0]?.[1] ?? "")),
      )
      .slice(0, filter.limit as number);
    cursors.set(kind, page.at(-1)?.id);
    return page;
  });
  return { client, metadata, memberships };
}

it.each([9_999, 10_000, 10_001])(
  "searches %i metadata events without an oversized reply or hard failure",
  async (count) => {
    const { client } = channelListing(count, false);
    const answer = (await callTool(client, {}, "channels", {
      all: true,
      q: "NEEDLE",
    })) as string;
    expect(answer).toContain("room-0 needle (not joined)");
    expect(answer.includes(`room-${count - 1} needle`)).toBe(count <= 10_000);
    expect(answer.includes("Partial channel list")).toBe(count > 10_000);
    expect(answer).not.toContain("busy");
    expect(new TextEncoder().encode(answer).length).toBeLessThanOrEqual(16_384);
    expect(client.query).toHaveBeenCalledTimes(21 + (count >= 10_000 ? 1 : 0));
  },
);

it.each([9_999, 10_000, 10_001])(
  "searches %i memberships within joined scope and reports incomplete scans",
  async (count) => {
    const { client, metadata } = channelListing(count, true);
    metadata.push(
      event({
        kind: 39000,
        tags: [
          ["d", "outside"],
          ["name", "needle"],
        ],
      }),
    );
    const answer = (await callTool(client, {}, "channels", {
      q: "needle",
    })) as string;
    expect(answer).toContain("room-0 needle");
    expect(answer.includes(`room-${count - 1} needle`)).toBe(count <= 10_000);
    expect(answer.includes("Partial channel list")).toBe(count > 10_000);
    expect(answer).not.toContain("outside");
    expect(answer).not.toContain("not joined");
  },
);

it("does not claim non-membership when the membership scan is partial", async () => {
  const { client, metadata } = channelListing(10_001, true);
  metadata.splice(0, 10_000);
  await expect(
    callTool(client, {}, "channels", { all: true }),
  ).resolves.toContain(
    "room-10000 needle (membership unknown)\nPartial channel list",
  );
});

it("reports a partial search even when no channel matched before the scan limit", async () => {
  const { client } = channelListing(10_001, false);
  await expect(
    callTool(client, {}, "channels", { all: true, q: "missing" }),
  ).resolves.toBe(
    "Partial channel list: scan or output limit reached. Narrow with q or use a known channel ID.",
  );
});

it("keeps transport failures as errors instead of treating them as partial scans", async () => {
  const { client } = channelListing(501, false);
  const query = client.query;
  client.query = vi.fn(async (filters) => {
    if (filters[0]?.before_id) throw new Error("relay unavailable");
    return query(filters);
  });
  await expect(
    callTool(client, {}, "channels", { all: true, q: "needle" }),
  ).rejects.toThrow("relay unavailable");
});

it.each([500, 501])(
  "bounds a %i-row listing and labels partial output",
  async (count) => {
    const { client } = channelListing(count, false);
    const reply = await respond(
      client,
      {},
      {
        id: 1,
        method: "tools/call",
        params: { name: "channels", arguments: { all: true } },
      },
    );
    if (!("result" in reply)) throw new Error("Expected an MCP result");
    const answer =
      (reply.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(
      answer.split("\n").filter((row) => row.startsWith("room-")),
    ).toHaveLength(500);
    expect(answer.includes("Partial channel list")).toBe(count > 500);
    expect(new TextEncoder().encode(answer).length).toBeLessThanOrEqual(16_384);
  },
);

it.each(["x", "界", "😀", '"\\\n'])(
  "bounds MCP text bytes with long %j names, retaining a usable ID",
  async (unit) => {
    const { client, metadata } = channelListing(2, false);
    metadata[0] = event({
      kind: 39000,
      tags: [
        ["d", "oversized"],
        ["name", unit.repeat(20_000)],
      ],
    });
    const reply = await respond(
      client,
      {},
      {
        id: 1,
        method: "tools/call",
        params: { name: "channels", arguments: { all: true, q: unit } },
      },
    );
    if (!("result" in reply)) throw new Error("Expected an MCP result");
    expect(reply.result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("oversized (details omitted;"),
        },
      ],
    });
    const text =
      (reply.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(text).toContain("Partial channel list");
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(16_384);
  },
);

it.each([-1, 0, 1])(
  "handles the UTF-8 output boundary at offset %i",
  async (offset) => {
    const { client, metadata } = channelListing(2, false);
    const notice =
      "Partial channel list: scan or output limit reached. Narrow with q or use a known channel ID.";
    const suffix = " (not joined)";
    const budget = 16_384 - new TextEncoder().encode(notice).length - 1;
    const prefix = "room-0 ";
    const name = "界".repeat(
      Math.floor((budget - prefix.length - suffix.length) / 3),
    );
    const padding =
      budget -
      prefix.length -
      suffix.length -
      new TextEncoder().encode(name).length;
    metadata[0] = event({
      id: "0".repeat(64),
      kind: 39000,
      tags: [
        ["d", "room-0"],
        ["name", name + "x".repeat(padding + offset)],
      ],
    });
    const reply = await respond(
      client,
      {},
      {
        id: 1,
        method: "tools/call",
        params: { name: "channels", arguments: { all: true } },
      },
    );
    if (!("result" in reply)) throw new Error("Expected an MCP result");
    const answer =
      (reply.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(new TextEncoder().encode(answer).length).toBeLessThanOrEqual(16_384);
    expect(answer.includes(name)).toBe(offset <= 0);
    expect(answer).toContain(notice);
    if (offset === 0)
      expect(new TextEncoder().encode(answer).length).toBe(16_384);
  },
);

it("reads an existing canvas without querying channel metadata", async () => {
  const { client } = fake([event({ kind: 40100, content: "# Existing" })]);
  await expect(
    callTool(client, { channel: "chan" }, "canvas", {}),
  ).resolves.toBe("# Existing");
  expect(client.query).toHaveBeenCalledExactlyOnceWith([
    { kinds: [40100], "#h": ["chan"], limit: 1 },
  ]);
});

it("waits past the existing canvas timestamp before publishing", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_500);
    const { client, published } = fake([
      event({ kind: 40100, content: "old" }),
    ]);
    const publish = client.publish;
    client.publish = vi.fn(async (template) => {
      expect(Date.now()).toBe(101_000);
      return publish(template);
    });
    const write = callTool(client, { channel: "chan" }, "canvas", {
      text: "new",
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(write).resolves.toBe("saved");
    expect(published).toEqual([
      { kind: 40100, content: "new", tags: [["h", "chan"]] },
    ]);
    expect(client.query).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("publishes the first canvas only after finding visible channel metadata", async () => {
  const { client, published } = fake([
    event({ kind: 39000, tags: [["d", "chan"]] }),
  ]);
  await expect(
    callTool(client, { channel: "chan" }, "canvas", { text: "first" }),
  ).resolves.toBe("saved");
  expect(client.query).toHaveBeenNthCalledWith(2, [
    { kinds: [39000], "#d": ["chan"], limit: 1 },
  ]);
  expect(published).toEqual([
    { kind: 40100, content: "first", tags: [["h", "chan"]] },
  ]);
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
  ).rejects.toThrow(
    "No channel gone that you can see (it may not be visible yet).",
  );
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
