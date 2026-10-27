import { threadReference } from "../features/relay/thread-reference";

/** Only a nested incoming message changes the ordinary thread-root default. */
export function replyBranch(event: { tags: readonly (readonly string[])[] }) {
  const thread = threadReference(event);
  return thread && thread.parentId !== thread.rootId ? thread : undefined;
}

/** NIP-10 keeps the conversation root separate from the immediate parent. */
export function replyTags(root: string, parent = root) {
  return root === parent
    ? [["e", root, "", "reply"]]
    : [
        ["e", root, "", "root"],
        ["e", parent, "", "reply"],
      ];
}
