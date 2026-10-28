import { expect, it } from "vitest";
import type { Mark, Node as EditorNode } from "prosemirror-model";
import { composerSchema, projectComposerDocument } from "./composer-document";
import { composerMarkdown, documentMarkdown } from "./composer-markdown";

const { nodes, marks } = composerSchema;
const text = (value: string, ...applied: Mark[]) =>
  composerSchema.text(value, applied);
const paragraph = (...content: EditorNode[]) =>
  nodes.paragraph.create(null, content);
const doc = (...content: EditorNode[]) => nodes.doc.create(null, content);
const recipient = marks.recipient.create({
  pubkey: "a".repeat(64),
  name: "Quill",
});

it("serializes an editor document as its projected draft does", () => {
  const documents = [
    doc(paragraph()),
    doc(paragraph(text("Checking the draft under pressure"))),
    doc(paragraph(text("a *b* `c` [d](e) <f> \\ _g_")), paragraph(text("two"))),
    doc(
      paragraph(
        text("bold", marks.bold.create()),
        text(" and "),
        text("code*", marks.code.create()),
        text(" "),
        text("site", marks.link.create({ href: "https://example.com" })),
        text("x", marks.italic.create(), marks.strike.create()),
        text("lit `", marks.literal.create()),
      ),
    ),
    doc(
      paragraph(text("line"), nodes.hard_break.create(), text("next")),
      nodes.blockquote.create(null, [paragraph(text("quoted"))]),
      nodes.bullet_list.create(null, [
        nodes.list_item.create(null, [paragraph(text("one"))]),
        nodes.list_item.create(null, [paragraph(text("two"))]),
      ]),
      nodes.ordered_list.create({ order: 3 }, [
        nodes.list_item.create(null, [paragraph(text("three"))]),
      ]),
      nodes.code_block.create({ language: "ts" }, [text("const a = 1;\n```")]),
    ),
    doc(
      paragraph(
        text("hi "),
        nodes.token.create({ source: ":wave:" }),
        text(" "),
        nodes.token.create({ source: "@Quill", editAsText: true }),
      ),
    ),
    // Recipients and resources take the validated snapshot path.
    doc(paragraph(text("hey "), text("@Quill", recipient), text(" there"))),
    doc(
      paragraph(
        nodes.token.create({
          source: "@Quill",
          recipient: { pubkey: "b".repeat(64), name: "Quill" },
        }),
      ),
    ),
    doc(
      paragraph(
        text("see "),
        nodes.token.create({
          source: "[doc](https://example.com/doc)",
          resource: { uri: "https://example.com/doc", label: "doc" },
        }),
      ),
    ),
    // Beyond the snapshot bounds the draft text is sent verbatim.
    doc(paragraph(text("*".repeat(16001), marks.bold.create()))),
  ];
  for (const document of documents)
    expect(documentMarkdown(document)).toBe(
      composerMarkdown(projectComposerDocument(document).draft),
    );
});
