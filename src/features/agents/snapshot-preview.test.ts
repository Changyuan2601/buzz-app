import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  MAX_AGENT_SNAPSHOT_JSON_BYTES,
  MAX_AGENT_SNAPSHOT_PNG_BYTES,
} from "./snapshot";
import {
  MAX_TEAM_SNAPSHOT_JSON_BYTES,
  MAX_TEAM_SNAPSHOT_PNG_BYTES,
} from "./team-encoding";

import { invoke } from "@tauri-apps/api/core";
import { nativeIdentityEnabled } from "../identity/service";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../identity/service", () => ({
  nativeIdentityEnabled: vi.fn(() => false),
}));
import type { RelaySession } from "../relay/session";
import {
  canPreviewSnapshotLink,
  requestSnapshotLinkPreview,
  readSnapshotAttachment,
  requestSnapshotPreview,
  snapshotAttachmentKind,
  subscribeSnapshotPreview,
} from "./snapshot-preview";

const url = `https://relay.example/media/${"ab".repeat(32)}.png`;
const attachment = { url, kind: "image" as const, name: "Fixture.agent.png" };
function session(source = `buzz-media://localhost/${encodeURIComponent(url)}`) {
  return { media: vi.fn(() => source) } as unknown as RelaySession;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(nativeIdentityEnabled).mockReturnValue(false);
  vi.mocked(invoke).mockReset();
});

it("selects both snapshot formats without treating ordinary attachments as imports", () => {
  for (const kind of ["agent", "team"] as const)
    for (const format of ["png", "json"]) {
      expect(
        snapshotAttachmentKind({
          ...attachment,
          name: `Fixture.${kind}.${format}`,
        }),
      ).toBe(kind);
    }
  expect(
    snapshotAttachmentKind({ ...attachment, name: "ordinary.png" }),
  ).toBeUndefined();
});

it("routes only to the exact live session and retires the listener on cleanup", () => {
  const first = session();
  const second = session();
  const receive = vi.fn();
  const stop = subscribeSnapshotPreview(first, receive);
  expect(() => requestSnapshotPreview(second, attachment)).toThrow(
    "unavailable",
  );
  requestSnapshotPreview(first, attachment);
  expect(receive).toHaveBeenCalledExactlyOnceWith({
    attachment,
    kind: "agent",
  });
  stop();
  expect(() => requestSnapshotPreview(first, attachment)).toThrow(
    "unavailable",
  );
});

it("reads through authenticated host media and verifies the URL's content hash", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const bytes = new TextEncoder().encode("fixture");
  const hash = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const remote = `https://relay.example/media/${hash}.png`;
  const source = `buzz-media://localhost/${encodeURIComponent(remote)}`;
  const fetcher = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(
    await readSnapshotAttachment(
      session(source),
      { ...attachment, url: remote },
      signal,
    ),
  ).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(source, { signal });
});

it("rejects direct external URLs without fetching", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    readSnapshotAttachment(
      session(url),
      attachment,
      new AbortController().signal,
    ),
  ).rejects.toThrow("unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects changed content despite the sender's claimed filename and size", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("different content")),
  );
  await expect(
    readSnapshotAttachment(
      session(),
      { ...attachment, size: 1 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("checksum");
});

it.each([
  ["agent.png", MAX_AGENT_SNAPSHOT_PNG_BYTES],
  ["agent.json", MAX_AGENT_SNAPSHOT_JSON_BYTES],
  ["team.png", MAX_TEAM_SNAPSHOT_PNG_BYTES],
  ["team.json", MAX_TEAM_SNAPSHOT_JSON_BYTES],
])(
  "bounds streamed %s bytes independently of size metadata",
  async (format, limit) => {
    const cancelled = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(limit + 1));
      },
      cancel: cancelled,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    await expect(
      readSnapshotAttachment(
        session(),
        { ...attachment, name: `Fixture.${format}`, size: 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("size limit");
    expect(cancelled).toHaveBeenCalledOnce();
  },
);

it("offers explicit preview for authenticated copied media links without changing ordinary link opening", () => {
  const current = session();
  const receive = vi.fn();
  const stop = subscribeSnapshotPreview(current, receive);
  expect(canPreviewSnapshotLink(current, url)).toBe(true);
  requestSnapshotLinkPreview(current, url);
  expect(receive).toHaveBeenCalledExactlyOnceWith({
    attachment: { url, kind: "file" },
  });
  expect(canPreviewSnapshotLink(current, "https://example.com/document")).toBe(
    false,
  );
  expect(canPreviewSnapshotLink(session(url), url)).toBe(false);
  stop();
});

it("uses native IPC instead of renderer fetch and passes the importer cap", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const bytes = new TextEncoder().encode("native fixture");
  const hash = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const remote = `https://relay.example/media/${hash}.png`;
  const source = `buzz-media://localhost/${encodeURIComponent(remote)}`;
  vi.mocked(nativeIdentityEnabled).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue(Array.from(bytes));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(
    await readSnapshotAttachment(
      session(source),
      { ...attachment, url: remote },
      new AbortController().signal,
    ),
  ).toEqual(bytes);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("media_snapshot_read", {
    source,
    maxBytes: MAX_AGENT_SNAPSHOT_PNG_BYTES,
  });
  expect(fetcher).not.toHaveBeenCalled();
});
