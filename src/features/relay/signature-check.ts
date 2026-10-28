import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/curves/utils.js";

/** One event's BIP-340 check: signature, event hash (its ID) and author. */
export type SignatureCheck = readonly [
  sig: string,
  hash: string,
  pubkey: string,
];

/** nostr-tools' verifyEvent after its ID matched the event hash. */
export function validSignature([sig, hash, pubkey]: SignatureCheck): boolean {
  try {
    return schnorr.verify(
      hexToBytes(sig),
      hexToBytes(hash),
      hexToBytes(pubkey),
    );
  } catch {
    return false;
  }
}
