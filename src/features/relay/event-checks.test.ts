import { expect, it, vi } from "vitest";
import { byteSize, listByteSize } from "./budget";
import { checkResponse, createProofMemo } from "./event-checks";
import { keypair, signed } from "./testing";

// Run the worker's checks inline: the shared module and memo are what ship.
vi.mock("./event-intake", async () => {
  const checks = await import("./event-checks");
  return {
    createResponseIntake: () => {
      const proven = checks.createProofMemo();
      return async (input: Parameters<typeof checks.intakeText>[0]) => {
        const text = checks.intakeText(input);
        return text === undefined
          ? undefined
          : checks.checkResponse(text, proven);
      };
    },
  };
});
const { checkSavedEvents, createEventVerifier, eventDto, hasEventProof } =
  await import("./events");

const key = keypair();
const other = keypair();
const events = [
  signed(key, { kind: 9, content: "hello", tags: [["h", "a".repeat(64)]] }),
  signed(other, { kind: 9, content: "é ünïcödé 🎉", tags: [] }),
  signed(key, { kind: 7, content: "+", tags: [["e", "b".repeat(64)]] }),
];

/** What parseEvents admits, or the message it throws. */
function mainThread(text: string) {
  const verify = createEventVerifier();
  try {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return "not an array";
    return raw.map(verify);
  } catch (error) {
    return (error as Error).message;
  }
}

it("admits exactly the events and byte sizes the main-thread checks admit", async () => {
  expect(createEventVerifier().response).toBeDefined();
  for (const response of [
    events,
    [],
    [events[0], events[0]],
    [...events].reverse(),
  ]) {
    const text = JSON.stringify(response);
    const expected = mainThread(text);
    const checked = (await createEventVerifier().response?.(text)) ?? [];
    expect(checked).toEqual(expected);
    for (const event of checked) {
      expect(hasEventProof(event)).toBe(true);
      expect(Object.isFrozen(event) && Object.isFrozen(event.tags)).toBe(true);
    }
    expect(listByteSize(checked)).toBe(byteSize(checked));
  }
});

it("declines every response the main thread rejects, so it can throw the same error", async () => {
  const first = events[0] as (typeof events)[number];
  const rejected = [
    "not json",
    JSON.stringify({ events }),
    JSON.stringify([...events, { ...first, content: "changed" }]),
    JSON.stringify([{ ...first, sig: first.sig.toUpperCase() }]),
    JSON.stringify([{ ...first, created_at: 1.5 }]),
    JSON.stringify([{ ...first, tags: [[1]] }]),
    JSON.stringify([null]),
  ];
  for (const text of rejected) {
    expect(typeof mainThread(text)).toBe("string");
    const verify = createEventVerifier();
    expect(verify.response).toBeDefined();
    expect(await verify.response?.(text)).toBeUndefined();
  }
});

it("reuses a connection's proofs only for identical signed bytes", () => {
  const proven = createProofMemo();
  const text = JSON.stringify(events);
  expect(checkResponse(text, proven)?.events).toHaveLength(3);
  expect(checkResponse(text, proven)?.events).toHaveLength(3);
  const forged = JSON.stringify([{ ...events[0], content: "forged" }]);
  expect(checkResponse(forged, proven)).toBeUndefined();
});

it("restores exactly the saved records the main-thread round trip admits", async () => {
  const restore = (saved: readonly unknown[]) => {
    try {
      return saved.map((value) => eventDto(JSON.parse(JSON.stringify(value))));
    } catch {
      return undefined;
    }
  };
  const first = events[0] as (typeof events)[number];
  for (const saved of [
    events,
    [{ ...first, extra: "dropped" }],
    [{ ...first, content: "changed" }],
    [first, undefined],
    [{ ...first, created_at: Number.NaN }],
    [{ ...first, created_at: new Date(0) }],
  ]) {
    const restored = await checkSavedEvents(saved);
    expect(restored).toEqual(restore(saved));
    for (const event of restored ?? []) expect(hasEventProof(event)).toBe(true);
  }
});
