import { afterEach, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { hostSigner, keypair, signed } from "./testing";
import { yieldToHost } from "./yield";

vi.mock("./yield", () => ({ yieldToHost: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(yieldToHost).mockReset();
});

function serve(count: number) {
  const key = keypair();
  const events = Array.from({ length: count }, (_, i) =>
    signed(key, { kind: 9, created_at: i, content: `${i}`, tags: [] }),
  );
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(events)));
  return key;
}

it("hands a read to its caller only after the last verification batch yields", async () => {
  const turns: (() => void)[] = [];
  vi.mocked(yieldToHost).mockImplementation(
    () => new Promise<void>((resolve) => turns.push(resolve)),
  );
  const key = serve(13);
  const transport = await connectSignedTransport(
    hostSigner(key),
    "https://relay.test",
    key.pubkey,
  );
  const received = vi.fn();
  void transport.query([{ kinds: [9], limit: 13 }]).then(received);
  for (const calls of [1, 2]) {
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(vi.mocked(yieldToHost)).toHaveBeenCalledTimes(calls);
    expect(received).not.toHaveBeenCalled();
    turns.shift()?.();
  }
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  expect(received.mock.calls[0]?.[0]).toHaveLength(13);
});

it("cancels a read aborted during its last yield", async () => {
  const turns: (() => void)[] = [];
  vi.mocked(yieldToHost).mockImplementation(
    () => new Promise<void>((resolve) => turns.push(resolve)),
  );
  const key = serve(3);
  const transport = await connectSignedTransport(
    hostSigner(key),
    "https://relay.test",
    key.pubkey,
  );
  const controller = new AbortController();
  const read = transport.query([{ kinds: [9], limit: 3 }], controller.signal);
  await vi.waitFor(() => expect(turns).toHaveLength(1));
  controller.abort();
  turns.shift()?.();
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
});
