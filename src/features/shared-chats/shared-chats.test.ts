import { appClient } from "../../buzz-mcp/app-client";
import type { AgentHandle } from "../agents/service";
import { audienceAuthorityFilter } from "./audience-authority";
import { describe, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools";
import { matchesEvent } from "../relay/projection";
import { createRelaySession } from "../relay/session";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { listSharedChats, readSharedChat } from "./shared-chats";
import {
  sharedChatIds,
  sharedChatTags,
  chatReferenceIds,
} from "./shared-chat-marker";
import { soloChatLinkMessage } from "../solo/share";
import { SOLO_LABEL } from "../solo/labels";

const key = new Uint8Array(32).fill(1);
const event = (kind: number, tags: string[][], content = "", created_at = 10) =>
  finalizeEvent({ kind, tags, content, created_at }, key);
const authority = event(0, []).pubkey;
const viewer = "2".repeat(64);
const other = "3".repeat(64);
const link = soloChatLinkMessage("source");
const share = (time = 10, extra: string[][] = []) =>
  event(
    9,
    [["h", "destination"], ...sharedChatTags(link, ["source"]), ...extra],
    link,
    time,
  );
function fixture() {
  let records: RelayEvent[] = [];
  const current = new Map<string, { members: string[]; isPublic: boolean }>();
  const setAccess = (
    id: string,
    members = [viewer, authority],
    isPublic = false,
    title = id,
  ) => {
    current.set(id, { members, isPublic });
    records = records.filter(
      (e) =>
        ![39000, 39002].includes(e.kind) ||
        !e.tags.some(([k, v]) => k === "d" && v === id),
    );
    records.push(
      event(39000, [
        ["d", id],
        [isPublic ? "public" : "private"],
        ["t", "stream"],
        ["name", title],
        ...(id !== "destination" ? [["t", SOLO_LABEL]] : []),
      ]),
      event(39002, [["d", id], ...members.map((m) => ["p", m])]),
    );
  };
  setAccess("destination");
  setAccess("source", undefined, false, "Opening topic");
  const query = vi.fn(async (filters: readonly object[]) => {
    const filter = filters[0] as ReadFilter;
    return records
      .filter((e) => matchesEvent(e, filter))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(0, filter.limit);
  });
  return {
    reader: {
      pubkey: viewer,
      relayAuthor: authority,
      query,
      authorizeAudience: vi.fn(
        async (destination: string, sources: readonly string[]) => {
          const dest = current.get(destination);
          return new Set(
            sources.filter((id) => {
              const src = current.get(id);
              return (
                !!src &&
                !!dest &&
                !dest.isPublic &&
                !src.isPublic &&
                dest.members.includes(viewer) &&
                src.members.includes(viewer) &&
                dest.members.every((key) => src.members.includes(key))
              );
            }),
          );
        },
      ),
    },
    setCurrentAccess: (id: string, members: string[], isPublic = false) =>
      current.set(id, { members, isPublic }),
    setAccess,
    add: (...events: RelayEvent[]) => records.push(...events),
    remove: (id: string) => {
      records = records.filter((e) => e.id !== id);
    },
    query,
  };
}

describe("explicit shared chat markers", () => {
  it("requires matching signed intent and current visible card text", () => {
    expect(sharedChatIds(share())).toEqual(["source"]);
    expect(sharedChatIds(event(9, [["h", "destination"]], link))).toEqual([
      "source",
    ]);
    expect(sharedChatIds(share(), "removed")).toEqual([]);
    expect(sharedChatIds(share(), soloChatLinkMessage("different"))).toEqual(
      [],
    );
    expect(() => sharedChatTags(link, ["different"])).toThrow(/match/);
  });
  it.each([
    `> ${link}`,
    `\`${link}\``,
    `\`\`\`\n${link}\n\`\`\``,
    `- ${link}`,
    `||${link}||`,
  ])("ignores quoted or hidden references: %s", (text) => {
    expect(chatReferenceIds(text)).toEqual([]);
  });
});

describe("historical chat cards", () => {
  const legacy = () => event(9, [["h", "destination"]], `${link}\nA caption`);
  it("lists and reads older cards through the existing access checks and receipts", async () => {
    const f = fixture();
    const original = legacy();
    f.add(original, event(9, [["h", "source"]], "Earlier chat work"));
    const result = await listSharedChats(f.reader, "destination");
    expect(result.entries).toMatchObject([
      { id: "source", title: "Opening topic" },
    ]);
    const read = await readSharedChat(f.reader, "destination", "source", {
      shareIds: [original.id],
    });
    expect(JSON.stringify(read)).toContain("Earlier chat work");
    f.setAccess("source", [other]);
    expect((await listSharedChats(f.reader, "destination")).entries).toEqual(
      [],
    );
    await expect(
      readSharedChat(f.reader, "destination", "source", {
        shareIds: [original.id],
      }),
    ).rejects.toThrow();
  });
  it("does not turn plain links, quoted cards or edited-in cards into associations", () => {
    for (const content of [
      "buzz://channel/source",
      `[Notes](buzz://channel/source)`,
      `> ${link}`,
      `\`${link}\``,
    ])
      expect(sharedChatIds(event(9, [["h", "destination"]], content))).toEqual(
        [],
      );
    expect(sharedChatIds(legacy(), soloChatLinkMessage("different"))).toEqual(
      [],
    );
    expect(
      sharedChatIds(event(9, [["h", "destination"]], "No card"), link),
    ).toEqual([]);
  });
  it("folds edits, deleted edits and deletions for historical cards", async () => {
    const f = fixture();
    const original = legacy();
    const edit = event(40003, [["e", original.id]], "removed", 11);
    f.add(original, edit);
    expect((await listSharedChats(f.reader, "destination")).entries).toEqual(
      [],
    );
    f.add(event(5, [["e", edit.id]], "", 12));
    expect(
      (await listSharedChats(f.reader, "destination")).entries,
    ).toHaveLength(1);
    f.add(event(5, [["e", original.id]], "", 13));
    expect((await listSharedChats(f.reader, "destination")).entries).toEqual(
      [],
    );
  });
});

it("lists current titles from metadata without reading source messages; includes thread shares and archives", async () => {
  const f = fixture();
  f.add(share(10, [["e", "a".repeat(64), "", "reply"]]));
  f.setAccess("source", undefined, false, "Renamed now");
  const result = await listSharedChats(f.reader, "destination");
  expect(result).toMatchObject({
    entries: [{ id: "source", title: "Renamed now" }],
    complete: true,
    errors: [],
  });
  expect(
    f.query.mock.calls.every(
      ([filters]) => !(filters[0] as ReadFilter)["#h"]?.includes("source"),
    ),
  ).toBe(true);
});

it("pages equal timestamps by ascending IDs and merges duplicate source shares within a page", async () => {
  const f = fixture();
  const a = share(10, [["nonce", "a"]]),
    b = share(10, [["nonce", "b"]]);
  f.add(a, b);
  const first = await listSharedChats(f.reader, "destination", { limit: 1 });
  expect(first.complete).toBe(false);
  const second = await listSharedChats(f.reader, "destination", {
    limit: 1,
    cursor: first.cursor,
  });
  expect(first.entries[0]?.shares[0]?.id).not.toBe(
    second.entries[0]?.shares[0]?.id,
  );
  expect(second.complete).toBe(true);
  const all = await listSharedChats(f.reader, "destination");
  expect(all.entries).toHaveLength(1);
  expect(all.entries[0]?.shares).toHaveLength(2);
});

it("folds edits, deleted edits and final share deletion using the canonical owner", async () => {
  const f = fixture();
  const original = share();
  f.add(original);
  const edit = event(
    40003,
    [
      ["h", "destination"],
      ["e", original.id],
    ],
    "removed",
    11,
  );
  f.add(edit);
  expect((await listSharedChats(f.reader, "destination")).entries).toEqual([]);
  f.add(event(5, [["e", edit.id]], "", 12));
  expect((await listSharedChats(f.reader, "destination")).entries).toHaveLength(
    1,
  );
  f.add(event(5, [["e", original.id]], "", 13));
  expect((await listSharedChats(f.reader, "destination")).entries).toEqual([]);
});

it("hides inaccessible source titles and does not report their count", async () => {
  const f = fixture();
  f.add(share());
  f.setAccess("source", [other], false, "secret");
  const result = await listSharedChats(f.reader, "destination", {
    query: "secret",
  });
  expect(result).toMatchObject({ entries: [], complete: true, errors: [] });
});

it("missing rosters and network failures are incomplete, generic errors", async () => {
  const f = fixture();
  f.add(share());
  const query = f.query.getMockImplementation();
  if (!query) throw new Error("Missing fixture reader");
  f.query.mockImplementation(async (filters) => {
    if ((filters[0] as ReadFilter)["#d"]?.includes("source"))
      throw new Error("secret title and source ID");
    return query(filters);
  });
  const result = await listSharedChats(f.reader, "destination");
  expect(result.entries).toEqual([]);
  expect(result.complete).toBe(false);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(result.errors).toHaveLength(1);
});

it("requires trusted relay authority before making a read", async () => {
  const f = fixture();
  await expect(
    listSharedChats({ ...f.reader, relayAuthor: undefined }, "destination"),
  ).rejects.toThrow(/access/);
  expect(f.query).not.toHaveBeenCalled();
});

it("withholds private-source discovery and retrieval for a public answer destination", async () => {
  const f = fixture();
  f.add(share());
  f.setAccess("destination", undefined, true);
  expect(
    (
      await listSharedChats(f.reader, "destination", {
        audience: "destination",
      })
    ).entries,
  ).toEqual([]);
  await expect(
    readSharedChat(f.reader, "destination", "source"),
  ).rejects.toThrow(/access/);
  // Personal UI still shows a source the person can read.
  expect((await listSharedChats(f.reader, "destination")).entries).toHaveLength(
    1,
  );
});

it("rejects public streams even when a copied card labels them as chats", async () => {
  const f = fixture();
  f.add(share(), event(9, [["h", "source"]], "ordinary public channel"));
  f.setAccess("source", [other], true);
  expect((await listSharedChats(f.reader, "destination")).entries).toEqual([]);
  await expect(
    readSharedChat(f.reader, "destination", "source"),
  ).rejects.toThrow(/access/);
});

it("requires complete audience coverage even if agent personally has access", async () => {
  const f = fixture();
  f.add(share());
  f.setAccess("destination", [viewer, authority, other]);
  await expect(
    readSharedChat(f.reader, "destination", "source"),
  ).rejects.toThrow(/audience/);
});

it("returns canonical edited evidence and citations following chosen-name policy", async () => {
  const f = fixture();
  const message = event(9, [["h", "source"]], "old");
  f.add(
    share(),
    message,
    event(
      40003,
      [
        ["h", "source"],
        ["e", message.id],
      ],
      "new",
      11,
    ),
  );
  const result = await readSharedChat(f.reader, "destination", "source");
  expect(result.messages).toEqual([
    { id: message.id, author: authority, createdAt: 10, content: "new" },
  ]);
  expect(result.citation).toBe(link);
});

it("rechecks audience after a deferred content read", async () => {
  const f = fixture();
  f.add(share(), event(9, [["h", "source"]], "protected"));
  const query = f.query.getMockImplementation();
  if (!query) throw new Error("Missing fixture reader");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.query.mockImplementation(async (filters) => {
    const result = await query(filters);
    if ((filters[0] as ReadFilter)["#h"]?.includes("source")) {
      started();
      await held;
    }
    return result;
  });
  const result = readSharedChat(f.reader, "destination", "source");
  await reading;
  f.setAccess("destination", [viewer, authority, other]);
  release();
  await expect(result).rejects.toThrow(/access/);
});

it("rejects an ignored composite cursor instead of claiming complete coverage", async () => {
  const f = fixture();
  f.add(share());
  const query = f.query.getMockImplementation();
  if (!query) throw new Error("Missing fixture reader");
  f.query.mockImplementation((filters) =>
    query(
      filters.map((filter) => {
        const {
          before_id: _before,
          until: _until,
          ...rest
        } = filter as ReadFilter;
        return rest;
      }),
    ),
  );
  await expect(
    listSharedChats(f.reader, "destination", {
      limit: 1,
      cursor: { until: share().created_at, before_id: share().id },
    }),
  ).rejects.toThrow(/paging/);
});

it("does not retrieve unshared sources even when the agent has access", async () => {
  const f = fixture();
  await expect(
    readSharedChat(f.reader, "destination", "source"),
  ).rejects.toThrow(/association/);
});

it("uses the real read-only RelaySession adapter without a membership writer", async () => {
  const f = fixture();
  f.add(share());
  const owner = createRelaySession({
    viewer,
    relayAuthor: authority,
    query: f.query,
    media: () => undefined,
  });
  try {
    const result = await listSharedChats(owner.session, "destination");
    expect(result.entries[0]?.title).toBe("Opening topic");
    expect(result.complete).toBe(true);
  } finally {
    owner.dispose();
  }
});

it("fails closed for an absent source roster", async () => {
  const f = fixture();
  f.add(share());
  const query = f.query.getMockImplementation();
  if (!query) throw new Error("Missing fixture reader");
  f.query.mockImplementation(async (filters) => {
    const result = await query(filters);
    return (filters[0] as ReadFilter)["#d"]?.includes("source")
      ? result.filter(
          (e) =>
            e.kind !== 39002 ||
            !e.tags.some(([k, v]) => k === "d" && v === "source"),
        )
      : result;
  });
  expect(await listSharedChats(f.reader, "destination")).toMatchObject({
    entries: [],
    complete: false,
  });
  await expect(
    readSharedChat(f.reader, "destination", "source"),
  ).rejects.toThrow(/access/);
});

it("bounds large evidence and explicitly marks excerpts as truncated", async () => {
  const f = fixture();
  f.add(share(), event(9, [["h", "source"]], "x".repeat(10000)));
  const result = await readSharedChat(f.reader, "destination", "source");
  expect(result.messages[0]?.content.length).toBe(8192);
  expect(result.messages[0]?.truncated).toBe(true);
  expect(result.complete).toBe(false);
});

it("rejects a share deleted during source retrieval", async () => {
  const f = fixture();
  const original = share();
  f.add(original, event(9, [["h", "source"]], "protected"));
  const query = f.query.getMockImplementation();
  if (!query) throw new Error("Missing fixture reader");
  f.query.mockImplementation(async (filters) => {
    const result = await query(filters);
    if ((filters[0] as ReadFilter)["#h"]?.includes("source"))
      f.add(event(5, [["e", original.id]], "", 12));
    return result;
  });
  await expect(
    readSharedChat(f.reader, "destination", "source"),
  ).rejects.toThrow(/association changed/);
});

it.each(["list", "read"])(
  "uses one final audience/source snapshot for %s",
  async (mode) => {
    const f = fixture();
    f.add(share(), event(9, [["h", "source"]], "protected content"));
    const query = f.query.getMockImplementation();
    if (!query) throw new Error("Missing fixture reader");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.query.mockImplementation(async (filters) => {
      const ids = (filters[0] as ReadFilter)["#d"];
      if (ids?.includes("source") && ids.includes("destination")) {
        started();
        await gate;
      }
      return query(filters);
    });
    const operation =
      mode === "list"
        ? listSharedChats(f.reader, "destination", {
            audience: "destination",
          })
        : readSharedChat(f.reader, "destination", "source");
    await entered;
    if (mode === "list") f.setAccess("destination", [viewer, authority, other]);
    else f.setAccess("source", [authority]);
    release();
    if (mode === "list")
      expect(
        ((await operation) as Awaited<ReturnType<typeof listSharedChats>>)
          .entries,
      ).toEqual([]);
    else await expect(operation).rejects.toThrow(/access/);
    const last = f.query.mock.calls.at(-1)?.[0][0] as ReadFilter;
    expect(last["#d"]).toEqual(
      expect.arrayContaining(["source", "destination"]),
    );
  },
);

it("pages past ordinary messages without post-LIMIT topic filtering", async () => {
  const f = fixture();
  f.add(share(1), event(9, [["h", "destination"]], "ordinary", 20));
  const first = await listSharedChats(f.reader, "destination", { limit: 1 });
  expect(first.entries).toHaveLength(1);
  expect(first.scanned).toBe(2);
  expect(
    f.query.mock.calls.every(
      ([filters]) =>
        !(filters[0] as ReadFilter)["#t"] && !(filters[0] as ReadFilter)["#s"],
    ),
  ).toBe(true);
});

it("reads a contributing receipt directly and rejects removed or wrong-channel receipts", async () => {
  const f = fixture();
  const receipt = share(1);
  f.add(receipt, event(9, [["h", "source"]], "evidence"));
  const result = await readSharedChat(f.reader, "destination", "source", {
    shareIds: [receipt.id],
  });
  expect(result.messages[0]?.content).toBe("evidence");
  expect(
    f.query.mock.calls.every(([filters]) => {
      const q = filters[0] as ReadFilter;
      return !q["#h"]?.includes("destination") || !!q.ids;
    }),
  ).toBe(true);
  f.add(event(5, [["e", receipt.id]]));
  await expect(
    readSharedChat(f.reader, "destination", "source", {
      shareIds: [receipt.id],
    }),
  ).rejects.toThrow(/association/);
  const wrong = event(
    9,
    [["h", "elsewhere"], ...sharedChatTags(link, ["source"])],
    link,
  );
  f.add(wrong);
  await expect(
    readSharedChat(f.reader, "destination", "source", {
      shareIds: [wrong.id],
    }),
  ).rejects.toThrow(/association/);
});

it("bounds automatic scanning and resumes beyond the budget", async () => {
  const f = fixture();
  const ordinary = event(9, [["h", "destination"]], "ordinary", 20);
  f.add(
    ...Array.from({ length: 1000 }, (_, i) => ({
      ...ordinary,
      id: i.toString(16).padStart(64, "0"),
    })),
    share(1),
  );
  const first = await listSharedChats(f.reader, "destination");
  expect(first).toMatchObject({ entries: [], scanned: 1000, complete: false });
  expect(first.cursor).toBeDefined();
  const next = await listSharedChats(f.reader, "destination", {
    cursor: first.cursor,
  });
  expect(next.entries).toHaveLength(1);
  expect(next.complete).toBe(true);
});

it("stops between multi-chat share messages before the authority row cap", async () => {
  const f = fixture();
  for (let n = 0; n < 20; n++) {
    const ids = Array.from({ length: 32 }, (_, i) => `source-${n}-${i}`);
    const content = ids.map((id) => soloChatLinkMessage(id)).join("\n\n");
    f.add(
      event(
        9,
        [["h", "destination"], ...sharedChatTags(content, ids)],
        content,
        100 - n,
      ),
    );
  }
  const result = await listSharedChats(f.reader, "destination");
  expect(result.scanned).toBe(1);
  expect(result.cursor).toBeDefined();
  expect(result.complete).toBe(false);
  expect(
    f.query.mock.calls.every(
      ([filters]) => (filters[0] as ReadFilter).limit <= 1000,
    ),
  ).toBe(true);
});

it("bounds historical card associations without trapping older valid shares", async () => {
  const f = fixture();
  const oversized = Array.from({ length: 510 }, (_, i) =>
    soloChatLinkMessage(`old-${i}`),
  ).join("\n\n");
  f.add(event(9, [["h", "destination"]], oversized, 20), share(10));
  const first = await listSharedChats(f.reader, "destination");
  expect(first.errors).toEqual([]);
  expect(
    sharedChatIds(event(9, [["h", "destination"]], oversized)),
  ).toHaveLength(32);
  expect(first.cursor).toBeDefined();
  const older = await listSharedChats(f.reader, "destination", {
    cursor: first.cursor,
  });
  expect(older.entries.map(({ id }) => id)).toEqual(["source"]);
  expect(older.complete).toBe(true);
});

it.each(["destination addition", "source removal", "visibility change"])(
  "rejects stale signed rosters after current %s",
  async (change) => {
    const f = fixture();
    f.add(share(), event(9, [["h", "source"]], "protected content"));
    if (change === "destination addition")
      f.setCurrentAccess("destination", [viewer, authority, other]);
    else if (change === "source removal")
      f.setCurrentAccess("source", [authority]);
    else f.setCurrentAccess("destination", [viewer, authority], true);
    expect(
      (
        await listSharedChats(f.reader, "destination", {
          audience: "destination",
        })
      ).entries,
    ).toEqual([]);
    await expect(
      readSharedChat(f.reader, "destination", "source"),
    ).rejects.toThrow(/access/);
  },
);

it("withholds agent output without current server audience support", async () => {
  const f = fixture();
  f.add(share(), event(9, [["h", "source"]], "protected content"));
  const { authorizeAudience: _unsupported, ...reader } = f.reader;
  await expect(
    listSharedChats(reader, "destination", { audience: "destination" }),
  ).rejects.toThrow(/updated server support/);
  await expect(readSharedChat(reader, "destination", "source")).rejects.toThrow(
    /updated server support/,
  );
});

it("requires the Solo label for a private stream source", async () => {
  const f = fixture();
  const query = f.query.getMockImplementation();
  if (!query) throw new Error("Missing fixture query");
  f.query.mockImplementation(async (filters) =>
    (await query(filters)).map((record) =>
      record.kind === 39000 &&
      record.tags.some(([k, v]) => k === "d" && v === "source")
        ? event(
            39000,
            record.tags.filter(([k, v]) => k !== "t" || v !== SOLO_LABEL),
            record.content,
          )
        : record,
    ),
  );
  f.add(share(), event(9, [["h", "source"]], "ordinary private channel"));
  expect((await listSharedChats(f.reader, "destination")).entries).toEqual([]);
  await expect(
    readSharedChat(f.reader, "destination", "source"),
  ).rejects.toThrow(/access/);
});

it("uses remote page evidence rather than the projected local outbox adapter", async () => {
  const f = fixture();
  f.add(
    ...Array.from({ length: 50 }, (_, i) =>
      event(9, [["h", "destination"]], `ordinary ${i}`, 100 + i),
    ),
    share(10),
  );
  const owner = createRelaySession({
    viewer,
    relayAuthor: authority,
    query: f.query,
    media: () => undefined,
  });
  const projected = vi.fn(async () => {
    throw new Error("Local failed outbox projection must not be used");
  });
  try {
    const adapter = {
      viewer,
      relayAuthor: authority,
      readRemote: owner.session.readRemote,
      read: projected,
    } as unknown as Parameters<typeof listSharedChats>[0];
    const result = await listSharedChats(adapter, "destination");
    expect(result.entries.map(({ id }) => id)).toEqual(["source"]);
    expect(result.complete).toBe(true);
    expect(projected).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});

it.each([false, true])(
  "skips ineligible historical sources before the strict agent boundary (paged: %s)",
  async (paged) => {
    const f = fixture();
    const destination = "22222222-2222-4222-8222-222222222222";
    const source = "33333333-3333-4333-8333-333333333333";
    const ordinary = "44444444-4444-4444-8444-444444444444";
    const revoked = "55555555-5555-4555-8555-555555555555";
    const community = "11111111-1111-4111-8111-111111111111";
    f.setAccess(destination);
    f.setAccess(source);
    f.setAccess(ordinary, undefined, true);
    f.setAccess(revoked, [other]);
    f.add(
      event(
        9,
        [["h", destination]],
        ["general", ordinary, revoked]
          .map((id) => soloChatLinkMessage(id))
          .join("\n\n"),
        30,
      ),
      event(9, [["h", destination]], soloChatLinkMessage(source), 20),
    );
    const audienceAuthority = vi.fn(
      async (dest: string, sources: readonly string[]) => {
        audienceAuthorityFilter(dest, sources);
        return {
          audience_authority: 1,
          complete: true,
          community_id: community,
          pubkey: viewer,
          destination: dest,
          sources: sources.map((id) => ({ id, allowed: true })),
        };
      },
    );
    const client = appClient(
      {
        pubkey: viewer,
        query: f.query,
        audienceAuthority,
      } as unknown as AgentHandle,
      {
        read: vi.fn(),
        memories: async () => ({ entries: [], partial: false }),
        relayAuthor: authority,
        audienceAuthorityCommunity: community,
      },
    );
    let result = await listSharedChats(client, destination, {
      audience: destination,
      limit: paged ? 1 : 20,
    });
    if (paged) {
      expect(result.entries).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.complete).toBe(false);
      expect(result.cursor).toBeDefined();
      expect(audienceAuthority).not.toHaveBeenCalled();
      result = await listSharedChats(client, destination, {
        audience: destination,
        cursor: result.cursor,
      });
    }
    expect(result.entries.map(({ id }) => id)).toEqual([source]);
    expect(result.errors).toEqual([]);
    expect(result.complete).toBe(true);
    expect(audienceAuthority).toHaveBeenCalledExactlyOnceWith(destination, [
      source,
    ]);
  },
);
