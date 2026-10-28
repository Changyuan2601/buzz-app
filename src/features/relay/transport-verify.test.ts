import { afterEach, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { hostSigner, keypair, signed } from "./testing";
import { yieldToHost } from "./yield";

vi.mock("./yield", () => ({ yieldToHost: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it("hands a read to its caller only after the last verification batch yields", async () => {
  const key = keypair();
  const turns: (() => void)[] = [];
  vi.mocked(yieldToHost).mockImplementation(
    () => new Promise<void>((resolve) => turns.push(resolve)),
  );
  const events = Array.from({ length: 13 }, (_, i) =>
    signed(key, { kind: 9, created_at: i, content: `${i}`, tags: [] }),
  );
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(events)));
  const transport = await connectSignedTransport(
    hostSigner(key),
    "https://relay.test",
    key.pubkey,
  );
  const received = vi.fn();
  void transport.query([{ kinds: [9], limit: 13 }]).then(received);
  for (const batch of [12, 1]) {
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(vi.mocked(yieldToHost)).toHaveBeenCalledTimes(batch === 12 ? 1 : 2);
    expect(received).not.toHaveBeenCalled();
    turns.shift()?.();
  }
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  expect(received.mock.calls[0]?.[0]).toHaveLength(13);
});

it("rejects a read cancelled during the last verification yield", async () => {
  const key = keypair();
  const controller = new AbortController();
  vi.mocked(yieldToHost).mockImplementation(async () => controller.abort());
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify([
          signed(key, { kind: 9, created_at: 1, content: "1", tags: [] }),
        ]),
      ),
  );
  const transport = await connectSignedTransport(
    hostSigner(key),
    "https://relay.test",
    key.pubkey,
  );
  await expect(
    transport.query([{ kinds: [9], limit: 1 }], controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});
