import { Context } from "@deepseek-ai/cordis";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createCommunities } from "./service";
import {
  importLegacyCommunities,
  type LegacyCommunity,
} from "./legacy-communities";
import { acknowledge } from "./known-communities";
import { flush } from "../relay/testing";

const viewer = "a".repeat(64);
const other = "b".repeat(64);
const record = `buzz-client.v1:${viewer}`;
const marker = `buzz-legacy-communities.v1:${viewer}`;
const roots: Context[] = [];
// Old Buzz's list as its reader returns it, in saved order: the viewer's
// communities, one saved before old Buzz recorded an identity, and one saved
// for another identity.
const legacy: LegacyCommunity[] = [
  { relayUrl: "wss://hive.example.com", pubkey: viewer },
  { relayUrl: "wss://hive.example.com/", pubkey: viewer },
  { relayUrl: "ws://localhost:3000", pubkey: viewer },
  { relayUrl: "wss://removed.example.com", pubkey: viewer },
  { relayUrl: "wss://kept.example.com", pubkey: viewer },
  { relayUrl: "not a url", pubkey: viewer },
  { relayUrl: "wss://unreachable.example.com", pubkey: viewer },
  { relayUrl: "wss://unattributed.example.com" },
  { relayUrl: "wss://theirs.example.com", pubkey: other },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(saved?: unknown, failSave = false) {
  const storage = new Map<string, string>();
  if (saved !== undefined) storage.set(record, JSON.stringify(saved));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failSave) throw new Error("Full disk");
      storage.set(key, value);
    },
    removeItem: (key: string) => storage.delete(key),
  });
  const connect = vi.fn((id: string) =>
    Promise.reject(new Error(`${id} is unreachable`)),
  );
  const start = () => {
    const ctx = new Context();
    roots.push(ctx);
    return createCommunities(
      ctx,
      false,
      undefined,
      "",
      undefined,
      Promise.resolve(viewer),
      connect,
    );
  };
  return { storage, connect, start };
}
const saved = (storage: Map<string, string>) =>
  JSON.parse(storage.get(record) ?? "null");
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("adds old Buzz's relays once beside existing settings, keeping queued removals", async () => {
  const { storage, connect, start } = setup({
    profile: { name: "Ada", picture: "", about: "" },
    memberships: [{ id: "https://kept.example.com", name: "Mine" }],
    selected: "https://kept.example.com",
    sync: {
      known: [],
      outbox: [{ url: "wss://removed.example.com", removed: true }],
    },
  });
  const client = start();
  const read = vi.fn(async () => legacy);
  importLegacyCommunities(client, read);
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(client.snapshot()).toMatchObject({
    profile: { name: "Ada" },
    selected: "https://kept.example.com",
    memberships: [
      { id: "https://kept.example.com", name: "Mine" },
      { id: "https://hive.example.com", name: "hive.example.com" },
      {
        id: "https://unreachable.example.com",
        name: "unreachable.example.com",
      },
    ],
  });
  expect(saved(storage).sync.outbox).toEqual([
    { url: "wss://removed.example.com", removed: true },
    { url: "wss://hive.example.com", removed: false },
    { url: "wss://unreachable.example.com", removed: false },
  ]);
  expect(storage.get(marker)).toBe("1");
  // Only the selected community connects; the import opens no session.
  expect(connect.mock.calls.map(([id]) => id)).toEqual([
    "https://kept.example.com",
  ]);

  // An unreachable relay fails only its own session.
  const unreachable = client.open("https://unreachable.example.com");
  await flush();
  expect(unreachable?.snapshot().status).not.toBe("ready");
  expect(client.snapshot().memberships).toHaveLength(3);

  // Restart after leaving a migrated community: the marker keeps it gone.
  await client.leave("https://hive.example.com");
  const restarted = start();
  importLegacyCommunities(restarted, read);
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(restarted.snapshot().memberships.map((m) => m.id)).toEqual([
    "https://kept.example.com",
    "https://unreachable.example.com",
  ]);
});

