import { afterEach, expect, it, vi } from "vitest";
import { naddrEncode, npubEncode } from "nostr-tools/nip19";
import type {
  BuzzClient,
  BuzzEvent,
  Filter,
  Template,
} from "../../buzz-mcp/client";
import { NOTE_TOOLS } from ".";

const own = "a".repeat(64);
const other = "b".repeat(64);
const old: BuzzEvent = {
  id: "1".repeat(64),
  pubkey: own,
  kind: 30023,
  created_at: 100,
  tags: [
    ["d", "recipe"],
    ["title", "Old recipe"],
    ["t", "art"],
    ["published_at", "90"],
    ["auth", "old"],
  ],
  content: "Old body",
  sig: "",
};
function fixture(events: BuzzEvent[] = []) {
  let stored = [...events];
  let index = 2;
  const query = vi.fn(async (_filters: Filter[]) => stored);
  const publish = vi.fn(async (template: Template) => {
    const saved = {
      ...template,
      pubkey: own,
      created_at: Math.floor(Date.now() / 1000),
      id: String(index++).repeat(64),
      sig: "",
    };
    stored = [saved];
    return saved;
  });
  const read = vi.fn(async () =>
    new TextEncoder().encode("# File recipe\n{{icon_description}}"),
  );
  const client = { pubkey: own, query, publish, read } as unknown as BuzzClient;
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = NOTE_TOOLS.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.call(client, {}, args) as Promise<string>;
  };
  return { call, query, publish, read };
}
afterEach(() => vi.useRealTimers());
const save = {
  action: "save",
  note: "recipe",
  title: "Recipe",
  text: "# Recipe\n{{icon_description}}",
  expected_event: "absent",
};

