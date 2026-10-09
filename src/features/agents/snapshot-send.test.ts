// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { sendSnapshot, type SnapshotSendState } from "./snapshot-send";

function fixture() {
  const attachment = {
    name: "worker.agent.png",
    url: "https://relay.example/media/file",
    type: "image/png",
    size: 3,
    sha256: "a".repeat(64),
  };
  const open = vi.fn(async () => "conversation");
  const upload = vi.fn(async () => attachment);
  const send = vi.fn(() => "operation");
  const delivered = vi.fn(async () => {});
  const session = {
    directMessages: {
      available: true,
      open,
      delivered,
      delivery: () => "unknown",
    },
    attachments: { upload },
    messages: { send },
  } as unknown as Pick<
    RelaySession,
    "directMessages" | "attachments" | "messages"
  >;
  const encode = vi.fn(async () => ({
    fileBytes: [1, 2, 3],
    fileName: "worker.agent.png",
  }));
  const states: SnapshotSendState[] = [];
  const update = (state: SnapshotSendState) => states.push(state);
  return { session, open, upload, send, delivered, encode, states, update };
}

describe("snapshot DM delivery", () => {
  it("uses DM confirmation, attachment upload and durable delivery before reporting done", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const receipt = await sendSnapshot({
      ...f,
      recipients: ["recipient"],
      signal,
    });
    expect(f.open).toHaveBeenCalledWith(["recipient"], signal);
    expect(f.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "worker.agent.png",
        type: "image/png",
        size: 3,
      }),
      "conversation",
      signal,
    );
    expect(f.send).toHaveBeenCalledWith(
      "conversation",
      "",
      [],
      [expect.objectContaining({ name: "worker.agent.png" })],
      undefined,
    );
    expect(f.delivered).toHaveBeenCalledWith(
      "operation",
      "conversation",
      signal,
    );
    expect(receipt).toEqual({
      channelId: "conversation",
      eventId: "operation",
    });
    expect(f.states.map((s) => s.phase)).toEqual([
      "preparing",
      "uploading",
      "sending",
      "done",
    ]);
  });

  it("retains an uncertain receipt and retries only that operation", async () => {
    const f = fixture();
    f.delivered.mockRejectedValueOnce(new Error("Receipt unknown"));
    const input = {
      ...f,
      recipients: ["recipient"],
      signal: new AbortController().signal,
    };
    await expect(sendSnapshot(input)).rejects.toThrow("Receipt unknown");
    const receipt = f.states.at(-1)?.receipt;
    expect(receipt).toEqual({
      channelId: "conversation",
      eventId: "operation",
    });
    if (!receipt) throw new Error("Missing uncertain-send receipt");
    await sendSnapshot({ ...input, receipt });
    expect(f.encode).toHaveBeenCalledTimes(1);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.delivered).toHaveBeenCalledTimes(2);
  });

  it("never uploads or submits when cancellation occurs during encoding", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.encode.mockImplementationOnce(async () => {
      controller.abort();
      return { fileBytes: [1], fileName: "worker.agent.png" };
    });
    await expect(
      sendSnapshot({
        ...f,
        recipients: ["recipient"],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.phase).toBe("error");
  });

  it("never submits when upload is denied", async () => {
    const f = fixture();
    f.upload.mockRejectedValueOnce(new Error("Permission revoked"));
    await expect(
      sendSnapshot({
        ...f,
        recipients: ["recipient"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Permission revoked");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.receipt).toBeUndefined();
  });

  it("does not report done until relay acceptance resolves", async () => {
    const f = fixture();
    let release = () => {};
    let started = () => {};
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.delivered.mockImplementationOnce(async () => {
      started();
      await barrier;
    });
    const run = sendSnapshot({
      ...f,
      recipients: ["recipient"],
      signal: new AbortController().signal,
    });
    try {
      await began;
      expect(f.states.at(-1)?.phase).toBe("sending");
    } finally {
      release();
    }
    await run;
    expect(f.states.at(-1)?.phase).toBe("done");
  });
});

it.each(["opening", "encoding", "uploading"])(
  "revalidates recipient eligibility after %s",
  async (phase) => {
    const f = fixture();
    let eligible = true;
    const validateRecipients = vi.fn(() => {
      if (!eligible) throw new Error("Control lost");
    });
    if (phase === "opening")
      f.open.mockImplementationOnce(async () => {
        eligible = false;
        return "conversation";
      });
    if (phase === "encoding")
      f.encode.mockImplementationOnce(async () => {
        eligible = false;
        return { fileBytes: [1], fileName: "worker.agent.png" };
      });
    if (phase === "uploading")
      f.upload.mockImplementationOnce(async () => {
        eligible = false;
        return {
          name: "worker.agent.png",
          url: "https://relay.example/media/file",
          type: "image/png",
          size: 1,
          sha256: "a".repeat(64),
        };
      });
    await expect(
      sendSnapshot({
        ...f,
        recipients: ["recipient"],
        signal: new AbortController().signal,
        validateRecipients,
      }),
    ).rejects.toThrow("Control lost");
    if (phase !== "uploading") expect(f.upload).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  },
);

it("does not upload if control is revoked while encoding is pending", async () => {
  const f = fixture();
  let release!: (value: { fileBytes: number[]; fileName: string }) => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.encode.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  let eligible = true;
  const result = sendSnapshot({
    ...f,
    recipients: ["recipient"],
    signal: new AbortController().signal,
    validateRecipients: () => {
      if (!eligible) throw new Error("Control lost");
    },
  });
  const rejected = expect(result).rejects.toThrow("Control lost");
  await began;
  eligible = false;
  release({ fileBytes: [1], fileName: "worker.agent.png" });
  await rejected;
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

it("rejects an oversized agent snapshot before DM upload", async () => {
  const f = fixture();
  f.encode.mockResolvedValueOnce({
    fileBytes: new Array(10 * 1024 * 1024 + 1).fill(0),
    fileName: "worker.agent.png",
  });
  await expect(
    sendSnapshot({
      ...f,
      recipients: ["recipient"],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "size" });
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

it("revalidates failed receipt retries without re-uploading", async () => {
  const f = fixture();
  Object.assign(f.session.directMessages, { delivery: () => "failed" });
  const validateRecipients = vi.fn(() => {
    throw new Error("Control lost");
  });
  await expect(
    sendSnapshot({
      ...f,
      recipients: ["recipient"],
      signal: new AbortController().signal,
      receipt: { channelId: "conversation", eventId: "failed" },
      validateRecipients,
    }),
  ).rejects.toThrow("Control lost");
  expect(f.delivered).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
});
