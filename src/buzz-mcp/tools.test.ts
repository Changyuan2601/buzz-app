import { schnorr } from "@noble/curves/secp256k1.js";
import { npubEncode } from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import type { BuzzClient, BuzzEvent, Filter, Memory, Template } from "./client";
import { respond } from "./rpc";
import { ATTENTION_TOOLS } from "./attention";
import { createHash } from "node:crypto";
import { callTool, memoryVersion, TOOLS } from "./tools";

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
function fake(
  events: readonly BuzzEvent[] = [],
  {
    keep = false,
    hidden = () => false,
  }: {
    keep?: boolean;
    /** Leaves an event out of a filter's results before its limit applies. */
    hidden?: (filter: Filter, item: BuzzEvent) => boolean;
  } = {},
) {
  // With keep, a publication joins the community as a fresh event.
  const kept: BuzzEvent[] = [];
  const published: Template[] = [];
  const matches = (filter: Filter, item: BuzzEvent) => {
    const tag = (name: string) =>
      item.tags.filter((t) => t[0] === name).map((t) => t[1]);
    const { since, until, before_id } = filter as {
      since?: number;
      until?: number;
      before_id?: string;
    };
    if (since !== undefined && item.created_at < since) return false;
    if (until !== undefined && item.created_at > until) return false;
    if (item.created_at === until && before_id && item.id <= before_id)
      return false;
    if (hidden(filter, item)) return false;
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
    key: me,
    pubkey: me,
    query: vi.fn(async (filters: readonly Filter[]) => {
      const newest = [...events, ...kept].sort(
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
      const signed = keep
        ? event({
            ...template,
            pubkey: me,
            id: `${published.length}`.padStart(64, "e"),
            created_at: Math.floor(Date.now() / 1000),
          })
        : event({ ...template, pubkey: me, id: "e".repeat(64) });
      if (keep) kept.push(signed);
      return signed;
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
      url.endsWith(".png")
        ? {
            path: `/cache/${url}`,
            type: "image/png",
            size: PNG.length,
            data: btoa(String.fromCharCode(...PNG)),
          }
        : { path: `/cache/${url}`, type: "video/mp4", size: 3 },
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
  ).rejects.toThrow("audience must be everyone, details or agents");
  await expect(
    callTool(client, context, "send", { text: "hi", audience: "humans" }),
  ).rejects.toThrow("audience must be everyone, details or agents");
  expect(published).toHaveLength(1);
});

it("tags details for people to open, as written", async () => {
  const { client, published } = fake(community);
  const context = { channel: "chan", root };
  await callTool(client, context, "send", {
    text: "The sidebar is fixed.\n\n- Keeps its place while channels load",
    audience: "details",
  });
  expect(published[0]?.content).toBe(
    "The sidebar is fixed.\n\n- Keeps its place while channels load",
  );
  expect(published[0]?.tags.at(-1)).toEqual(["audience", "details"]);
});

it("refuses an everyone message over 128 words, or a brief over 50", async () => {
  const { client, published } = fake(community);
  const context = { channel: "chan", root };
  const long = Array.from({ length: 51 }, () => "word").join(" ");
  await callTool(client, context, "send", { text: long, audience: "everyone" });
  published.length = 0;
  await expect(
    callTool(client, context, "send", {
      text: Array.from({ length: 129 }, () => "word").join(" "),
      audience: "everyone",
    }),
  ).rejects.toThrow("This is 129 words, too long for everyone");
  await expect(
    callTool(client, context, "send", {
      text: `${long}\n\nThe rest.`,
      audience: "details",
    }),
  ).rejects.toThrow("The brief, the first paragraph, is 51 words");
  expect(published).toHaveLength(0);
  await callTool(client, context, "send", {
    text: `The sidebar is fixed.\n\n${long}`,
    audience: "details",
  });
  await callTool(client, context, "send", { text: long, audience: "agents" });
  expect(published).toHaveLength(2);
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

it("replies to a message inside a thread at the thread's root, and posts a file's text and attachments", async () => {
  const { client, published } = fake(community);
  await callTool(client, { channel: "chan", root }, "send", {
    audience: "everyone",
    reply: nested,
    path: "notes.md",
    files: ["shot.png", "docs/plan.pdf"],
  });
  expect(published[0]).toEqual({
    kind: 9,
    content:
      "# notes.md\n![shot.png](<https://relay/media/x.png>)\n[plan.pdf](<https://relay/media/x.png>)",
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
        "filename shot.png",
      ],
      [
        "imeta",
        "url https://relay/media/x.png",
        "m application/octet-stream",
        "x ab",
        "size 7",
        "dim 1x1",
        "filename plan.pdf",
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
    `thread ${root} in chan`,
    `${root} from ${alice} "Alice Smith" at 1970-01-01T00:01Z: `,
    `${nested} from ${alice} "Alice Smith" at 1970-01-01T00:01Z: edited`,
    "The relay returned no older replies.",
  ]);
});

it.each([
  ["channel", { channel: "chan" }],
  ["search", { q: "hello" }],
  ["current thread", {}],
  ["explicit thread", { thread: nested }],
] as const)(
  "keeps agent ownership and nested reply context in a %s read",
  async (_, args) => {
    const id = "3".repeat(64);
    const signature = "7".repeat(128);
    const auth = ["auth", bob, "kind=9&created_at<999", "8".repeat(128)];
    const message = event({
      id,
      content: "hello",
      sig: signature,
      tags: [
        ["h", "chan"],
        auth,
        ["e", root, "", "root"],
        ["e", nested, "", "reply"],
      ],
    });
    const { client } = fake([
      ...community,
      message,
      event({
        kind: 40003,
        created_at: 120,
        content: "hello, edited",
        tags: [["e", id]],
      }),
    ]);
    const response = (await respond(
      client,
      { channel: "chan", root },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read", arguments: args },
      },
    )) as {
      result: { content: { type: string; text: string }[]; isError?: boolean };
    };
    expect(response.result.isError).not.toBe(true);
    const text = response.result.content.map((item) => item.text).join("\n");
    const line = text.split("\n").find((line) => line.startsWith(id));
    expect(line).toContain(`from ${alice} "Alice Smith" claimed owner ${bob}`);
    expect(line).toContain(`reply_to ${nested}`);
    expect(line).toContain("hello, edited");
    if ("channel" in args || "q" in args) expect(line).toContain(`re ${root}`);
    else expect(text.split("\n")[0]).toBe(`thread ${root} in chan`);
    // Human authors and direct replies keep their compact, unambiguous form.
    expect(
      text.split("\n").find((line) => line.startsWith(root)),
    ).not.toContain("owner");
    expect(
      text.split("\n").find((line) => line.startsWith(nested)),
    ).not.toContain("reply_to");
    for (const omitted of [signature, auth[2], auth[3]])
      expect(text).not.toContain(omitted);
    expect(message.tags).toContain(auth);
    expect(message.sig).toBe(signature);
  },
);

const reply = (id: string, created_at: number) =>
  event({
    id,
    created_at,
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
    ],
  });
const read = (client: BuzzClient, args: Record<string, unknown>) =>
  callTool(client, { channel: "chan", root }, "read", args) as Promise<string>;
/** The arguments a read says to continue with, if it says to. */
const next = (answer: string) => {
  const found = answer.match(/continue with (\{.*\})$/m)?.[1];
  return found ? (JSON.parse(found) as Record<string, unknown>) : undefined;
};

it("searches one author's messages since a time across channels, before the limit", async () => {
  const { client } = fake([
    profile(alice, "Alice Smith"),
    event({ id: "3".repeat(64), created_at: 50, content: "too old" }),
    event({
      id: "4".repeat(64),
      created_at: 200,
      content: "rollout done",
      tags: [["h", "other"]],
    }),
    // Newer messages from someone else that a limit applied first would keep.
    ...["5", "6", "7"].map((n) =>
      event({ id: n.repeat(64), pubkey: bob, created_at: 300 }),
    ),
  ]);
  const answer = await read(client, {
    q: "rollout",
    author: npubEncode(alice),
    since: 100,
    limit: 2,
  });
  expect(answer).toBe(
    `${"4".repeat(64)} from ${alice} "Alice Smith" in other at 1970-01-01T00:03Z: rollout done`,
  );
  // Without a channel, search still spans every channel it can read.
  expect(client.query).toHaveBeenCalledWith([
    {
      kinds: [9, 40002, 45001, 45003],
      search: "rollout",
      limit: 2,
      authors: [alice],
      since: 100,
    },
  ]);
  // A full page says more may match.
  expect(await read(client, { q: "x", limit: 1 })).toMatch(
    /\nResult limit reached; more matches may exist\. Narrow with channel, author, since or before\.$/,
  );
});

it("tells apart people with the same name, and where each message is", async () => {
  const { client } = fake([
    profile(alice, "Sam"),
    profile(bob, "Sam"),
    event({ id: "3".repeat(64), content: "ship it" }),
    event({
      id: "4".repeat(64),
      pubkey: bob,
      created_at: 120,
      content: "ship it too",
      tags: [
        ["h", "other"],
        ["e", root, "", "reply"],
      ],
    }),
  ]);
  expect((await read(client, { q: "ship" })).split("\n")).toEqual([
    `${"3".repeat(64)} from ${alice} "Sam" in chan at 1970-01-01T00:01Z: ship it`,
    `${"4".repeat(64)} from ${bob} "Sam" in other re ${root} at 1970-01-01T00:02Z: ship it too`,
  ]);
  // A channel read names the channel once, and each reply's thread.
  expect(
    (await read(client, { channel: "other", author: bob, since: 110 })).split(
      "\n",
    ),
  ).toEqual([
    "channel other",
    `${"4".repeat(64)} from ${bob} "Sam" re ${root} at 1970-01-01T00:02Z: ship it too`,
    "The relay returned no older messages.",
  ]);
});

it("pages a thread to its start, each reply once, through timestamp ties", async () => {
  const tied = ["4", "5", "6"].map((n) => n.repeat(64));
  const replies = [
    reply("3".repeat(64), 110),
    ...tied.map((id) => reply(id, 120)),
    reply("7".repeat(64), 130),
  ];
  const { client } = fake([
    profile(alice, "Alice Smith"),
    event({ id: root, created_at: 90 }),
    ...replies,
  ]);
  const ids = (answer: string) =>
    answer
      .split("\n")
      .slice(1, -1)
      .map((line) => line.slice(0, 64));
  const pages: string[][] = [];
  let args: Record<string, unknown> | undefined = { limit: 2 };
  let last = "";
  while (args) {
    last = await read(client, args);
    expect(last.split("\n")[0]).toBe(`thread ${root} in chan`);
    pages.push(ids(last));
    args = next(last);
    if (args) expect(last).toMatch(/\nOlder replies remain; continue with /);
    expect(pages.length).toBeLessThan(5);
  }
  // The root is on the first page only, and never counts toward its limit.
  expect(pages).toEqual([
    [root, tied[0], "7".repeat(64)],
    [tied[1], tied[2]],
    ["3".repeat(64)],
  ]);
  expect(last.split("\n").at(-1)).toBe("The relay returned no older replies.");
  // Exactly a limit of replies, with the root besides, is the whole thread.
  const whole = await read(client, { limit: replies.length });
  expect(ids(whole)).toHaveLength(replies.length + 1);
  expect(whole.split("\n").at(-1)).toBe("The relay returned no older replies.");
  // `before` alone bounds a thread read too, inclusively.
  expect(ids(await read(client, { thread: tied[1], before: 120 }))).toEqual([
    "3".repeat(64),
    ...tied,
  ]);
});

it("refuses read arguments it cannot apply, saying how to fix them", async () => {
  const { client } = fake(community);
  for (const [args, error] of [
    [{ q: "x", author: "alice" }, "author must be a hex pubkey or npub"],
    [{ q: "x", author: 7 }, "author must be a hex pubkey or npub"],
    [{ q: "x", since: "friday" }, "since must be Unix seconds"],
    [{ q: "x", since: -1 }, "since must be Unix seconds"],
    [{ q: "x", since: 1.5 }, "since must be Unix seconds"],
    [{ q: "x", since: 1_760_000_000_000 }, "since must be Unix seconds"],
    [{ q: "x", since: 200, before: 100 }, "since must not be after before"],
    [{ channel: "chan", before_id: root }, "before_id needs before"],
    [{ channel: "chan", before: 1, before_id: "x" }, "before_id must be"],
    [
      { q: "x", before: 1, before_id: root },
      "before_id pages thread and channel reads",
    ],
    [
      { author: alice },
      "author and since filter a search (q) or a channel read",
    ],
    [
      { thread: root, since: 1 },
      "author and since filter a search (q) or a channel read",
    ],
  ] as const)
    await expect(read(client, args), JSON.stringify(args)).rejects.toThrow(
      error,
    );
  expect(client.query).not.toHaveBeenCalled();
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

it("replaces memory only at the version it was shown, newer than the entry it replaces", async () => {
  const { client } = fake();
  const shown = await callTool(client, {}, "mem_get", { slug: "notes" });
  const version = /^version: ([0-9a-f]{16})\n\nold$/.exec(String(shown))?.[1];
  // The version is the start of the SHA-256 of the text.
  expect(version).toBe(
    createHash("sha256").update("old").digest("hex").slice(0, 16),
  );
  await expect(
    callTool(client, {}, "mem_set", { slug: "notes", text: "new" }),
  ).rejects.toThrow(
    "mem/notes exists. Read it with mem_get, keep what still holds, and pass its version as expected.",
  );
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "notes",
      text: "new",
      expected: "0".repeat(16),
    }),
  ).rejects.toThrow(/^mem\/notes changed since version 0{16}\. Read it again/);
  // Writing back the whole mem_get reply would save its header.
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "notes",
      text: `${shown}\nnew`,
      expected: version,
    }),
  ).rejects.toThrow(
    "Leave out the version line from mem_get; pass the version as expected.",
  );
  expect(client.remember).not.toHaveBeenCalled();
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "notes",
      text: "new",
      expected: version,
    }),
  ).resolves.toBe(`saved; version ${await memoryVersion("new")}`);
  expect(client.remember).toHaveBeenCalledWith("mem/notes", "new", 50);
  // Every read is of the one entry by its slug, not the whole listing.
  expect(vi.mocked(client.memories).mock.calls).toEqual([
    ["mem/notes"],
    ["mem/notes"],
    ["mem/notes"],
    ["mem/notes"],
  ]);
  // Without an entry, expected names nothing to replace.
  vi.mocked(client.memories).mockResolvedValue({ entries: [], partial: false });
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "gone",
      text: "x",
      expected: version,
    }),
  ).rejects.toThrow(
    "No memory mem/gone to replace; leave out expected to create it.",
  );
});

