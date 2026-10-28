import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, hexToBytes } from "@noble/curves/utils.js";
import { ByteLru } from "./budget.ts";

const { Point } = schnorr;
type Key = { point: InstanceType<typeof Point>; uses: number };
// A history page repeats a few authors. Reuse each author's lifted key, and give
// a repeat author a small multiplication table: 1.9ms once, then about 2.4x
// faster verifies. A one-off author keeps the stock cost. About 120KB per table.
const keys = new ByteLru<Key>(32, 32);

/** BIP340 verify, equal to `schnorr.verify(hexToBytes(sig), hexToBytes(id),
 * hexToBytes(pubkey))`, with a bounded memo of public keys (never of results). */
export function verifySchnorr(sig: string, id: string, pubkey: string) {
  const { Fp, Fn, BASE } = Point;
  try {
    let key = keys.get(pubkey);
    if (!key) {
      // Fails, as verify does, unless the key is a valid x coordinate.
      key = {
        point: schnorr.utils.lift_x(bytesToNumberBE(hexToBytes(pubkey))),
        uses: 0,
      };
      keys.set(pubkey, key, 1);
    } else if (++key.uses === 1) key.point.precompute(4, false);
    const bytes = hexToBytes(sig);
    const r = bytesToNumberBE(bytes.subarray(0, 32));
    if (!Fp.isValidNot0(r)) return false;
    const s = bytesToNumberBE(bytes.subarray(32, 64));
    if (!Fn.isValidNot0(s)) return false;
    const e = Fn.create(
      bytesToNumberBE(
        schnorr.utils.taggedHash(
          "BIP0340/challenge",
          Fn.toBytes(r),
          hexToBytes(pubkey),
          hexToBytes(id),
        ),
      ),
    );
    // R = s⋅G - e⋅P. A precomputed point rejects the zero scalar; -0⋅P is zero.
    const R = BASE.multiplyUnsafe(s).add(
      e === 0n ? Point.ZERO : key.point.multiplyUnsafe(Fn.neg(e)),
    );
    if (R.is0()) return false;
    const { x, y } = R.toAffine();
    return y % 2n === 0n && x === r;
  } catch {
    return false;
  }
}
