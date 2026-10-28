import { expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import {
  getEventHash,
  verifyEvent as reference,
  type Event,
} from "nostr-tools";
import { keypair, signed } from "./testing";
import { verifyEvent } from "./signature";

const P = schnorr.Point.Fp.ORDER;
const N = schnorr.Point.Fn.ORDER;
const hex32 = (value: bigint) => value.toString(16).padStart(64, "0");
// Never pass the dependency an object carrying its own cached verdict.
const copy = (event: Event): Event => ({
  id: event.id,
  pubkey: event.pubkey,
  sig: event.sig,
  created_at: event.created_at,
  kind: event.kind,
  content: event.content,
  tags: event.tags.map((tag) => [...tag]),
});
// A different key with a matching ID, so the Schnorr check itself decides.
const rehashed = (event: Event, pubkey: string) => {
  const next = { ...event, pubkey };
  return { ...next, id: getEventHash(next) };
};
const agree = (event: Event) => {
  const expected = reference(copy(event));
  expect(verifyEvent(copy(event)), JSON.stringify(event)).toBe(expected);
  return expected;
};
// An x below p with no curve point: x³ + 7 is not a square.
let offCurve = 5n;
while (true) {
  try {
    schnorr.utils.lift_x(offCurve);
    offCurve++;
  } catch {
    break;
  }
}

it("matches the dependency verifier on valid and invalid signatures, before and after an author's table", () => {
  const authors = [keypair(), keypair(), keypair()];
  const results = { valid: 0, invalid: 0 };
  for (let round = 0; round < 8; round++)
    for (const [index, key] of authors.entries()) {
      const event = signed(key, {
        kind: 9,
        created_at: 1_700_000_000 + round,
        content: `round ${round} author ${index}`,
        tags: [["h", "room"]],
      });
      const neighbour = (authors[(index + 1) % 3] ?? key).pubkey;
      const sig = event.sig;
      const r = sig.slice(0, 64);
      const s = sig.slice(64);
      const flip = (text: string, at: number) =>
        text.slice(0, at) +
        (
          (Number.parseInt(text.charAt(at), 16) ^ (1 + (round % 15))) &
          15
        ).toString(16) +
        text.slice(at + 1);
      for (const variant of [
        event,
        { ...event, sig: flip(sig, (round * 7) % 64) }, // r
        { ...event, sig: flip(sig, 64 + ((round * 11) % 64)) }, // s
        { ...event, sig: r + hex32(BigInt(`0x${s}`) + N).slice(-64) },
        { ...event, sig: hex32(P + 1n) + s },
        { ...event, sig: hex32(0n) + s },
        { ...event, sig: r + hex32(0n) },
        { ...event, sig: r + hex32(N) },
        { ...event, sig: `${"f".repeat(64)}${"f".repeat(64)}` },
        { ...event, pubkey: neighbour },
        rehashed(event, neighbour),
        rehashed(event, hex32(P + 3n)),
        rehashed(event, hex32(offCurve)),
        rehashed(event, hex32(0n)),
        { ...event, content: `${event.content}!` },
        { ...event, id: flip(event.id, round) },
      ])
        results[agree(variant) ? "valid" : "invalid"]++;
    }
  expect(results).toEqual({ valid: 24, invalid: 24 * 15 });
});

it("still matches after its author cache evicts and relifts keys", () => {
  const authors = Array.from({ length: 40 }, () => keypair());
  for (let round = 0; round < 2; round++)
    for (const key of authors) {
      const event = signed(key, { kind: 1, content: `${round}`, tags: [] });
      expect(agree(event)).toBe(true);
      expect(
        agree({
          ...event,
          sig: bytesToHex(new Uint8Array(64).fill(round + 1)),
        }),
      ).toBe(false);
    }
});
