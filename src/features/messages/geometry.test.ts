import { expect, it } from "vitest";
import { geometryFor, geometrySignature, openingCache } from "./geometry";
import { createRelaySession } from "../relay/session";
import { foldMessages } from "../relay/fold";
import { keypair, message } from "../relay/testing";

it("invalidates geometry for changed content, profiles, width, session, and history eviction", () => {
  const first = createRelaySession(null),
    second = createRelaySession(null);
  const a = geometryFor(first.session.channels),
    b = geometryFor(second.session.channels);
  const cache = [[100, 200], 150] as unknown as Parameters<typeof a.set>[3];
  a.set("a", "v1", 900, cache);
  expect(a.get("a", "v1", 900)).toBe(cache);
  expect(a.get("a", "v2", 900)).toBeUndefined();
  expect(a.get("a", "v1", 901)).toBeUndefined();
  expect(b.get("a", "v1", 900)).toBeUndefined();
  for (const id of ["b", "c", "d"]) a.set(id, "v1", 900, cache);
  expect(a.get("a", "v1", 900)).toBeUndefined();
  const author = keypair();
  const rows = foldMessages("a", "relay", [message(author, "a", "hello", 20)]);
  expect(geometrySignature(rows, new Map())).not.toBe(
    geometrySignature(rows, new Map([[author.pubkey, { name: "Author" }]])),
  );
  const edited = rows.map((row) => ({ ...row, content: "edited" }));
  expect(geometrySignature(rows, new Map())).not.toBe(
    geometrySignature(edited, new Map()),
  );
  first.dispose();
  second.dispose();
});

it("invalidates row geometry when resolved author or mention labels change", () => {
  const author = keypair();
  const rows = foldMessages("a", "relay", [
    message(author, "a", "hello", 20),
  ]).map((row) => ({ ...row, mentions: ["mentioned"] }));
  const names = new Map([
    [author.pubkey, "Author"],
    ["mentioned", "Mention"],
  ]);
  const resolve = (id: string, fallback: string) => names.get(id) ?? fallback;
  const original = geometrySignature(rows, new Map(), resolve);
  names.set("mentioned", "Longer mention");
  const renamedMention = geometrySignature(rows, new Map(), resolve);
  expect(renamedMention).not.toBe(original);
  names.set(author.pubkey, "Longer author");
  expect(geometrySignature(rows, new Map(), resolve)).not.toBe(renamedMention);
});

it("invalidates cached heights when the workflow owner name arrives or changes", () => {
  const signer = keypair();
  const rows = foldMessages("room", "relay", [
    message(signer, "room", "workflow", 20),
  ]).map((row) => ({ ...row, workflowOwnerId: "owner" }));
  const before = new Map();
  const after = new Map([["owner", { name: "A much longer workflow owner" }]]);
  expect(geometrySignature(rows, before)).not.toBe(
    geometrySignature(rows, after),
  );
  const resolve = (_id: string, fallback: string) => fallback;
  expect(geometrySignature(rows, before, resolve)).not.toBe(
    geometrySignature(rows, after, resolve),
  );
});

it("estimates a cold opening's rows from the prose that bounds the end rows' heights", () => {
  const author = keypair();
  const rows = foldMessages(
    "a",
    "relay",
    [800, 2000, 2000, 120].map((length, index) =>
      message(author, "a", "x".repeat(length), 20 + index),
    ),
  );
  const font = { size: 14, line: 20 };
  // 1000px wraps 4.9px characters into 1, 9, 9 and 3 lines from the end: four
  // rows fill two 220px viewports, so the end range holds them at 55px each.
  expect(openingCache(rows, 220, 1000, font)).toEqual([[], 55]);
  // Rows that cannot fill the viewport, and estimates under Virtua's 40px,
  // keep its default.
  expect(openingCache(rows, 2000, 1000, font)).toBeUndefined();
  expect(openingCache(rows, 30, 1000, font)).toBeUndefined();
  // Rows rendered without their text bound nothing but still count.
  const membership = { ...rows[3], membership: { type: "member_joined" } };
  expect(
    openingCache([...rows.slice(0, 3), membership] as never, 200, 1000, font),
  ).toEqual([[], 50]);
  // Code and tables keep their lines; markup, link targets, mentions, emoji,
  // definitions and comments render shorter than their source.
  for (const content of [
    (text: string) => `\`\`\`\n${text}\n\`\`\``,
    (text: string) => `~~~\n${text}`,
    (text: string) => `    ${text}`,
    (text: string) => `| a | b |\n| - | - |\n| ${text} | b |`,
    (text: string) => `[a](https://example.com/${text})`,
    (text: string) => `![a](https://example.com/${text})`,
    (text: string) => `[a]: https://example.com/${text}`,
    (text: string) => `<!-- ${text} -->`,
    (text: string) => `nostr:${text}`,
    (text: string) => text.replace(/x/g, "*"),
    (text: string) => `:${text}:`,
  ]) {
    const hidden = rows.map((row) => ({
      ...row,
      content: content(row.content),
    }));
    expect(openingCache(hidden, 220, 1000, font)).toBeUndefined();
  }
  // Prose around them still counts.
  const quoted = rows.map((row) => ({
    ...row,
    content: `> **${row.content}**\n\n| a |\n| - |`,
  }));
  expect(openingCache(quoted, 220, 1000, font)).toEqual([[], 55]);
});
