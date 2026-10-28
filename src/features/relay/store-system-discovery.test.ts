import { expect, it, vi } from "vitest";
import { eventDto, tag, type RelayEvent } from "./events";
import type { HeadPersistence } from "./persistence";
import { createRelaySession } from "./session";
import {
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair();
const system = "33333333-3333-4333-8333-333333333333",
  other = "22222222-2222-4222-8222-222222222222";
const systemRoster = (created_at = 1_700_000_000, id = system): RelayEvent =>
  signed(relay, {
    kind: 39002,
    content: "",
    created_at,
    tags: [
      ["d", id],
      ["t", "system"],
      ["p", viewer.pubkey],
    ],
  });
const systemTags = [["private"], ["hidden"], ["t", "system"], ["t", "for-you"]];
const systemMetadata = metadata(
  relay,
  system,
  "For You records",
  undefined,
  systemTags,
);

/** One NIP-CL full pass: system rosters, the `#p` roster read, then names. */
async function pass(
  owner: ReturnType<typeof createRelaySession>,
  wire: ReturnType<typeof scriptedTransport>,
  systemRosters: readonly RelayEvent[],
) {
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  const systemRead = wire.next();
  expect(systemRead.filters).toEqual([
    expect.objectContaining({
      kinds: [39002],
      "#p": [viewer.pubkey],
      "#t": ["system"],
    }),
  ]);
  systemRead.respond([...systemRosters]);
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  const rosterRead = wire.next();
  expect(rosterRead.filters[0]).not.toHaveProperty("#t");
  rosterRead.respond([roster(relay, other, [viewer.pubkey])]);
  // Names for any channel this pass found without them, until it verifies.
  await vi.waitFor(() => {
    for (const request of wire.pending.splice(0))
      request.respond(
        (request.filters[0]?.["#d"] ?? []).map((id) =>
          id === system
            ? systemMetadata
            : metadata(relay, id, "Existing", undefined, [["public"]]),
        ),
      );
    expect(owner.session.live.snapshot().roster.state).toBe("verified");
  });
}

it("loses a system channel when a later full pass no longer lists the viewer", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    channelIdentity: true,
  });
  const channels = owner.session.channels;
  try {
    channels.ensureList();
    await pass(owner, wire, [systemRoster()]);
    expect(channels.get?.(system)).toMatchObject({ channelType: "system" });
    expect(channels.list().channels.map((channel) => channel.id)).toEqual([
      other,
    ]);
    // The owner removed the viewer: the system read no longer returns it.
    channels.refreshList?.();
    await pass(owner, wire, []);
    await vi.waitFor(() => expect(channels.get?.(system)).toBeUndefined());
    expect(channels.list().channels.map((channel) => channel.id)).toEqual([
      other,
    ]);
  } finally {
    owner.dispose();
  }
});

it("clears a restored system channel the first full pass does not return", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const persistence: HeadPersistence = {
    read: async () => [],
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [systemRoster(), systemMetadata],
      },
    }),
    writeStartup: async () => {},
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {},
    close: () => {},
  };
  const owner = createRelaySession(
    { ...wire.transport, channelIdentity: true },
    { persistence, prepared: true },
  );
  const channels = owner.session.channels;
  try {
    await owner.restore();
    expect(channels.get?.(system)).toMatchObject({
      channelType: "system",
      cached: true,
    });
    channels.ensureList();
    await pass(owner, wire, []);
    await vi.waitFor(() => expect(channels.get?.(system)).toBeUndefined());
  } finally {
    owner.dispose();
  }
});

it("verifies restored discovery through the connection's proof memo", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const verifySaved = vi.fn(eventDto);
  const saved = [systemRoster(), systemMetadata];
  const persistence: HeadPersistence = {
    read: async () => [],
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: saved,
      },
    }),
    writeStartup: async () => {},
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {},
    close: () => {},
  };
  const owner = createRelaySession(
    { ...wire.transport, channelIdentity: true, verifySaved },
    { persistence, prepared: true },
  );
  try {
    await owner.restore();
    expect(owner.session.channels.get?.(system)).toMatchObject({
      cached: true,
    });
    // Each saved event is checked once and admitted as a newly owned wire-field copy.
    const checked = verifySaved.mock.calls.map(
      ([value]) => value as RelayEvent,
    );
    expect(checked.map((value) => value.id)).toEqual(
      saved.map((event) => event.id),
    );
    const admitted = verifySaved.mock.results.map(({ value }) => value);
    expect(admitted.some((value, i) => value === saved[i])).toBe(false);
  } finally {
    owner.dispose();
  }
});