it("refuses to overwrite core that another session changed since this one read it", async () => {
  const { client } = fake();
  let core = "I am Gander.";
  vi.mocked(client.memories).mockImplementation(async () => ({
    entries: [{ slug: "core", body: core, createdAt: 10 }],
    partial: false,
  }));
  const first = await memoryVersion(core);
  // Another session of the agent adds a line after this one read `core`.
  core = "I am Gander.\nShip on Fridays.";
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "core",
      text: "I am Gander.\nUse pnpm.",
      expected: first,
    }),
  ).rejects.toThrow(`core changed since version ${first}.`);
  expect(client.remember).not.toHaveBeenCalled();
  // Merging into what is there now saves, and says how big core is.
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "core",
      text: `${core}\nUse pnpm.`,
      expected: await memoryVersion(core),
    }),
  ).resolves.toMatch(/^saved; version [0-9a-f]{16}; core is 39 bytes\.$/);
  core = "x".repeat(12_000);
  await expect(
    callTool(client, {}, "mem_set", {
      slug: "core",
      text: "y".repeat(12_345),
      expected: await memoryVersion(core),
    }),
  ).resolves.toMatch(
    /; core is 12\.3 KB, over the ~10 KB target\. Move detail you do not need every turn to a mem\/ slug\.$/,
  );
});

