import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, metadata, roster, signed } from "./testing";
import type { LiveCallbacks } from "./live";
import type { ArchiveHost } from "../archive/types";
import type { HeadPersistence } from "./persistence";

it("keeps history omitted by cached discovery, reveals it only after signed channel resolution, and deletes it only on explicit history/cache clear", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const event = signed(agent, {
    kind: 24200,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", viewer.pubkey],
      ["agent", agent.pubkey],
      ["frame", "telemetry"],
    ],
    content: "encrypted-fixture",
  });
  let saved = [
    {
      id: event.id,
      agent: event.pubkey,
      createdAt: event.created_at,
      receivedAt: Date.now(),
      plaintext: JSON.stringify({
        kind: "turn_liveness",
        turnId: "saved",
        channelId: "omitted",
        timestamp: new Date().toISOString(),
      }),
    },
  ];
  const archive: ArchiveHost = {
    location: "device",
    settings: vi.fn(),
    configure: vi.fn(),
    read: vi.fn(async () => ({
      records: saved,
      agents: [agent.pubkey],
      revision: 0,
      before: null,
      skipped: 0,
    })),
    clear: vi.fn(async () => {
      saved = [];
    }),
  };
  const discovery = [
    roster(relay, "alpha", [viewer.pubkey]),
    metadata(relay, "alpha", "Alpha"),
  ];
  const persistence: HeadPersistence = {
    readStartup: async () => ({
      discovery: {
        savedAt: Date.now(),
        relayAuthor: relay.pubkey,
        events: discovery,
      },
    }),
    writeStartup: async () => {},
    read: async () => [],
    write: async () => {},
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const update = vi.fn();
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://community.example",
      media: () => undefined,
      query: async (filters) =>
        filters.some((filter) => filter.kinds?.includes(39002))
          ? discovery.filter((event) => event.kind === 39002)
          : filters.some((filter) => filter.kinds?.includes(39000))
            ? discovery.filter((event) => event.kind === 39000)
            : [],
      agentActivity: true,
      activityArchive: archive,
      subscribe(callbacks) {
        live = callbacks;
        return { update, retry() {}, dispose() {}, observe() {} };
      },
    },
    { persistence, prepared: true },
  );
  try {
    await owner.restore();
    owner.session.agentActivity.activate();
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().history).toBe("ready"),
    );
    expect(owner.session.agentActivity.snapshot().records).toEqual([]);
    expect(saved).toHaveLength(1);
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    expect(saved).toHaveLength(1);
    live.receive([
      roster(relay, "omitted", [viewer.pubkey]),
      metadata(relay, "omitted", "Recovered channel"),
    ]);
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().records).toHaveLength(1),
    );
    expect(owner.session.agentActivity.snapshot().turns).toEqual([]);
    live.receive([
      roster(relay, "omitted", [], Math.floor(Date.now() / 1000) + 1),
    ]);
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().history).toBe("ready"),
    );
    expect(owner.session.agentActivity.snapshot().records).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(archive.clear).not.toHaveBeenCalled();
    vi.mocked(archive.clear).mockRejectedValueOnce(
      new Error("disk unavailable"),
    );
    await vi.waitFor(() =>
      expect(owner.session.live.snapshot().roster.state).toBe("verified"),
    );
    expect(owner.session.channels.get?.("alpha")?.cached).toBeUndefined();
    update.mockClear();
    await expect(owner.clearCache()).rejects.toThrow("disk unavailable");
    // Discovery has verified alpha's signed membership, so the clear keeps it.
    expect(update).toHaveBeenCalledWith(["alpha"], ["alpha"]);
    expect(saved).toHaveLength(1);
    await owner.clearCache();
    expect(saved).toEqual([]);
    expect(archive.clear).toHaveBeenLastCalledWith(24200);
  } finally {
    owner.dispose();
  }
});

it("rehydrates after public-preview access recovers without a joined-channel list change", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  let live!: LiveCallbacks;
  const now = Math.floor(Date.now() / 1000);
  const publicMetadata = (stamp: number, open: boolean) =>
    signed(relay, {
      kind: 39000,
      created_at: stamp,
      tags: [["d", "preview"], [open ? "public" : "private"]],
      content: JSON.stringify({ name: "Preview", channel_type: "stream" }),
    });
  let current = publicMetadata(now, true);
  const archive: ArchiveHost = {
    location: "device",
    settings: vi.fn(),
    configure: vi.fn(),
    clear: vi.fn(),
    read: vi.fn(async () => ({
      records: [
        {
          id: "1".repeat(64),
          agent: agent.pubkey,
          createdAt: now,
          receivedAt: Date.now(),
          plaintext: JSON.stringify({
            kind: "turn_liveness",
            channelId: "preview",
            turnId: "saved",
            timestamp: new Date().toISOString(),
          }),
        },
      ],
      agents: [agent.pubkey],
      before: null,
      revision: 0,
      skipped: 0,
    })),
  };
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    scope: "https://example.test",
    media: () => undefined,
    query: async (filters) =>
      filters.some((f) => f.kinds?.includes(39000)) ? [current] : [],
    agentActivity: true,
    activityArchive: archive,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {}, observe() {} };
    },
  });
  try {
    owner.session.agentActivity.activate();
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().history).toBe("ready"),
    );
    expect(owner.session.agentActivity.snapshot().records).toEqual([]);
    await owner.session.channels.resolve?.(["preview"]);
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().records).toHaveLength(1),
    );
    expect(owner.session.channels.list().channels).toEqual([]);
    current = publicMetadata(now + 1, false);
    live.receive([current]);
    expect(owner.session.agentActivity.snapshot().records).toEqual([]);
    current = publicMetadata(now + 2, true);
    await owner.session.channels.resolve?.(["preview"]);
    await vi.waitFor(() =>
      expect(owner.session.agentActivity.snapshot().records).toHaveLength(1),
    );
    expect(owner.session.agentActivity.snapshot().turns).toEqual([]);
    expect(archive.clear).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});
