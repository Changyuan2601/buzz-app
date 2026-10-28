import { expect, it, vi } from "vitest";
import { prepareMarkdown } from "./markdown-preparation";
import { parseMessageMarkdown } from "./message-markdown-tree";

it("answers each body with its preparation and parsed tree", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("self", { postMessage });
  await import("./markdown-preparation.worker");
  const contents = ["plain prose", "*em* and `code`", "a &amp; b"];
  (self.onmessage as (message: { data: unknown }) => void)({
    data: { id: 7, contents },
  });
  expect(postMessage).toHaveBeenCalledWith({
    id: 7,
    results: contents.map((content) => {
      const prepared = prepareMarkdown(content);
      return {
        prepared,
        tree:
          prepared.kind === "markdown"
            ? parseMessageMarkdown(prepared.content)
            : undefined,
      };
    }),
  });
  vi.unstubAllGlobals();
});