it("searches all memory for entries with every word, newest first", async () => {
  const { client } = fake();
  const long = `${"a".repeat(200)} needle ${"b".repeat(200)}`;
  const entries: Memory[] = [
    { slug: "core", body: "I am Gander.\nRelease on Fridays.", createdAt: 30 },
    {
      slug: "mem/release",
      body: "Release steps\nTag, then RELEASE notes.\nunrelated",
      createdAt: 20,
    },
    { slug: "mem/old", body: `fridays only\n${long}`, createdAt: 10 },
    ...Array.from({ length: 21 }, (_, i) => ({
      slug: `mem/bulk/${i}`,
      body: "bulk",
      createdAt: i,
    })),
  ];
  vi.mocked(client.memories).mockResolvedValue({ entries, partial: false });
  const at = (seconds: number) =>
    `${new Date(seconds * 1000).toISOString().slice(0, 16)}Z`;
  await expect(callTool(client, {}, "mem_get", { q: "release" })).resolves.toBe(
    [
      `core ${at(30)}`,
      "  Release on Fridays.",
      `mem/release ${at(20)}`,
      "  Release steps",
      "  Tag, then RELEASE notes.",
    ].join("\n"),
  );
  // Every word must match, in the slug or the text.
  await expect(
    callTool(client, {}, "mem_get", { q: "Fridays  release" }),
  ).resolves.toBe(`core ${at(30)}\n  Release on Fridays.`);
  // A long line is cut around its match.
  const cut = await callTool(client, {}, "mem_get", { q: "needle" });
  expect(cut).toBe(`mem/old ${at(10)}\n  …${long.slice(161, 321)}…`);
  expect(String(cut)).toContain("needle");
  // Twenty entries at most, then how many more.
  const bulk = String(await callTool(client, {}, "mem_get", { q: "bulk" }));
  expect(
    bulk.split("\n").filter((line) => line.startsWith("mem/")),
  ).toHaveLength(20);
  expect(bulk).toMatch(/^mem\/bulk\/20 /);
  expect(bulk).toMatch(/\n1 more; add words to q to narrow it\.$/);
  await expect(callTool(client, {}, "mem_get", { q: "zebra" })).resolves.toBe(
    "No memory matches zebra.",
  );
  await expect(
    callTool(client, {}, "mem_get", { q: "release", slug: "core" }),
  ).rejects.toThrow("q searches all memory; leave out slug.");
  await expect(callTool(client, {}, "mem_get", { q: " " })).rejects.toThrow(
    "q needs a word to search for.",
  );
  vi.mocked(client.memories).mockResolvedValue({ entries, partial: true });
  await expect(callTool(client, {}, "mem_get", { q: "steps" })).resolves.toBe(
    `mem/release ${at(20)}\n  Release steps\nThis search is incomplete: some memory could not be read.`,
  );
  await expect(callTool(client, {}, "mem_get", { q: "zebra" })).rejects.toThrow(
    "Memory could not be read; try again.",
  );
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

it("shows a media image to the agent, and gives any media's saved path", async () => {
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
    result: {
      content: [
        { type: "image", data: png, mimeType: "image/png" },
        {
          type: "text",
          text: `Saved /cache/abc.png (image/png, ${PNG.length} bytes).`,
        },
      ],
    },
  });
  expect(client.media).toHaveBeenCalledWith("abc.png");
  await expect(
    callTool(client, {}, "media_get", { url: "abc.mp4" }),
  ).resolves.toBe(
    "Saved /cache/abc.mp4 (video/mp4, 3 bytes). Open it with your own tools.",
  );
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
        ["t", "stream"],
        ["p", me, "", "owner"],
        ["p", alice, "", "member"],
      ],
    }),
    profile(alice, "Alice Smith"),
  ];
  // Like the relay, this leaves system channels out of a filter that neither
  // opts in with `#t` nor names them by `#d`, before the filter's limit.
  const { client, published } = fake(state, {
    hidden: (filter, item) =>
      item.tags.some((t) => t[0] === "t" && t[1] === "system") &&
      !(filter["#t"] as string[] | undefined)?.includes("system") &&
      !(filter["#d"] as string[] | undefined)?.includes(
        item.tags[0]?.[1] ?? "",
      ),
  });
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
    if (kind === 9007) {
      // The relay states the channel's type as the first `t` tag of both
      // state events, and privacy as a bare `private` tag.
      const value = (key: string) =>
        template.tags.find((t) => t[0] === key)?.[1];
      const type = ["t", value("channel_type") ?? "stream"];
      state.push(
        event({
          kind: 39000,
          tags: [
            ["d", id],
            ["name", value("name") ?? ""],
            type,
            ...(value("visibility") === "private" ? [["private"]] : []),
          ],
        }),
        event({
          kind: 39002,
          tags: [["d", id], type, ["p", me, "", "owner"]],
        }),
      );
    }
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

