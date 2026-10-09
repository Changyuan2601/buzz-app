// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { copySnapshotLink, snapshotClipboardHtml } from "./snapshot-link";

const attachment = {
  name: "worker.agent.png",
  url: `https://relay.example/media/${"a".repeat(64)}.png`,
  type: "image/png",
  size: 2,
  sha256: "a".repeat(64),
};
const snapshot = { fileBytes: [1, 2], fileName: attachment.name };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("preserves the reference agent/team clipboard descriptor and escapes visible HTML", () => {
  for (const name of ["worker.agent.png", "worker.team.png"]) {
    const html = snapshotClipboardHtml(
      { ...attachment, name },
      '<Worker & "team">',
    );
    const encoded = html.match(/data-buzz-agent-snapshot="([^"]+)"/)?.[1];
    expect(JSON.parse(decodeURIComponent(encoded ?? ""))).toEqual({
      version: 1,
      displayName: '<Worker & "team">',
      filename: name,
      sha256: attachment.sha256,
      size: 2,
      type: "image/png",
      url: attachment.url,
    });
    expect(html).toContain("&lt;Worker &amp; &quot;team&quot;&gt;</a>");
  }
});

it("uploads authenticated media and copies both plain URL and reference HTML", async () => {
  const write = vi.fn(async () => {});
  const items: Record<string, Promise<Blob>>[] = [];
  vi.stubGlobal("navigator", { clipboard: { write } });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(value: Record<string, Promise<Blob>>) {
        items.push(value);
      }
    },
  );
  const upload = vi.fn(async () => attachment);
  const signal = new AbortController().signal;
  await copySnapshotLink({
    session: { snapshotUpload: { upload } },
    snapshot: Promise.resolve(snapshot),
    displayName: "Worker",
    signal,
  });
  expect(upload).toHaveBeenCalledWith(
    expect.objectContaining({
      name: attachment.name,
      type: "image/png",
      size: 2,
    }),
    expect.any(AbortSignal),
  );
  expect(write).toHaveBeenCalledOnce();
  expect((await items[0]?.["text/plain"])?.type).toBe("text/plain");
  expect((await items[0]?.["text/html"])?.type).toBe("text/html");
});

it("rejects clipboard data for an upload completed after cancellation", async () => {
  const controller = new AbortController();
  const write = vi.fn(async () => {});
  vi.stubGlobal("ClipboardItem", class {});
  vi.stubGlobal("navigator", { clipboard: { write } });
  const upload = vi.fn(async () => {
    controller.abort();
    return attachment;
  });
  await expect(
    copySnapshotLink({
      session: { snapshotUpload: { upload } },
      snapshot: Promise.resolve(snapshot),
      displayName: "Worker",
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(write).toHaveBeenCalledOnce();
});

it("does not silently report copy success when clipboard write fails", async () => {
  vi.stubGlobal("navigator", {
    clipboard: {
      write: vi.fn(async () => {
        throw new Error("Clipboard denied");
      }),
    },
  });
  vi.stubGlobal("ClipboardItem", class {});
  await expect(
    copySnapshotLink({
      session: { snapshotUpload: { upload: async () => attachment } },
      snapshot: Promise.resolve(snapshot),
      displayName: "Worker",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Clipboard denied");
});

it("starts clipboard write before encoding or upload finishes", async () => {
  let release!: (value: typeof snapshot) => void;
  const encoded = new Promise<typeof snapshot>((resolve) => {
    release = resolve;
  });
  const items: Record<string, Promise<Blob>>[] = [];
  const write = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { write } });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(value: Record<string, Promise<Blob>>) {
        items.push(value);
      }
    },
  );
  const upload = vi.fn(async () => attachment);
  const run = copySnapshotLink({
    session: { snapshotUpload: { upload } },
    snapshot: encoded,
    displayName: "Worker",
    signal: new AbortController().signal,
  });
  expect(write).toHaveBeenCalledOnce();
  expect(upload).not.toHaveBeenCalled();
  release(snapshot);
  await run;
  expect((await items[0]?.["text/plain"])?.type).toBe("text/plain");
});

it("applies the snapshot cap before standalone upload", async () => {
  const upload = vi.fn(async () => attachment);
  vi.stubGlobal("navigator", { clipboard: { write: vi.fn(async () => {}) } });
  vi.stubGlobal("ClipboardItem", class {});
  await expect(
    copySnapshotLink({
      session: { snapshotUpload: { upload } },
      snapshot: Promise.resolve({
        fileName: "worker.agent.png",
        fileBytes: new Array(10 * 1024 * 1024 + 1).fill(0),
      }),
      displayName: "Worker",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "size" });
  expect(upload).not.toHaveBeenCalled();
});
