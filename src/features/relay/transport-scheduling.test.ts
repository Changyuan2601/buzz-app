import { afterEach, expect, it, vi } from "vitest";
import { connectBrokerTransport, connectSignedTransport } from "./transport";
import { hasEventProof } from "./events";
import { hostSigner, keypair, signed } from "./testing";
import { yieldToHost } from "./yield";

vi.mock("./yield", () => ({ yieldToHost: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const key = keypair();
const originals = Array.from({ length: 40 }, (_, index) =>
  signed(key, { kind: 9, content: `message ${index}`, tags: [["h", "a"]] }),
);
// Duplicates and response order are part of the finite transport response.
const events = [...originals, ...originals.slice(0, 1)];
const filters = [{ kinds: [9], "#h": ["a"], limit: events.length }];

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(
  (["broker", "signed"] as const).flatMap((mode) =>
    (["complete", "cancel", "corrupt"] as const).map((outcome) => ({
      mode,
      outcome,
    })),
  ),
)(
  "$mode yields without delivering a partial response: $outcome",
  async ({ mode, outcome }) => {
    const entered = gate();
    const released = gate();
    vi.mocked(yieldToHost)
      .mockResolvedValue(undefined)
      .mockImplementationOnce(() => {
        entered.resolve();
        return released.promise;
      });
    // Make elapsed-budget scheduling deterministic too; no assertion depends on
    // how fast the real signature verifier runs or on a particular slice size.
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 10));
    let payload = JSON.parse(JSON.stringify(events));
    if (outcome === "corrupt") payload.at(-1).content = "changed signed bytes";
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/session")
        ? Response.json({ viewer: key.pubkey, relayAuthor: key.pubkey })
        : Response.json(payload),
    );
    const transport =
      mode === "broker"
        ? await connectBrokerTransport()
        : await connectSignedTransport(
            hostSigner(key),
            "https://scheduling.test",
            key.pubkey,
          );
    const controller = new AbortController();
    let settled = false;
    const result = transport.query(filters, controller.signal).then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { value: undefined, error };
      },
    );
    try {
      await entered.promise;
      expect(settled).toBe(false);
      if (outcome === "cancel") controller.abort();
    } finally {
      released.resolve();
    }
    const completed = await result;
    if (outcome === "complete") {
      expect(completed.error).toBeUndefined();
      expect(completed.value?.map(({ id }) => id)).toEqual(
        events.map(({ id }) => id),
      );
      expect(completed.value?.every(hasEventProof)).toBe(true);
    } else {
      expect(completed.value).toBeUndefined();
      if (outcome === "cancel")
        expect(completed.error).toMatchObject({ name: "AbortError" });
      else
        expect(completed.error).toEqual(
          expect.objectContaining({
            message: expect.stringMatching(/malformed|invalidly signed/),
          }),
        );
      payload = JSON.parse(JSON.stringify(events));
      expect((await transport.query(filters)).map(({ id }) => id)).toEqual(
        events.map(({ id }) => id),
      );
    }
  },
);