it("lists only the channel types asked for", async () => {
  const { client, state } = relay();
  const forum = "7d9a4e3f-5c6b-4d8e-8f1a-2b3c4d5e6f70";
  state.push(
    event({
      kind: 39000,
      tags: [
        ["d", forum],
        ["name", "ideas"],
        ["t", "forum"],
      ],
    }),
    event({
      kind: 39002,
      tags: [
        ["d", forum],
        ["t", "forum"],
        ["p", me, "", "member"],
      ],
    }),
    event({
      kind: 39000,
      tags: [["d", "other"], ["name", "lobby"], ["t", "forum"], ["private"]],
    }),
  );
  await expect(callTool(client, {}, "channels", {})).resolves.toBe(
    `${room} plans\n${forum} ideas (forum)`,
  );
  await expect(
    callTool(client, {}, "channels", { types: ["forum"] }),
  ).resolves.toBe(`${forum} ideas (forum)`);
  await expect(
    callTool(client, {}, "channels", { types: ["stream"], all: true }),
  ).resolves.toBe(`${room} plans`);
  await expect(
    callTool(client, {}, "channels", { types: ["forum"], all: true }),
  ).resolves.toBe(
    `${forum} ideas (forum)\nother lobby (forum, private, not joined)`,
  );
  for (const types of [[], ["channel"], "forum", [7]])
    await expect(callTool(client, {}, "channels", { types })).rejects.toThrow(
      "types must list some of stream, forum, dm, workflow, system.",
    );
});

it("keeps a roster signed before NIP-CL joined when listing by type", async () => {
  const { client, state } = relay();
  // NIP-CL: an older roster event can lack the type tag.
  const roster = state.findIndex((e) => e.kind === 39002);
  const old = state[roster] as BuzzEvent;
  state[roster] = { ...old, tags: old.tags.filter((t) => t[0] !== "t") };
  await expect(
    callTool(client, {}, "channels", { types: ["stream"] }),
  ).resolves.toBe(`${room} plans`);
  await expect(
    callTool(client, {}, "channels", { types: ["stream"], all: true }),
  ).resolves.toBe(`${room} plans`);
  await expect(
    callTool(client, {}, "channels", { types: ["forum"], all: true }),
  ).resolves.toBe("No channels.");
});

it("lists system channels only when asked, as the relay serves them", async () => {
  const { client, state } = relay();
  const system = "5b7e2c1d-3a4f-4b6c-8d9e-0f1a2b3c4d5e";
  const lobby = "6c8f3d2e-4b5a-4c7d-9e0f-1a2b3c4d5e6f";
  state.push(
    event({
      kind: 39000,
      tags: [["d", system], ["name", "config"], ["t", "system"], ["private"]],
    }),
    event({
      kind: 39002,
      tags: [
        ["d", system],
        ["t", "system"],
        ["p", me, "", "owner"],
      ],
    }),
    event({
      kind: 39000,
      tags: [
        ["d", lobby],
        ["name", "ops"],
        ["t", "system"],
      ],
    }),
  );
  await expect(callTool(client, {}, "channels", {})).resolves.toBe(
    `${room} plans`,
  );
  await expect(callTool(client, {}, "channels", { all: true })).resolves.toBe(
    `${room} plans`,
  );
  await expect(
    callTool(client, {}, "channels", { types: ["system"] }),
  ).resolves.toBe(`${system} config (system, private)`);
  await expect(
    callTool(client, {}, "channels", { types: ["system"], all: true }),
  ).resolves.toBe(
    `${system} config (system, private)\n${lobby} ops (system, not joined)`,
  );
});

it("creates a system channel", async () => {
  const { client, published } = relay();
  const answer = await callTool(client, {}, "channel", {
    action: "create",
    name: "config",
    visibility: "private",
    type: "system",
  });
  const id = published[0]?.tags[0]?.[1] as string;
  expect(published).toEqual([
    {
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", "config"],
        ["visibility", "private"],
        ["channel_type", "system"],
      ],
    },
  ]);
  expect(answer).toBe(`created ${id}`);
  await expect(
    callTool(client, {}, "channels", { types: ["system"] }),
  ).resolves.toBe(`${id} config (system, private)`);
  await expect(callTool(client, {}, "channels", {})).resolves.toBe(
    `${room} plans`,
  );
  await expect(
    callTool(client, {}, "channels", { types: ["stream", "system"] }),
  ).resolves.toBe(`${room} plans\n${id} config (system, private)`);
  await expect(
    callTool(client, {}, "channel", {
      action: "create",
      name: "config",
      visibility: "private",
      type: "dm",
    }),
  ).rejects.toThrow("type must be stream, forum or system.");
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

it("keeps waiting when the timer fires a moment early", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_500);
    const { client } = fake([event({ kind: 40100, content: "old" })]);
    const timer = globalThis.setTimeout;
    const early = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((run: () => void, ms: number) =>
        timer(run, Math.max(0, ms - 1))) as typeof setTimeout);
    const publish = client.publish;
    client.publish = vi.fn(async (template) => {
      expect(Date.now()).toBe(101_000);
      return publish(template);
    });
    const write = callTool(client, { channel: "chan" }, "canvas", {
      text: "new",
    });
    await vi.advanceTimersByTimeAsync(500);
    early.mockRestore();
    await expect(write).resolves.toBe("saved");
    expect(client.publish).toHaveBeenCalledTimes(1);
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

it("lists, opens and closes tabs for the working channel's threads", async () => {
  const reply = event({
    id: nested,
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
    ],
  });
  const elsewhere = event({ id: bob, tags: [["h", "other"]] });
  // The reader takes the last marked root and ignores case.
  const remarked = event({
    id: "3".repeat(64),
    tags: [
      ["h", "chan"],
      ["e", alice, "", "root"],
      ["e", root, "", "root"],
      ["e", nested, "", "reply"],
    ],
  });
  const uppercase = event({
    id: "4".repeat(64),
    tags: [
      ["h", "chan"],
      ["e", alice.toUpperCase(), "", "reply"],
    ],
  });
  const { client } = fake([
    event({ id: root }),
    reply,
    elsewhere,
    remarked,
    uppercase,
  ]);
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {}),
  ).rejects.toThrow("Tabs are kept in Buzz Desktop and are unavailable here.");
  const tabs = {
    list: vi.fn(() => [
      { root, pane: "side", shown: true },
      { root: alice, pane: "main", name: "Launch plan", shown: false },
    ]),
    open: vi.fn(() => true),
    close: vi.fn((): "closed" | "missing" | "shown" => "shown"),
    rename: vi.fn(() => true),
  };
  client.tabs = tabs;
  await expect(callTool(client, {}, "tabs", {})).rejects.toThrow(
    "Tabs need a channel to work in.",
  );
  expect(await callTool(client, { channel: "chan" }, "tabs", {})).toBe(
    `${root} side (shown)\n${alice} main "Launch plan"`,
  );
  expect(tabs.list).toHaveBeenCalledWith("chan");
  // A reply opens its thread's root.
  expect(
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "open",
      thread: nested,
    }),
  ).toBe(`opened ${root}`);
  expect(tabs.open).toHaveBeenCalledWith("chan", root);
  // Another channel's thread never gets a tab here.
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {
      action: "open",
      thread: bob,
    }),
  ).rejects.toThrow(`${bob} is not in this channel.`);
  expect(tabs.open).toHaveBeenCalledTimes(1);
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {
      action: "close",
      thread: root,
    }),
  ).rejects.toThrow("Your owner is looking at that tab, so it stays open.");
  expect(tabs.close).toHaveBeenLastCalledWith("chan", root);
  tabs.close.mockReturnValue("missing");
  expect(
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "close",
      thread: root,
    }),
  ).toBe("not open");
  // A reply renames its thread's tab; no name restores the automatic title.
  expect(
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "rename",
      thread: nested,
      name: " Launch plan ",
    }),
  ).toBe("renamed");
  expect(tabs.rename).toHaveBeenLastCalledWith("chan", root, "Launch plan");
  for (const [message, expected] of [
    [remarked, root],
    [uppercase, alice],
  ] as const) {
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "rename",
      thread: message.id,
      name: "Plan",
    });
    expect(tabs.rename).toHaveBeenLastCalledWith("chan", expected, "Plan");
  }
  tabs.rename.mockReturnValue(false);
  expect(
    await callTool(client, { channel: "chan" }, "tabs", {
      action: "rename",
      thread: root,
    }),
  ).toBe("not open");
  expect(tabs.rename).toHaveBeenLastCalledWith("chan", root, "");
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {
      action: "rename",
      thread: root,
      name: 1,
    }),
  ).rejects.toThrow("name must be text.");
  await expect(
    callTool(client, { channel: "chan" }, "tabs", {
      action: "move",
      thread: root,
    }),
  ).rejects.toThrow("action must be open, close or rename.");
});

