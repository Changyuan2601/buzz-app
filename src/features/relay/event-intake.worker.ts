import {
  checkResponse,
  createProofMemo,
  intakeText,
  type IntakeInput,
} from "./event-checks.ts";

// A proof is valid for its exact signed bytes whichever connection read them.
const proven = createProofMemo();

self.onmessage = (message: MessageEvent<IntakeInput & { id: number }>) => {
  const text = intakeText(message.data);
  self.postMessage({
    id: message.data.id,
    checked: text === undefined ? undefined : checkResponse(text, proven),
  });
};