it("keeps a restored system channel the first full pass returns", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const persistence: HeadPersistence = {
    read: async () => [],
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [systemRoster(), systemMetadata],
      },
    }),
    writeStartup: async () => {},
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {},
    close: () => {},
  };
  const owner = createRelaySession(
    { ...wire.transport, channelIdentity: true },
    { persistence, prepared: true },
  );
  const channels = owner.session.channels;
  try {
    await owner.restore();
    channels.ensureList();
    await pass(owner, wire, [systemRoster()]);
    expect(channels.get?.(system)).toMatchObject({ channelType: "system" });
    expect(channels.get?.(system)?.cached).toBeUndefined();
    expect(channels.list().channels.map((channel) => channel.id)).toEqual([
      other,
    ]);
  } finally {
    owner.dispose();
  }
});

it("confirms a scan-start system membership that moved ahead of a paged system cursor", async () => {
  // More than one page of system rosters, all newer than the retained one.
  const page = Array.from({ length: 500 }, (_, i) =>
    systemRoster(
      1_700_000_100 + i,
      `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
    ),
  ).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  // Sign every name up front: answering the name reads stays cheap.
  const names = new Map<string, RelayEvent>([
    [system, systemMetadata],
    [other, metadata(relay, other, "Existing", undefined, [["public"]])],
  ]);
  for (const event of page) {
    const id = tag(event, "d");
    if (id) names.set(id, metadata(relay, id, "System", undefined, systemTags));
  }
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const persistence: HeadPersistence = {
    read: async () => [],
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: [systemRoster(), systemMetadata],
      },
    }),
    writeStartup: async () => {},
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
    clear: async () => {},
    close: () => {},
  };
  const owner = createRelaySession(
    { ...wire.transport, channelIdentity: true },
    { persistence, prepared: true },
  );
  const channels = owner.session.channels;
  try {
    await owner.restore();
    channels.ensureList();
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    const first = wire.next();
    expect(first.filters[0]).toMatchObject({ "#t": ["system"] });
    first.respond(page);
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    const second = wire.next();
    const last = page.at(-1);
    expect(second.filters[0]).toMatchObject({
      "#t": ["system"],
      until: last?.created_at,
      before_id: last?.id,
    });
    // Someone joined between the reads: the retained channel's roster is now
    // newer than the cursor, so neither system page returns it.
    second.respond([]);
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    const ordinary = wire.next();
    expect(ordinary.filters[0]).not.toHaveProperty("#t");
    ordinary.respond([roster(relay, other, [viewer.pubkey])]);
    // The omission check reads the missing membership fresh by `#d`.
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    const confirm = wire.next();
    expect(confirm.filters).toEqual([
      {
        kinds: [39002],
        authors: [relay.pubkey],
        "#d": [system],
        "#p": [viewer.pubkey],
        limit: 2,
      },
    ]);
    confirm.respond([systemRoster(1_700_001_000)]);
    await vi.waitFor(() => {
      for (const request of wire.pending.splice(0))
        request.respond(
          (request.filters[0]?.["#d"] ?? []).flatMap((id) => {
            const event = names.get(id);
            return event ? [event] : [];
          }),
        );
      expect(owner.session.live.snapshot().roster.state).toBe("verified");
    });
    expect(channels.get?.(system)).toMatchObject({ channelType: "system" });
    expect(channels.get?.(system)?.cached).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it("keeps a confirmed system channel's saved history when a full pass completes", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const retained: string[][] = [];
  const removed: string[] = [];
  const persistence: HeadPersistence = {
    read: async () => [],
    writeStartup: async () => {},
    write: async () => {},
    remove: async (id) => {
      removed.push(id);
    },
    retain: async (ids) => {
      retained.push([...ids].sort());
    },
    clear: async () => {},
    close: () => {},
  };
  const owner = createRelaySession(
    { ...wire.transport, channelIdentity: true },
    { persistence, prepared: true },
  );
  const channels = owner.session.channels;
  try {
    channels.ensureList();
    await pass(owner, wire, [systemRoster()]);
    expect(channels.get?.(system)).toMatchObject({ channelType: "system" });
    // The list hides the system channel, but the device keeps its history.
    expect(retained.at(-1)).toEqual([other, system].sort());
    expect(removed).not.toContain(system);
  } finally {
    owner.dispose();
  }
});
