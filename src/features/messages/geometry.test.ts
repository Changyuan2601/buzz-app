// @vitest-environment jsdom
import { expect, it } from "vitest";
import { geometryFor, geometrySignature, savedGeometry } from "./geometry";
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

it("keeps saved geometry per viewer scope, gated by exact content and width, and bounded", () => {
  localStorage.clear();
  const cache = [[100, 200], 150] as unknown as Parameters<
    ReturnType<typeof savedGeometry>["set"]
  >[3];
  const saved = savedGeometry("scope-a");
  saved.set("a", "v1", 900, cache);
  expect(saved.get("a", "v1", 900)).toEqual(cache);
  expect(savedGeometry("scope-a").get("a", "v1", 900)).toEqual(cache);
  expect(saved.get("a", "v2", 900)).toBeUndefined();
  expect(saved.get("a", "v1x", 900)).toBeUndefined();
  expect(saved.get("a", "v1", 901)).toBeUndefined();
  expect(savedGeometry("scope-b").get("a", "v1", 900)).toBeUndefined();
  for (let i = 0; i < 8; i++) saved.set(`c${i}`, "v1", 900, cache);
  expect(saved.get("a", "v1", 900)).toBeUndefined();
  expect(saved.get("c7", "v1", 900)).toEqual(cache);
  localStorage.setItem(
    'buzz-geometry.v1:"scope-a"',
    JSON.stringify([{ channelId: "a", key: "x", width: 900, cache: [["1"]] }]),
  );
  expect(saved.get("a", "v1", 900)).toBeUndefined();
  localStorage.setItem('buzz-geometry.v1:"scope-a"', "{");
  expect(saved.get("a", "v1", 900)).toBeUndefined();
  localStorage.clear();
});
