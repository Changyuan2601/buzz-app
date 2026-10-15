import { expect, it } from "vitest";
import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";
import {
  assistiveAddresses,
  decodeAssistive,
  signAssistive,
} from "./assistive-ux.mjs";
import fixture from "../tests/assistive-codec.json";
const secret = Uint8Array.from(Buffer.from(fixture.secret, "hex"));
const fact = { id: "threads.new-thread-placement", outcome: "dismissed" };
it("matches the native opaque coordinate contract and encrypts every independent outcome", () => {
  expect(assistiveAddresses(secret, fixture.community)).toEqual(
    fixture.addresses,
  );
  for (const address of fixture.addresses) {
    const value = { id: address.id, outcome: address.outcome };
    const event = signAssistive(value, secret, fixture.community);
    expect(event.tags[0][1]).toBe(address.coordinate);
    expect(event.content).not.toContain(address.id);
    expect(decodeAssistive([event], secret, fixture.community)).toEqual([
      { eventId: event.id, fact: value },
    ]);
  }
});
it("refuses foreign authors, tampered signatures, context replay, schema and tag expansion", () => {
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  const good = signAssistive(fact, secret, fixture.community);
  const raw = (patch) => finalizeEvent({ ...good, ...patch }, secret);
  try {
    for (const bad of [
      { ...good, content: "tampered" },
      raw({ tags: [...good.tags, ["p", getPublicKey(secret)]] }),
      raw({ tags: [...good.tags].reverse() }),
      raw({
        content: nip44.v2.encrypt(
          JSON.stringify({ version: 2, community: fixture.community, ...fact }),
          key,
        ),
      }),
      raw({
        content: nip44.v2.encrypt(
          JSON.stringify({
            version: 1,
            community: fixture.community,
            ...fact,
            extra: true,
          }),
          key,
        ),
      }),
    ])
      expect(() => decodeAssistive([bad], secret, fixture.community)).toThrow();
    expect(() =>
      decodeAssistive([good], secret, "https://other.test"),
    ).toThrow();
    expect(() =>
      decodeAssistive([good], new Uint8Array(32).fill(2), fixture.community),
    ).toThrow();
    expect(() =>
      decodeAssistive(Array(97).fill(good), secret, fixture.community),
    ).toThrow();
    expect(() =>
      signAssistive({ ...fact, outcome: "other" }, secret, fixture.community),
    ).toThrow();
  } finally {
    key.fill(0);
  }
});
