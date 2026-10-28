import { expect, it } from "vitest";
import { verifyEvent } from "nostr-tools";
import { eventDto, restoredEventDto } from "./events";
import { keypair, signed } from "./testing";
const key = keypair();
it.each([Infinity, -Infinity, NaN, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
  "rejects signed but invalid timestamp %s before authoritative head selection",
  (created_at) => {
    const event = signed(key, { kind: 0, created_at, content: "{}", tags: [] });
    expect(verifyEvent(event)).toBe(true); // dependency's cached proof is not envelope validation
    expect(() => eventDto(event)).toThrow(/malformed/);
  },
);
it.each([Infinity, -Infinity, NaN, 0.5, -1, 65536])(
  "rejects out-of-protocol kind %s",
  (kind) => {
    expect(() =>
      eventDto(signed(key, { kind, content: "", tags: [] })),
    ).toThrow(/malformed/);
  },
);
it("raw JSON overflow is cryptographically valid under dependency null serialization but invalid protocol", () => {
  const event = signed(key, {
    kind: 0,
    created_at: Infinity,
    content: "{}",
    tags: [],
  });
  const parsed = JSON.parse(
    JSON.stringify(event).replace('"created_at":null', '"created_at":1e400'),
  );
  expect(parsed.created_at).toBe(Infinity);
  expect(verifyEvent(parsed)).toBe(true);
  expect(() => eventDto(parsed)).toThrow(/malformed/);
});
it("cached verification cannot bless changed bytes or non-canonical signature text", () => {
  const event = signed(key, { kind: 0, content: "{}", tags: [] });
  expect(() => eventDto({ ...event, content: '{"name":"changed"}' })).toThrow();
  expect(() => eventDto({ ...event, sig: event.sig.toUpperCase() })).toThrow();
});
it("a second restore of saved bytes proves them by content hash, never by ID alone", () => {
  const event = signed(key, { kind: 1, content: "saved", tags: [] });
  const saved = () => JSON.parse(JSON.stringify(event));
  expect(restoredEventDto(saved())).toEqual(eventDto(saved()));
  // The proof is remembered now; changed bytes or signatures still fail.
  expect(restoredEventDto(saved())).toEqual(eventDto(saved()));
  expect(() => restoredEventDto({ ...saved(), content: "changed" })).toThrow();
  expect(() =>
    restoredEventDto({ ...saved(), sig: "0".repeat(128) }),
  ).toThrow();
  expect(() =>
    restoredEventDto({ ...saved(), sig: event.sig.toUpperCase() }),
  ).toThrow();
});
it("accepts integer boundary values without imposing wall-clock freshness and owns frozen wire fields only", () => {
  for (const created_at of [0, 4294967296, Number.MAX_SAFE_INTEGER]) {
    const original = signed(key, {
      kind: 65535,
      created_at,
      content: "",
      tags: [["p", key.pubkey]],
    });
    const result = eventDto({
      ...original,
      injected: { private: "not retained" },
    });
    expect(result.created_at).toBe(created_at);
    expect(result).not.toHaveProperty("injected");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tags[0])).toBe(true);
    original.tags[0]?.push("changed");
    expect(result.tags[0]).toHaveLength(2);
  }
});
