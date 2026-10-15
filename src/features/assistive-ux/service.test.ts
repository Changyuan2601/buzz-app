// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  assistiveAddresses,
  decodeAssistive,
  signAssistive,
} from "../../../browser-host/assistive-ux.mjs";
import { createAssistiveProgress } from "./progress";
import type { RelayEvent, ReadFilter } from "../relay/events";
import type { AssistiveHost } from "./protocol";

const id = "threads.new-thread-placement";
const facts = {
  surface: "new-channel-thread" as const,
  channelType: "stream" as const,
  isMe: false,
};
const secret = generateSecretKey();
const relay = new Map<string, RelayEvent>();
const owners: ReturnType<typeof createAssistiveProgress>[] = [];
function device(community = "https://community.test", key = secret) {
  const lifetime = new AbortController();
  let offline = false;
  const host: AssistiveHost = {
    addresses: async () => assistiveAddresses(key, community),
    decode: async (events) => decodeAssistive(events, key, community),
    sign: async (fact) => signAssistive(fact, key, community),
    publish: async (event) => {
      if (offline) throw new Error("Offline");
      relay.set(event.tags[0]?.[1] ?? "", event);
    },
  };
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    if (offline) throw new Error("Offline");
    return [...relay.values()].filter((event) =>
      filters.some(
        (filter) =>
          (!filter.ids || filter.ids.includes(event.id)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (!filter["#d"] || filter["#d"].includes(event.tags[0]?.[1] ?? "")),
      ),
    );
  });
  const owner = createAssistiveProgress({
    host,
    reader: { read },
    viewer: getPublicKey(key),
    community,
    signal: lifetime.signal,
  });
  owners.push(owner);
  return {
    ...owner,
    read,
    lifetime,
    offline(value: boolean) {
      offline = value;
    },
  };
}
beforeEach(() => {
  localStorage.clear();
  relay.clear();
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});

it("loads unknown before remote evidence and remembers completion on another device", async () => {
  const a = device();
  expect(a.capability.eligibility(id, facts)).toBe("unknown");
  await a.capability.refresh();
  expect(a.capability.eligibility(id, facts)).toBe("eligible");
  await expect(a.capability.record(id, "seen")).resolves.toBe("saved");
  await a.capability.refresh();
  expect(a.capability.eligibility(id, facts)).toBe("eligible");
  await a.capability.record(id, "completed");
  await a.capability.refresh();
  expect(a.capability.snapshot().pending).toBe(0);
  a.dispose();
  localStorage.clear();
  const b = device();
  await b.capability.refresh();
  expect(b.capability.snapshot().facts).toContainEqual({
    id,
    outcome: "completed",
  });
  expect(b.capability.eligibility(id, facts)).toBe("ineligible");
});

it("retains offline intent across restart and publishes on reconnect without a new action", async () => {
  const a = device();
  a.offline(true);
  await expect(a.capability.record(id, "dismissed")).resolves.toBe("saved");
  await a.capability.refresh();
  expect(a.capability.snapshot()).toMatchObject({
    status: "error",
    pending: 1,
  });
  expect(a.capability.eligibility(id, facts)).toBe("ineligible");
  a.dispose();
  const b = device();
  await b.capability.refresh();
  expect(b.capability.snapshot()).toMatchObject({
    status: "ready",
    pending: 0,
  });
  b.dispose();
  localStorage.clear();
  const c = device();
  await c.capability.refresh();
  expect(c.capability.eligibility(id, facts)).toBe("ineligible");
});

it("keeps concurrent outcomes independent and updates a live subscriber", async () => {
  const a = device();
  const b = device();
  await Promise.all([a.capability.refresh(), b.capability.refresh()]);
  const changed = vi.fn();
  b.capability.subscribe(changed);
  await Promise.all([
    a.capability.record(id, "completed"),
    b.capability.record(id, "seen"),
  ]);
  await Promise.all([a.capability.refresh(), b.capability.refresh()]);
  expect(relay.size).toBe(2);
  await b.capability.refresh();
  expect(b.capability.snapshot().facts).toContainEqual({
    id,
    outcome: "completed",
  });
  expect(b.capability.eligibility(id, facts)).toBe("ineligible");
  expect(changed).toHaveBeenCalled();
});