it("finds users through the community's name search, in its order", async () => {
  const { client } = fake(community);
  // Name search ranks Bob's exact match above a later Alice match.
  client.searchProfiles = vi.fn(async () => [
    profile(bob, "Wes"),
    profile(alice, "Wesley"),
  ]);
  const found = await callTool(client, {}, "users", { q: "Wes" });
  expect(found).toBe(`${bob} Wes\n${alice} Wesley`);
  expect(client.searchProfiles).toHaveBeenCalledWith("wes", 100);
  expect(client.query).not.toHaveBeenCalled();
});

it("finds users with NIP-50 search where the community has no name search", async () => {
  const { client } = fake(community);
  client.searchProfiles = vi.fn(async () => undefined);
  // The fake ignores `search`; the name filter keeps only matching names.
  expect(await callTool(client, {}, "users", { q: "alice" })).toBe(
    `${alice} Alice Smith`,
  );
  expect(client.query).toHaveBeenCalledWith([
    { kinds: [0], search: "alice", limit: 100 },
  ]);
});

it("finds a name longer than the name search's limit with NIP-50 search", async () => {
  const { client } = fake(community);
  client.searchProfiles = vi.fn(async () => []);
  // 100 code points (200 UTF-16 units) is the longest name search accepts.
  const longest = "😀".repeat(100);
  await callTool(client, {}, "users", { q: longest });
  expect(client.searchProfiles).toHaveBeenCalledWith(longest, 100);
  expect(client.query).not.toHaveBeenCalled();
  const over = `${longest}w`;
  expect(await callTool(client, {}, "users", { q: over })).toBe("No users.");
  expect(client.searchProfiles).toHaveBeenCalledTimes(1);
  expect(client.query).toHaveBeenCalledWith([
    { kinds: [0], search: over, limit: 100 },
  ]);
});

it("reads users by id without the name search", async () => {
  const { client } = fake(community);
  client.searchProfiles = vi.fn(async () => []);
  expect(await callTool(client, {}, "users", { ids: [bob] })).toBe(
    `${bob} Bob`,
  );
  expect(client.searchProfiles).not.toHaveBeenCalled();
});

const note = (
  pubkey: string,
  name: string,
  created_at: number,
  extra: string[][] = [],
  content = `${name} by ${pubkey.slice(0, 1)}`,
) =>
  event({
    id: `${pubkey.slice(0, 1)}${created_at}`.padEnd(64, "0"),
    kind: 30023,
    pubkey,
    created_at,
    content,
    tags: [["d", name], ["title", `${name} title`], ...extra],
  });

it("reads a shared note by name, from whichever author has it", async () => {
  const { client } = fake([
    ...community,
    note(alice, "pr-recipe", 200, [
      ["summary", "how to open a PR"],
      ["t", "git"],
    ]),
    note(alice, "pr-recipe", 150),
  ]);
  await expect(
    callTool(client, {}, "notes_get", { name: "pr-recipe" }),
  ).resolves.toBe(
    [
      `30023:${alice}:pr-recipe by Alice Smith, 1970-01-01T00:03Z`,
      "title: pr-recipe title",
      "summary: how to open a PR",
      "tags: git",
      "",
      "pr-recipe by a",
    ].join("\n"),
  );
  await expect(
    callTool(client, {}, "notes_get", { name: "missing" }),
  ).resolves.toBe("No note missing.");
  await expect(
    callTool(client, {}, "notes_get", { name: "Bad Name" }),
  ).rejects.toThrow("Bad note name Bad Name");
});

it("asks which author's note when several share a name", async () => {
  const { client } = fake([
    ...community,
    profile(me, "Bob"),
    note(alice, "recipe", 200),
    note(bob, "recipe", 300),
  ]);
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe" }),
  ).rejects.toThrow(
    `2 authors have a note recipe; give author or latest.\n${bob} Bob`,
  );
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe", latest: true }),
  ).resolves.toMatch(/\nrecipe by b$/);
  // An author by display name, pubkey or npub.
  await expect(
    callTool(client, {}, "notes_get", {
      name: "recipe",
      author: "alice smith",
    }),
  ).resolves.toMatch(/\nrecipe by a$/);
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe", author: bob }),
  ).resolves.toMatch(/\nrecipe by b$/);
  await expect(
    callTool(client, {}, "notes_get", {
      name: "recipe",
      author: npubEncode(bob),
    }),
  ).resolves.toMatch(/\nrecipe by b$/);
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe", author: "Carol" }),
  ).rejects.toThrow("No one is named Carol.");
  await expect(
    callTool(client, {}, "notes_get", { name: "recipe", author: "Bob" }),
  ).rejects.toThrow(
    /^2 people are named Bob; give their npub\.\nnpub1\w+\nnpub1\w+$/,
  );
  await expect(
    callTool(client, {}, "notes_get", {
      name: "recipe",
      author: bob,
      latest: true,
    }),
  ).rejects.toThrow("Give author or latest, not both.");
});

it("lists your notes by default, or everyone's, newest first", async () => {
  const { client } = fake([
    ...community,
    note(me, "mine", 200, [["t", "ops"]]),
    note(me, "older", 100),
    note(alice, "hers", 300, [["t", "ops"]]),
  ]);
  await expect(callTool(client, {}, "notes_get", {})).resolves.toBe(
    `mine ${me}  1970-01-01T00:03Z mine title\nolder ${me}  1970-01-01T00:01Z older title`,
  );
  await expect(
    callTool(client, {}, "notes_get", { author: "all", tag: "ops" }),
  ).resolves.toBe(
    `hers ${alice} Alice Smith 1970-01-01T00:05Z hers title\nmine ${me}  1970-01-01T00:03Z mine title`,
  );
  expect(vi.mocked(client.query).mock.calls.at(-2)?.[0]).toEqual([
    { kinds: [30023], "#t": ["ops"], limit: 50 },
  ]);
  const { client: empty } = fake(community);
  await expect(callTool(empty, {}, "notes_get", {})).resolves.toBe("No notes.");
});

