import { describe, expect, it, vi } from "vitest";
import { PublishRejected } from "../relay/outbox";
import { begin, LifecycleJournal, resumeAll, settle } from "./config-lifecycle";
import { memoryStorage } from "./test-fakes";

const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const subject = "a".repeat(64);

function setup() {
  const storage = memoryStorage();
  const relay = { archived: false };
  const channels = {
    archive: vi.fn(async () => {
      relay.archived = true;
    }),
    unarchive: vi.fn(async () => {
      relay.archived = false;
    }),
    archived: vi.fn(async () => relay.archived),
  };
  const deps = {
    channels,
    journal: new LifecycleJournal(storage),
    community: "c",
  };
  return { deps, channels, relay, storage };
}

describe("archive and recover", () => {
  it("archives once strong metadata confirms it", async () => {
    const f = setup();
    expect(await begin(f.deps, subject, channel, "archive")).toBe("archived");
  });

  it("persists the intent before the request, so starts block from then", async () => {
    const f = setup();
    f.channels.archive.mockImplementation(async () => {
      expect(f.deps.journal.get("c", subject)).toBe("archiving");
      expect(new LifecycleJournal(f.storage).get("c", subject)).toBe(
        "archiving",
      );
    });
    await begin(f.deps, subject, channel, "archive");
  });

  it("stays archiving after a lost reply and active metadata, then retries after restart", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(new Error("timeout"));
    expect(await begin(f.deps, subject, channel, "archive")).toBe("archiving");
    const restarted = { ...f.deps, journal: new LifecycleJournal(f.storage) };
    await resumeAll(restarted);
    expect(restarted.journal.get("c", subject)).toBe("archived");
  });

  it("stays archiving when the metadata read fails, even after a refusal", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(
      new PublishRejected("refused", "restricted: not allowed"),
    );
    f.channels.archived.mockRejectedValueOnce(new Error("offline"));
    expect(await begin(f.deps, subject, channel, "archive")).toBe("archiving");
  });

  it("rolls back only on a definite refusal plus active metadata", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(
      new PublishRejected("refused", "restricted: not allowed"),
    );
    expect(await begin(f.deps, subject, channel, "archive")).toBe("active");
  });

  it("never rolls back on a rate limit", async () => {
    const f = setup();
    f.channels.archive.mockRejectedValueOnce(
      new PublishRejected("refused", "rate-limited: slow down"),
    );
    expect(await begin(f.deps, subject, channel, "archive")).toBe("archiving");
  });

  it("recovers to active on active metadata, and back to archived only on a refusal plus archived metadata", async () => {
    const f = setup();
    f.relay.archived = true;
    f.deps.journal.put("c", subject, { state: "archived", channel });
    expect(await begin(f.deps, subject, channel, "recover")).toBe("active");
    f.relay.archived = true;
    f.channels.unarchive.mockRejectedValueOnce(new Error("timeout"));
    expect(await begin(f.deps, subject, channel, "recover")).toBe("recovering");
    f.channels.unarchive.mockRejectedValueOnce(
      new PublishRejected("refused", "restricted: no"),
    );
    expect(await resumeAll(f.deps)).toEqual(["archived"]);
  });

  it("settles a pending archive from live discovery", () => {
    const f = setup();
    f.deps.journal.put("c", subject, { state: "archiving", channel });
    expect(settle(f.deps, subject, channel, true)).toBe("archived");
  });
});