it("isolates identity and community and keeps failures unknown instead of first-run", async () => {
  const a = device();
  await a.capability.record(id, "dismissed");
  await a.capability.refresh();
  for (const other of [
    device("https://other.test"),
    device("https://community.test", generateSecretKey()),
  ]) {
    await other.capability.refresh();
    expect(other.capability.eligibility(id, facts)).toBe("eligible");
    other.offline(true);
    await other.capability.refresh();
    expect(other.capability.eligibility(id, facts)).toBe("unknown");
  }
});

it("reports unsaved intent, honors it in memory, and fences retired handles", async () => {
  const a = device();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Full");
  });
  await expect(a.capability.record(id, "dismissed")).resolves.toBe("unsaved");
  expect(a.capability.eligibility(id, facts)).toBe("ineligible");
  expect(relay.size).toBe(0);
  a.dispose();
  await expect(a.capability.record(id, "completed")).resolves.toBe(
    "unavailable",
  );
});

it.each([
  { isMe: true },
  { isMe: undefined },
  { channelType: "dm" as const },
  { surface: "other" as const },
])(
  "retains product eligibility separately from progress: %o",
  async (patch) => {
    const a = device();
    await a.capability.refresh();
    expect(a.capability.eligibility(id, { ...facts, ...patch })).toBe(
      "ineligible",
    );
  },
);

it("retries after a synchronous storage failure and merges another window's pending intent", async () => {
  const a = device();
  const blocked = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw new Error("Blocked");
    });
  await a.capability.refresh();
  expect(a.capability.snapshot().status).toBe("error");
  blocked.mockRestore();
  await a.capability.refresh();
  expect(a.capability.eligibility(id, facts)).toBe("eligible");
  const writer = device();
  writer.offline(true);
  await writer.capability.record(id, "dismissed");
  await writer.capability.refresh();
  const key = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  ).find((key) => key?.endsWith(":dismissed"));
  if (!key) throw new Error("Missing durable fact");
  window.dispatchEvent(
    new StorageEvent("storage", { key, storageArea: localStorage }),
  );
  expect(a.capability.eligibility(id, facts)).toBe("ineligible");
  await a.capability.refresh();
  expect(a.capability.snapshot().pending).toBe(0);
});

it("a failed save never becomes a false saved result on repeated actions", async () => {
  const a = device();
  const blocked = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Full");
    });
  await expect(a.capability.record(id, "completed")).resolves.toBe("unsaved");
  await expect(a.capability.record(id, "completed")).resolves.toBe("unsaved");
  expect(a.capability.eligibility(id, facts)).toBe("ineligible");
  blocked.mockRestore();
  await expect(a.capability.record(id, "completed")).resolves.toBe("saved");
  await a.capability.refresh();
  expect(a.capability.snapshot().pending).toBe(0);
});

it("fences a read that ignores cancellation and settles new facts recorded during catch-up", async () => {
  const a = device();
  let release: (events: RelayEvent[]) => void = () => {};
  let started: () => void = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  a.read.mockImplementationOnce(
    () =>
      new Promise<RelayEvent[]>((resolve) => {
        release = resolve;
        started();
      }),
  );
  const read = a.capability.refresh();
  await began;
  await expect(a.capability.record(id, "completed")).resolves.toBe("saved");
  a.clear();
  release([]);
  await read;
  await a.capability.refresh();
  expect(a.capability.snapshot().pending).toBe(0);
  expect(a.capability.eligibility(id, facts)).toBe("ineligible");
  expect(relay.size).toBe(1);
});

it("retains unknown evidence on disconnect and restores pending facts after reconnect", async () => {
  const a = device();
  await a.capability.refresh();
  a.disconnected();
  a.offline(true);
  expect(a.capability.eligibility(id, facts)).toBe("unknown");
  await a.capability.record(id, "seen");
  await a.capability.refresh();
  expect(a.capability.snapshot().pending).toBe(1);
  a.offline(false);
  a.connected();
  await a.capability.refresh();
  expect(a.capability.snapshot()).toMatchObject({
    status: "ready",
    pending: 0,
  });
});

it("automatically revalidates demanded progress after a settled cache clear", async () => {
  const a = device();
  await a.capability.refresh();
  const reads = a.read.mock.calls.length;
  const ready = new Promise<void>((resolve) => {
    const stop = a.capability.subscribe(() => {
      if (a.capability.snapshot().status === "ready") {
        stop();
        resolve();
      }
    });
  });
  a.clear();
  await ready;
  expect(a.read.mock.calls.length).toBeGreaterThan(reads);
  expect(a.capability.eligibility(id, facts)).toBe("eligible");
});