it("marks a viewer with no old Buzz state without changing its record", async () => {
  const { storage, start } = setup();
  const client = start();
  importLegacyCommunities(client, async () => []);
  await flush();
  expect(client.snapshot()).toMatchObject({ status: "ready", memberships: [] });
  expect(storage.has(record)).toBe(false);
  expect(storage.get(marker)).toBe("1");
});

it("retries on the next launch when old Buzz's list could not be read or saved", async () => {
  const unreadable = setup();
  importLegacyCommunities(unreadable.start(), async () => {
    throw new Error("Could not read old Buzz's communities");
  });
  await flush();
  expect(unreadable.storage.has(marker)).toBe(false);

  const full = setup(undefined, true);
  const client = full.start();
  importLegacyCommunities(client, async () => legacy);
  await flush();
  expect(client.snapshot().memberships).toEqual([]);
  expect(full.storage.has(marker)).toBe(false);
});

it("imports nothing for an identity old Buzz did not save them for", async () => {
  const { storage, start } = setup();
  const client = start();
  importLegacyCommunities(client, async () => [
    { relayUrl: "wss://theirs.example.com", pubkey: other },
    { relayUrl: "wss://unattributed.example.com" },
  ]);
  await flush();
  expect(client.snapshot().memberships).toEqual([]);
  expect(storage.has(record)).toBe(false);
  expect(storage.get(marker)).toBe("1");
});

it("keeps a community left and acknowledged while the read was pending gone", async () => {
  const { storage, start } = setup({
    profile: { name: "", picture: "", about: "" },
    memberships: [{ id: "https://hive.example.com", name: "Hive" }],
    selected: null,
    sync: { known: ["wss://hive.example.com"], outbox: [] },
  });
  const client = start();
  const read = deferred<LegacyCommunity[]>();
  importLegacyCommunities(client, () => read.promise);
  await flush();
  await client.leave("https://hive.example.com");
  const [op] = client.snapshot().sync.outbox;
  assert.exists(op);
  await client.applySync(acknowledge(client.snapshot().sync, op));
  expect(client.snapshot().sync.outbox).toEqual([]);
  read.resolve(legacy);
  await flush();
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "https://removed.example.com",
    "https://kept.example.com",
    "https://unreachable.example.com",
  ]);
  expect(saved(storage).sync.outbox).not.toContainEqual({
    url: "wss://hive.example.com",
    removed: false,
  });
});

it("keeps a queued removal acknowledged while the read was pending gone", async () => {
  const { storage, start } = setup({
    profile: { name: "", picture: "", about: "" },
    memberships: [],
    selected: null,
    sync: {
      known: ["wss://removed.example.com"],
      outbox: [{ url: "wss://removed.example.com", removed: true }],
    },
  });
  const client = start();
  const read = deferred<LegacyCommunity[]>();
  importLegacyCommunities(client, () => read.promise);
  await flush();
  const [op] = client.snapshot().sync.outbox;
  assert.exists(op);
  await client.applySync(acknowledge(client.snapshot().sync, op));
  expect(client.snapshot().sync.outbox).toEqual([]);
  read.resolve([{ relayUrl: "wss://removed.example.com", pubkey: viewer }]);
  await flush();
  expect(client.snapshot().memberships).toEqual([]);
  expect(saved(storage).sync.outbox).toEqual([]);
  expect(storage.get(marker)).toBe("1");
});

it("abandons a pending read once disposed, leaving a replacement's settings", async () => {
  const { storage, start } = setup();
  const read = deferred<LegacyCommunity[]>();
  const dispose = importLegacyCommunities(start(), () => read.promise);
  await flush();
  dispose();
  const replacement = start();
  await flush();
  replacement.saveProfile({ name: "Ada", picture: "", about: "" });
  read.resolve(legacy);
  await flush();
  expect(saved(storage)).toMatchObject({
    profile: { name: "Ada" },
    memberships: [],
  });
  expect(storage.has(marker)).toBe(false);
});