it("publishes a note in the CLI's shape, keeping what an update leaves out", async () => {
  const { client, published } = fake(community, { keep: true });
  await expect(
    callTool(client, {}, "notes_set", { name: "plan", text: "draft" }),
  ).rejects.toThrow("title is required for a new note.");
  await expect(
    callTool(client, {}, "notes_set", {
      name: "plan",
      title: "Plan",
      text: " ",
    }),
  ).rejects.toThrow("A note needs text.");
  await expect(
    callTool(client, {}, "notes_set", {
      name: "plan",
      title: "Plan",
      summary: "the plan",
      tags: ["ops", "q4"],
      path: "plan.md",
    }),
  ).resolves.toBe(`saved 30023:${me}:plan`);
  expect(published).toEqual([
    {
      kind: 30023,
      content: "# plan.md",
      tags: [
        ["d", "plan"],
        ["title", "Plan"],
        ["summary", "the plan"],
        ["t", "ops"],
        ["t", "q4"],
        ["published_at", expect.stringMatching(/^\d+$/)],
      ],
    },
  ]);

  const prior = note(me, "plan", 100, [
    ["summary", "the plan"],
    ["t", "ops"],
    ["published_at", "90"],
  ]);
  vi.useFakeTimers();
  vi.setSystemTime(200_000);
  const { client: again, published: updates } = fake([...community, prior], {
    keep: true,
  });
  try {
    await callTool(again, {}, "notes_set", { name: "plan", text: "v2" });
    // The next version waits for the second after v2.
    const v3 = callTool(again, {}, "notes_set", {
      name: "plan",
      text: "v3",
      title: "New",
      summary: "",
      tags: [],
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(v3).resolves.toBe(`saved 30023:${me}:plan`);
  } finally {
    vi.useRealTimers();
  }
  expect(updates).toEqual([
    {
      kind: 30023,
      content: "v2",
      tags: [
        ["d", "plan"],
        ["title", "plan title"],
        ["summary", "the plan"],
        ["t", "ops"],
        ["published_at", "90"],
      ],
    },
    {
      kind: 30023,
      content: "v3",
      tags: [
        ["d", "plan"],
        ["title", "New"],
        ["summary", ""],
        ["published_at", "90"],
      ],
    },
  ]);
  // Only your own note is the one an update replaces.
  expect(vi.mocked(again.query).mock.calls[0]?.[0]).toEqual([
    {
      kinds: [30023],
      authors: [me],
      "#d": ["plan"],
      limit: 1,
      consistency: "strong",
    },
  ]);
});

it("reports a conflict when another write of the same second wins", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_500);
    const { client, published } = fake([...community, note(me, "plan", 100)], {
      keep: true,
    });
    // Both read version 100 and wait for second 101. The relay keeps the
    // lower id of the two and accepts the other as a duplicate.
    const first = callTool(client, {}, "notes_set", {
      name: "plan",
      text: "mine",
    });
    const second = callTool(client, {}, "notes_set", {
      name: "plan",
      text: "theirs",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    await expect(first).resolves.toBe(`saved 30023:${me}:plan`);
    expect(await second).toBeInstanceOf(Error);
    expect(((await second) as Error).message).toBe(
      `conflict: note plan now holds another version (${"1".padStart(64, "e")}, 1970-01-01T00:01Z), not this text. Read it with notes_get, then write again.`,
    );
    expect(published.map((template) => template.content)).toEqual([
      "mine",
      "theirs",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("checks a note write against the writer, not a lagging replica", async () => {
  const { client } = fake([...community, note(me, "plan", 100)], {
    keep: true,
  });
  // A replica still holds version 100; only the writer has the new one.
  const writer = client.query;
  const stale = note(me, "plan", 100);
  client.query = vi.fn(async (filters: readonly Filter[]) =>
    filters.every((filter) => filter.consistency === "strong")
      ? writer(filters)
      : [stale],
  );
  await expect(
    callTool(client, {}, "notes_set", { name: "plan", text: "v2" }),
  ).resolves.toBe(`saved 30023:${me}:plan`);
  expect(client.query).toHaveBeenCalledTimes(2);
});

it("reports a conflict when the note is gone after a write", async () => {
  const { client } = fake(community);
  await expect(
    callTool(client, {}, "notes_set", {
      name: "plan",
      title: "Plan",
      text: "v1",
    }),
  ).rejects.toThrow(
    "conflict: note plan was not found after this write. Read it with notes_get, then write again.",
  );
});

it("dates a note deletion after the note it deletes", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_500);
    // Another writer of this key, with its clock ahead, saved second 102.
    const { client, published } = fake([...community, note(me, "plan", 102)]);
    let done = false;
    const deleting = callTool(client, {}, "notes_rm", { name: "plan" }).then(
      (result) => {
        done = true;
        return result;
      },
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(false);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    await expect(deleting).resolves.toBe(`deleted 30023:${me}:plan`);
    expect(published).toHaveLength(1);
    expect(vi.mocked(client.query).mock.calls[0]?.[0]).toEqual([
      {
        kinds: [30023],
        authors: [me],
        "#d": ["plan"],
        limit: 1,
        consistency: "strong",
      },
    ]);
    // A note dated too far ahead is not waited out.
    const { client: ahead, published: none } = fake([
      ...community,
      note(me, "plan", 200),
    ]);
    await expect(
      callTool(ahead, {}, "notes_rm", { name: "plan" }),
    ).rejects.toThrow("The note was just changed; try again.");
    expect(none).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("deletes only your own note, by its address", async () => {
  const { client, published } = fake([
    ...community,
    note(me, "plan", 100),
    note(alice, "hers", 100),
  ]);
  await expect(
    callTool(client, {}, "notes_rm", { name: "hers" }),
  ).rejects.toThrow("You have no note hers.");
  await expect(
    callTool(client, {}, "notes_rm", { name: "plan" }),
  ).resolves.toBe(`deleted 30023:${me}:plan`);
  expect(published).toEqual([
    { kind: 5, content: "", tags: [["a", `30023:${me}:plan`]] },
  ]);
});

// The hive channel: Bob administers it, and Owner's agent Alice joins it.
const ownerKey = new Uint8Array(32).fill(7);
const owner = bytesToHex(schnorr.getPublicKey(ownerKey));
const attested = async (agent: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`nostr:agent-auth:${agent}:`),
  );
  return [
    "auth",
    owner,
    "",
    bytesToHex(schnorr.sign(new Uint8Array(digest), ownerKey)),
  ];
};
const hive = (roles: Readonly<Record<string, string>>) =>
  event({
    kind: 39002,
    tags: [
      ["d", "chan"],
      ...Object.entries(roles).map(([p, r]) => ["p", p, "", r]),
    ],
  });
const repo = (
  pubkey: string,
  d: string,
  channels: string[],
  extra: string[][] = [],
) =>
  event({
    kind: 30617,
    pubkey,
    id: d.padEnd(64, "0"),
    tags: [["d", d], ...channels.map((c) => ["buzz-channel", c]), ...extra],
  });
const git = (client: BuzzClient) => {
  const gitAuth = vi.fn(async (owner: string, name: string) => ({
    url: `https://relay/git/${owner}/${name}.git`,
    header: "Authorization: Nostr abc",
  }));
  client.gitAuth = gitAuth;
  return gitAuth;
};

/** A fake relay over `events` that then serves what `client` publishes. */
const announcing = (events: BuzzEvent[]) => {
  const { client, published } = fake(events);
  client.publish = vi.fn(async (template: Template) => {
    published.push(template);
    const created = event({
      ...template,
      pubkey: client.pubkey,
      id: published.length.toString(16).padStart(64, "e"),
      created_at: 2_000_000_000 + published.length,
    });
    events.push(created);
    return created;
  });
  return { client, published };
};

it("gives the channel's repository and a Git header signed for it", async () => {
  const { client } = fake([
    hive({ [bob]: "admin", [alice]: "member" }),
    repo(bob, "hive", ["chan"]),
    // Access follows the first binding, so this one belongs elsewhere.
    repo(bob, "other", ["elsewhere", "chan"]),
    // Any member may bind a repository; the channel trusts only its leads.
    repo(alice, "impostor", ["chan"]),
  ]);
  const gitAuth = git(client);
  const answer = await callTool(client, { channel: "chan" }, "repo", {});
  expect(gitAuth).toHaveBeenCalledWith(bob, "hive");
  const url = `https://relay/git/${bob}/hive.git`;
  expect(answer).toBe(
    [
      `hive: ${url}`,
      "For the next 60 seconds, pass this header to each git command (call again for a new one; never save it):",
      `git -c http.${url}.extraHeader='Authorization: Nostr abc' clone ${url}`,
    ].join("\n"),
  );
});

it("trusts a lead's agent, and asks which when there are several", async () => {
  const { client } = fake([
    hive({ [bob]: "admin", [owner]: "owner", [alice]: "member" }),
    repo(alice, "hive", ["chan"], [await attested(alice)]),
    repo(bob, "b", ["chan"]),
  ]);
  const gitAuth = git(client);
  await expect(
    callTool(client, { channel: "chan" }, "repo", {}),
  ).rejects.toThrow(`Choose repo: ${bob}/b, ${alice}/hive`);
  await callTool(client, { channel: "chan" }, "repo", {
    repo: `${alice}/hive`,
  });
  expect(gitAuth).toHaveBeenCalledWith(alice, "hive");
});

it("creates one protected repository for a channel it leads", async () => {
  const { client, published } = announcing([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [me]: "admin" }),
  ]);
  const gitAuth = git(client);
  for (const create of [".hive", "a..b", "a/b", "h".repeat(65)])
    await expect(
      callTool(client, { channel: "chan" }, "repo", { create }),
    ).rejects.toThrow("create must be");
  await expect(
    callTool(client, { channel: "hidden" }, "repo", { create: "hive" }),
  ).rejects.toThrow();
  expect(published).toEqual([]);
  await callTool(client, { channel: "chan" }, "repo", { create: "hive" });
  expect(published).toEqual([
    {
      kind: 30617,
      content: "",
      tags: [
        ["d", "hive"],
        ["name", "hive"],
        ["buzz-channel", "chan"],
        ["buzz-protect", "refs/heads/**", "no-force-push", "no-delete"],
      ],
    },
  ]);
  expect(gitAuth).toHaveBeenCalledWith(me, "hive");
});

it("never moves its own repository, or starts a second one", async () => {
  const { client, published } = fake([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [me]: "admin", [bob]: "admin" }),
    repo(me, "hive", ["elsewhere"]),
  ]);
  git(client);
  await expect(
    callTool(client, { channel: "chan" }, "repo", { create: "hive" }),
  ).rejects.toThrow("You already have a repository named hive.");
  expect(published).toEqual([]);
  const { client: bound } = fake([
    hive({ [bob]: "admin" }),
    repo(bob, "hive", ["chan"]),
  ]);
  git(bound);
  await expect(
    callTool(bound, { channel: "chan" }, "repo", { create: "again" }),
  ).rejects.toThrow("already has a repository");
  await expect(
    callTool(bound, { channel: "empty" }, "repo", {}),
  ).rejects.toThrow("has no repository from its owners or admins");
});

it("lets only a lead or a lead's agent start the channel's repository", async () => {
  const { client, published } = announcing([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [me]: "member", [owner]: "owner" }),
  ]);
  git(client);
  await expect(
    callTool(client, { channel: "chan" }, "repo", { create: "hive" }),
  ).rejects.toThrow("Only a channel's owner or an admin, or their agent");
  expect(published).toEqual([]);
  Object.assign(client, { owner });
  await callTool(client, { channel: "chan" }, "repo", { create: "hive" });
  expect(published).toHaveLength(1);
});

