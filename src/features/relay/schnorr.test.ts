import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { expect, it } from "vitest";
import { verifySchnorr } from "./schnorr";

it("matches noble's BIP340 verify for valid, tampered and malformed input", () => {
  const key = () => {
    const secret = schnorr.utils.randomSecretKey();
    return { secret, pubkey: bytesToHex(schnorr.getPublicKey(secret)) };
  };
  const secrets = [key(), key(), key()] as const;
  const cases: [string, string, string][] = [];
  for (let i = 0; i < 60; i++) {
    const { secret, pubkey } = secrets[(i % 3) as 0 | 1 | 2];
    const other = secrets[((i + 1) % 3) as 0 | 1 | 2];
    const id = bytesToHex(schnorr.utils.taggedHash("test", Uint8Array.of(i)));
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret));
    const flip = (hex: string, at: number) =>
      hex.slice(0, at) + (hex[at] === "0" ? "1" : "0") + hex.slice(at + 1);
    cases.push(
      [sig, id, pubkey],
      [flip(sig, i % 128), id, pubkey],
      [sig, flip(id, i % 64), pubkey],
      [sig, id, flip(pubkey, i % 64)],
      [sig, id, other.pubkey],
    );
  }
  const p = "f".repeat(64); // ≥ field prime: not an x coordinate
  const n = "f".repeat(64); // ≥ group order: not a scalar
  const [[sig, id, pubkey]] = cases as [[string, string, string]];
  cases.push(
    [sig, id, p],
    [sig, id, "0".repeat(64)],
    [p + sig.slice(64), id, pubkey],
    [sig.slice(0, 64) + n, id, pubkey],
    ["0".repeat(64) + sig.slice(64), id, pubkey],
    [sig.slice(0, 64) + "0".repeat(64), id, pubkey],
  );
  // Each case twice: once with a newly lifted key, once with its table.
  for (const round of [0, 1])
    for (const [sig, id, pubkey] of cases)
      expect(verifySchnorr(sig, id, pubkey), `${round} ${sig} ${pubkey}`).toBe(
        schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(pubkey)),
      );
  expect(cases.filter(([s, i, k]) => verifySchnorr(s, i, k))).toHaveLength(60);
});
