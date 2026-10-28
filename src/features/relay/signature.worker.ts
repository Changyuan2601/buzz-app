import { schnorr } from "@noble/curves/secp256k1.js";
import { validSignature, type SignatureCheck } from "./signature";

// Build noble's generator table now, not during the first read.
schnorr.Point.BASE.multiply(3n);

self.onmessage = (event: MessageEvent<SignatureCheck[]>) => {
  self.postMessage(event.data.map(validSignature));
};
