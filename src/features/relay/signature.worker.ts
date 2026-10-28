import { validSignature, type SignatureCheck } from "./signature-check";

self.onmessage = (
  event: MessageEvent<{ id: number; checks: SignatureCheck[] }>,
) => {
  const { id, checks } = event.data;
  self.postMessage({ id, valid: checks.map(validSignature) });
};