it("reads past a page of untrusted repositories, and never guesses past five", async () => {
  const spam = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      event({
        kind: 30617,
        pubkey: alice,
        id: i.toString(16).padStart(64, "a"),
        created_at: 1000 + i,
        tags: [
          ["d", `spam${i}`],
          ["buzz-channel", "chan"],
        ],
      }),
    );
  const { client } = fake([
    hive({ [bob]: "admin", [me]: "admin" }),
    ...spam(150),
    repo(bob, "hive", ["chan"]),
  ]);
  const gitAuth = git(client);
  await callTool(client, { channel: "chan" }, "repo", {});
  await callTool(client, { channel: "chan" }, "repo", { repo: `${bob}/hive` });
  expect(gitAuth).toHaveBeenNthCalledWith(1, bob, "hive");
  expect(gitAuth).toHaveBeenNthCalledWith(2, bob, "hive");

  const { client: flooded, published } = fake([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [bob]: "admin", [me]: "admin" }),
    ...spam(500),
    repo(bob, "hive", ["chan"]),
  ]);
  git(flooded);
  await expect(
    callTool(flooded, { channel: "chan" }, "repo", {}),
  ).rejects.toThrow("could not all be read");
  await expect(
    callTool(flooded, { channel: "chan" }, "repo", { create: "mine" }),
  ).rejects.toThrow("could not all be read");
  expect(published).toEqual([]);
});

