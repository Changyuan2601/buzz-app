import "./worker-document";
import { prepareMarkdown } from "./markdown-preparation";
import { parseMessageMarkdown } from "./message-markdown-tree";

self.onmessage = (
  message: MessageEvent<{ id: number; contents: string[] }>,
) => {
  const { id, contents } = message.data;
  self.postMessage({
    id,
    results: contents.map((content) => {
      try {
        const prepared = prepareMarkdown(content);
        return {
          prepared,
          tree:
            prepared.kind === "markdown"
              ? parseMessageMarkdown(prepared.content)
              : undefined,
        };
      } catch {
        return undefined;
      }
    }),
  });
};
