import { describe, expect, it } from "vitest";
import { projectMarkdownAttachments } from "./message-content";

describe("projectMarkdownAttachments", () => {
  const image = "https://primary.example/media/a.png";
  const content = `Look ![shot](${image}) and [Notes.pdf](${image}) too`;

  it("reuses the projection of the same body and attachment URLs", () => {
    const first = projectMarkdownAttachments(content, new Set([image]));
    const again = projectMarkdownAttachments(content, new Set([image]));
    expect(again).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual({
      content: "Look  and  too",
      seams: [5, 10],
      urls: [image],
      names: [{ url: image, name: "Notes.pdf" }],
    });
  });

  it("keys the projection on the attachment URLs as well as the body", () => {
    const linked = projectMarkdownAttachments(content, new Set([image]));
    const unlinked = projectMarkdownAttachments(content, new Set());
    expect(unlinked).not.toBe(linked);
    expect(unlinked).toEqual({
      content: `Look  and [Notes.pdf](${image}) too`,
      seams: [5],
      urls: [image],
      names: [],
    });
  });
});