it("starts one repository at a time, from the relay's writer, and confirms it", async () => {
  const led = (channel: string) => [
    event({ kind: 39000, id: channel.padEnd(64, "1"), tags: [["d", channel]] }),
    event({
      kind: 39002,
      id: channel.padEnd(64, "2"),
      tags: [
        ["d", channel],
        ["p", me, "", "admin"],
      ],
    }),
  ];
  const { client, published } = announcing([...led("chan"), ...led("other")]);
  git(client);
  const results = await Promise.allSettled([
    callTool(client, { channel: "chan" }, "repo", { create: "hive" }),
    callTool(client, { channel: "other" }, "repo", { create: "hive" }),
  ]);
  expect(published).toHaveLength(1);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect((results[1] as PromiseRejectedResult).reason.message).toBe(
    "You already have a repository named hive.",
  );
  const reads = vi
    .mocked(client.query)
    .mock.calls.flatMap(([filters]) => filters)
    .filter((filter) =>
      (filter.kinds as number[] | undefined)?.includes(30617),
    );
  expect(reads.every((filter) => filter.consistency === "strong")).toBe(true);

  // Another session of it rebinds the name before the relay is read back.
  const { client: raced } = announcing(led("chan"));
  git(raced);
  const publish = raced.publish;
  raced.publish = vi.fn(async (template: Template) => {
    const created = await publish(template);
    await publish({
      ...template,
      tags: template.tags.map((t) =>
        t[0] === "buzz-channel" ? ["buzz-channel", "elsewhere"] : t,
      ),
    });
    return created;
  });
  await expect(
    callTool(raced, { channel: "chan" }, "repo", { create: "hive" }),
  ).rejects.toThrow("hive was announced, but the relay binds it elsewhere.");
});

it("says how to get the header when only that failed", async () => {
  const { client } = announcing([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    hive({ [me]: "admin" }),
  ]);
  client.gitAuth = vi.fn(async () => {
    throw new Error("offline.");
  });
  await expect(
    callTool(client, { channel: "chan" }, "repo", { create: "hive" }),
  ).rejects.toThrow(
    "Started hive, but its Git header failed: offline. Call repo again without create.",
  );
});

it("refuses Git where the host holds no key", async () => {
  const { client } = fake([
    hive({ [bob]: "admin" }),
    repo(bob, "hive", ["chan"]),
  ]);
  await expect(
    callTool(client, { channel: "chan" }, "repo", {}),
  ).rejects.toThrow("Git access needs Buzz Desktop.");
});

it("validates creation inputs and reports hosts without agent creation", async () => {
  const { client } = fake([]);
  await expect(
    callTool(client, {}, "agent_create", {
      type: "codex/codex",
      name: "Child",
    }),
  ).rejects.toThrow("unavailable");
  await expect(callTool(client, {}, "agent_types", {})).rejects.toThrow(
    "unavailable",
  );
  client.createAgent = vi.fn();
  for (const args of [{}, { type: "x", name: " " }, { type: 1, name: "Child" }])
    await expect(callTool(client, {}, "agent_create", args)).rejects.toThrow(
      "required",
    );
  expect(client.createAgent).not.toHaveBeenCalled();
});

it("hands off to the agent in another of its conversations it can see", async () => {
  const solo = event({
    kind: 39000,
    tags: [["d", "solo"], ["t", "stream"], ["t", "buzz.solo"], ["private"]],
  });
  const reply = event({
    id: nested,
    tags: [
      ["h", "chan"],
      ["e", root, "", "reply"],
    ],
  });
  const other = "3".repeat(64);
  const inSolo = event({ id: "4".repeat(64), tags: [["h", "solo"]] });
  const { client } = fake([
    event({ kind: 39000, tags: [["d", "chan"]] }),
    solo,
    event({ id: root }),
    reply,
    event({ id: other, tags: [["h", "elsewhere"]] }),
    inSolo,
  ]);
  const wake = (context: object, args: object) =>
    callTool(client, context, "self_handoff", { text: "carry on", ...args });
  await expect(wake({}, { channel: "chan" })).rejects.toThrow("unavailable");
  client.handoff = vi.fn();
  await expect(wake({}, { channel: "nope" })).rejects.toThrow(
    "No channel nope",
  );
  await expect(
    wake({}, { channel: "chan", thread: "9".repeat(64) }),
  ).rejects.toThrow("No message");
  await expect(wake({}, { channel: "chan", thread: other })).rejects.toThrow(
    `${other} is not in chan.`,
  );
  await expect(wake({}, { channel: "chan" })).rejects.toThrow(
    "thread is required outside a Solo chat.",
  );
  await expect(
    wake({ channel: "chan", root }, { channel: "chan", thread: nested }),
  ).rejects.toThrow("That is this conversation.");
  // A session with no root, as in a Solo chat, a DM or channel scope, or one
  // marked whole, is the whole channel, whatever thread is named.
  for (const context of [
    { channel: "solo", topLevel: true },
    { channel: "chan" },
    { channel: "chan", root: "5".repeat(64), wholeChannel: true },
  ])
    await expect(
      wake(context, { channel: context.channel, thread: inSolo.id }),
    ).rejects.toThrow(
      context.channel === "solo" ? "That is this conversation." : "is not in",
    );
  await expect(
    wake({ channel: "chan" }, { channel: "chan", thread: nested }),
  ).rejects.toThrow("That is this conversation.");
  await expect(
    wake(
      { channel: "chan", root: "5".repeat(64), wholeChannel: true },
      { channel: "chan", thread: nested },
    ),
  ).rejects.toThrow("That is this conversation.");
  await expect(
    callTool(client, {}, "self_handoff", { channel: "chan", thread: root }),
  ).rejects.toThrow("text is required.");
  expect(client.handoff).not.toHaveBeenCalled();
  // Any message of the thread names its root, and the wake says where it
  // came from.
  await wake(
    { channel: "solo", topLevel: true },
    { channel: "chan", thread: nested },
  );
  await wake({ channel: "chan", root }, { channel: "solo" });
  await wake({}, { channel: "chan", thread: root });
  expect(vi.mocked(client.handoff).mock.calls).toEqual([
    [{ channel: "chan", root, text: "carry on", from: { channel: "solo" } }],
    [{ channel: "solo", text: "carry on", from: { channel: "chan", root } }],
    [{ channel: "chan", root, text: "carry on", from: {} }],
  ]);
});
it("validates change drafts and passes only the proposed fields", async () => {
  const { client } = fake([]);
  await expect(
    callTool(client, {}, "agent_update", { agent: "Child", name: "Kid" }),
  ).rejects.toThrow("unavailable");
  client.updateAgent = vi.fn(async () => ({
    requestId: "draft",
    saved: false as const,
  }));
  for (const args of [{}, { agent: " ", name: "Kid" }, { agent: 1 }])
    await expect(callTool(client, {}, "agent_update", args)).rejects.toThrow(
      "required",
    );
  expect(client.updateAgent).not.toHaveBeenCalled();
  await callTool(client, {}, "agent_update", {
    agent: " Child ",
    name: " Kid ",
    type: " ",
    instructions: "Review PRs.",
  });
  expect(client.updateAgent).toHaveBeenCalledWith({
    agent: "Child",
    name: "Kid",
    instructions: "Review PRs.",
  });
  await callTool(client, {}, "agent_update", {
    agent: "Child",
    instructions: "",
  });
  expect(client.updateAgent).toHaveBeenLastCalledWith({
    agent: "Child",
    instructions: "",
  });
});