it("registers note tools in the plugin", () => {
  expect(
    NOTE_TOOLS.filter((tool) => ["notes", "note"].includes(tool.name)),
  ).toHaveLength(2);
});
it("creates, discovers and reads a recipe by its returned naddr", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(200_000);
  const f = fixture();
  const saved = JSON.parse(await f.call("note", save));
  expect(saved).toMatchObject({
    status: "confirmed",
    coordinate: `30023:${own}:recipe`,
  });
  expect(f.publish).toHaveBeenCalledExactlyOnceWith({
    kind: 30023,
    content: save.text,
    tags: [
      ["d", "recipe"],
      ["title", "Recipe"],
      ["published_at", "200"],
    ],
  });
  const listed = JSON.parse(await f.call("notes", {}));
  expect(listed).toMatchObject({
    partial: false,
    notes: [{ event_id: saved.event_id }],
  });
  expect(
    JSON.parse(await f.call("note", { note: `nostr:${saved.naddr}` })),
  ).toMatchObject({ text: save.text, event_id: saved.event_id });
});
it.each(["Frosted Icons", "Recipe", "2026:plan", "recipe\n", "a".repeat(81)])(
  "rejects non-CLI slugs for plain references and coordinate saves: %s",
  async (identifier) => {
    const f = fixture();
    await expect(f.call("note", { note: identifier })).rejects.toThrow("slug");
    for (const note of [
      `30023:${own}:${identifier}`,
      naddrEncode({ kind: 30023, pubkey: own, identifier }),
    ]) {
      await expect(f.call("note", { ...save, note })).rejects.toThrow("slug");
    }
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  },
);
it.each(["frosted-icons_2.5", "a".repeat(80)])(
  "accepts CLI-compatible slugs: %s",
  async (note) => {
    const f = fixture();
    expect(JSON.parse(await f.call("note", { ...save, note })).coordinate).toBe(
      `30023:${own}:${note}`,
    );
  },
);
it.each(["Frosted Icons", "2026:plan", "X".repeat(201), ""])(
  "reads other clients' identifiers through coordinates and naddr: %s",
  async (identifier) => {
    const f = fixture([{ ...old, tags: [["d", identifier]] }]);
    for (const note of [
      `30023:${own}:${identifier}`,
      naddrEncode({ kind: 30023, pubkey: own, identifier }),
    ]) {
      expect(JSON.parse(await f.call("note", { note })).event_id).toBe(old.id);
    }
  },
);
it("reads another author's exact coordinate without following naddr relay hints", async () => {
  const f = fixture([{ ...old, pubkey: other }]);
  const naddr = naddrEncode({
    kind: 30023,
    pubkey: other,
    identifier: "recipe",
    relays: ["wss://elsewhere"],
  });
  expect(JSON.parse(await f.call("note", { note: naddr }))).toMatchObject({
    author: other,
    text: old.content,
  });
  expect(f.query).toHaveBeenCalledWith([
    { kinds: [30023], authors: [other], "#d": ["recipe"], limit: 1 },
  ]);
  await expect(f.call("note", { ...save, note: naddr })).rejects.toThrow(
    "only your own",
  );
  expect(f.publish).not.toHaveBeenCalled();
});
it("updates a read revision from a file, retaining note metadata", async () => {
  const f = fixture([old]);
  const { text: _, ...args } = save;
  const saved = JSON.parse(
    await f.call("note", {
      ...args,
      expected_event: old.id,
      path: "recipe.md",
    }),
  );
  expect(saved.status).toBe("confirmed");
  expect(f.query).toHaveBeenCalledWith([
    {
      kinds: [30023],
      authors: [own],
      "#d": ["recipe"],
      limit: 1,
      consistency: "strong",
    },
  ]);
  expect(f.read).toHaveBeenCalledWith("recipe.md");
  expect(f.publish).toHaveBeenCalledWith({
    kind: 30023,
    content: "# File recipe\n{{icon_description}}",
    tags: [
      ["d", "recipe"],
      ["title", "Recipe"],
      ["t", "art"],
      ["published_at", "90"],
    ],
  });
});
it("reads the writer's own revision before editing when the replica lags", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(200_000);
  const f = fixture([old]);
  const writerQuery = f.query.getMockImplementation();
  if (!writerQuery) throw new Error("Missing writer query");
  f.query.mockImplementation(async (filters) =>
    filters[0]?.consistency === "strong" ? writerQuery(filters) : [old],
  );
  const saved = JSON.parse(
    await f.call("note", { ...save, expected_event: old.id }),
  );
  expect(saved.status).toBe("confirmed");
  const loaded = JSON.parse(await f.call("note", { note: saved.naddr }));
  expect(loaded.event_id).toBe(saved.event_id);
  vi.setSystemTime(201_000);
  expect(
    JSON.parse(
      await f.call("note", { ...save, expected_event: loaded.event_id }),
    ).status,
  ).toBe("confirmed");
});
it.each(["absent", "9".repeat(64)])(
  "refuses stale expected_event %s without publishing",
  async (expected_event) => {
    const f = fixture([old]);
    await expect(f.call("note", { ...save, expected_event })).rejects.toThrow(
      "Note changed",
    );
    expect(f.publish).not.toHaveBeenCalled();
  },
);
it("refuses a missing expected revision and unreadable preflight", async () => {
  const f = fixture();
  await expect(
    f.call("note", { ...save, expected_event: old.id }),
  ).rejects.toThrow("Note changed");
  f.query.mockRejectedValue(new Error("access denied"));
  await expect(f.call("note", save)).rejects.toThrow("access denied");
  expect(f.publish).not.toHaveBeenCalled();
});
it("does not publish a replacement until the signer's clock passes the head", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const f = fixture([old]);
  await expect(
    f.call("note", { ...save, expected_event: old.id }),
  ).rejects.toThrow("timestamp");
  expect(f.publish).not.toHaveBeenCalled();
});
it("reports accepted but unconfirmed when a competing revision wins", async () => {
  const f = fixture();
  f.query.mockResolvedValueOnce([]).mockResolvedValueOnce([old]);
  expect(JSON.parse(await f.call("note", save))).toMatchObject({
    status: "accepted_unconfirmed",
    event_id: "2".repeat(64),
  });
  expect(f.publish).toHaveBeenCalledTimes(1);
});
it("retains the accepted event reference when readback fails and propagates publication failure", async () => {
  const f = fixture();
  f.query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("offline"));
  expect(JSON.parse(await f.call("note", save))).toMatchObject({
    status: "accepted_unconfirmed",
    coordinate: `30023:${own}:recipe`,
  });
  f.query.mockResolvedValue([]);
  f.publish.mockRejectedValueOnce(new Error("publish uncertain"));
  await expect(f.call("note", save)).rejects.toThrow("publish uncertain");
  expect(f.publish).toHaveBeenCalledTimes(2);
});
it("bounds discovery, names partial results, and filters returned authors", async () => {
  const f = fixture([{ ...old, pubkey: other }]);
  const result = JSON.parse(
    await f.call("notes", {
      author: npubEncode(other),
      limit: 1,
      q: "art",
      before: 100,
    }),
  );
  expect(result).toMatchObject({ partial: true, notes: [{ author: other }] });
  expect(f.query).toHaveBeenCalledWith([
    { kinds: [30023], authors: [other], search: "art", until: 100, limit: 1 },
  ]);
  expect(JSON.parse(await f.call("notes", {})).notes).toEqual([]);
});
it.each([
  { ...save, text: undefined, path: undefined },
  { ...save, path: "x" },
  { ...save, text: "é".repeat(32769) },
  { ...save, title: "" },
  { ...save, note: "bad\nidentifier" },
  { ...save, expected_event: undefined },
  { ...save, note: `30024:${own}:recipe` },
  { note: "recipe", text: "cannot write in read mode" },
  { action: "delete", note: "recipe" },
])("rejects invalid note arguments before publishing: %j", async (args) => {
  const f = fixture();
  await expect(f.call("note", args)).rejects.toThrow();
  expect(f.publish).not.toHaveBeenCalled();
});
it("reports missing notes and rejects another kind of naddr", async () => {
  const f = fixture();
  await expect(f.call("note", { note: "missing" })).rejects.toThrow(
    "not found",
  );
  await expect(
    f.call("note", {
      note: naddrEncode({ pubkey: own, kind: 30024, identifier: "recipe" }),
    }),
  ).rejects.toThrow("30023");
});
it.each([
  { limit: 0 },
  { limit: 101 },
  { limit: 1.5 },
  { before: -1 },
  { author: "bad" },
  { q: "" },
  { channel: "secret" },
])("rejects invalid discovery arguments %j", async (args) => {
  const f = fixture();
  await expect(f.call("notes", args)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
