import { checkResponse, createProofMemo } from "./event-checks.ts";

const memos = new Map<number, ReturnType<typeof createProofMemo>>();

self.onmessage = (
  message: MessageEvent<
    { id: number; memo: number; text: string } | { release: number }
  >,
) => {
  const data = message.data;
  if ("release" in data) {
    memos.delete(data.release);
    return;
  }
  let proven = memos.get(data.memo);
  if (!proven) {
    proven = createProofMemo();
    memos.set(data.memo, proven);
  }
  self.postMessage({ id: data.id, checked: checkResponse(data.text, proven) });
};
