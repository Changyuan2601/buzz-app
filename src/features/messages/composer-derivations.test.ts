import { describe, expect, it } from "vitest";
import type { Mark, Node as EditorNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import {
  composerMarkdownContext,
  composerSchema as schema,
  projectComposerDocument,
  readComposerSnapshot,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";
import { mentionDraft } from "./mention-draft";

// Derivations are memoized by document identity. A structurally equal document
// that was never derived must project to exactly the same values.
const pubkey = (n: number) => n.toString(16).padStart(64, "0");
const words = [
  "a",
  "Quill",
  " ",
  "@Axel",
  "*x*",
  "`c`",
  "[l](https://e.x)",
  "\n",
  "é",
];

function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function edit(state: EditorState, next: () => number): EditorState {
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(next() * items.length)] as T;
  const size = state.doc.content.size;
  const at = (n: number) => {
    const position = Math.floor(n * (size + 1));
    return TextSelection.near(state.doc.resolve(position)).from;
  };
  const from = at(next()),
    to = Math.max(from, at(next()));
  let marks: readonly Mark[] = [];
  if (next() < 0.2) marks = schema.marks.bold.create().addToSet(marks);
  if (next() < 0.1) marks = schema.marks.code.create().addToSet(marks);
  if (next() < 0.1) marks = schema.marks.literal.create().addToSet(marks);
  const tr = state.tr;
  try {
    switch (pick(["type", "type", "delete", "token", "mention", "split"])) {
      case "type":
        tr.insert(from, schema.text(pick(words).replace("\n", " "), marks));
        break;
      case "delete":
        tr.delete(from, to);
        break;
      case "token":
        tr.replaceWith(
          from,
          to,
          schema.nodes.token.create({
            source: "@Quill",
            recipient:
              next() < 0.5 ? { pubkey: pubkey(1), name: "Quill" } : null,
          }),
        );
        break;
      case "mention":
        tr.insert(
          from,
          schema.text("@Axel", [
            schema.marks.recipient.create({ pubkey: pubkey(2), name: "Axel" }),
          ]),
        );
        break;
      case "split":
        tr.split(from);
        break;
    }
    tr.doc.check();
  } catch {
    return state;
  }
  return state.apply(tr);
}

const plain = (doc: EditorNode) => {
  const source = projectComposerDocument(doc);
  return {
    draft: source.draft,
    positions: source.positions,
    blocks: source.blocks,
    tokens: source.tokens.map(({ node, ...token }) => ({
      ...token,
      node: node.toJSON(),
    })),
    sources: source.positions.map((_, i) => source.source(i)),
    carets: [...Array(source.draft.text.length + 2).keys()].map((offset) => [
      source.position(offset),
      source.position(offset, -1),
    ]),
  };
};

describe("composer derivations", () => {
  it("match fresh derivations of equal documents over random edits", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed);
      let state = EditorState.create({ schema });
      for (let step = 0; step < 30; step++) {
        state = edit(state, next);
        const doc = state.doc;
        const fresh = schema.nodeFromJSON(doc.toJSON());
        expect(projectComposerDocument(doc)).toBe(projectComposerDocument(doc));
        expect(plain(doc)).toEqual(plain(fresh));
        expect(composerMarkdownContext(doc)).toEqual(
          composerMarkdownContext(fresh),
        );
        const { draft } = projectComposerDocument(doc);
        const copy = JSON.parse(JSON.stringify(draft));
        expect(readComposerSnapshot(draft.document)?.eq(fresh)).toBe(true);
        expect(readComposerSnapshot(draft.document)).toBe(
          readComposerSnapshot(draft.document),
        );
        expect(mentionDraft(draft)).toEqual(mentionDraft(copy));
        expect(composerMarkdown(draft)).toBe(composerMarkdown(copy));
      }
    }
  });
});
