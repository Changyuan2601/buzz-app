// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  clearViewScope,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import {
  readShareHistory,
  saveShareHistory,
  shareHistoryKey,
} from "./share-history";

const source = "source";
const scope = `https://community.test:${"a".repeat(64)}`;
const person = "b".repeat(64);
const other = "c".repeat(64);
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("merges recorded channel/direct shares on this device without crossing source, viewer or community scopes", () => {
  const first = { id: "planning", name: "Planning", members: [person] };
  saveShareHistory(scope, source, [person], first);
  saveShareHistory(scope, source, [other], { ...first, members: [other] });
  saveShareHistory(scope, source, [], {
    id: "design",
    name: "Design",
    members: [person],
  });
  const current = () =>
    readShareHistory(viewRevision(scope, shareHistoryKey(source)));
  expect(current()).toEqual({
    version: 1,
    people: [person, other],
    channels: [
      { ...first, members: [person, other] },
      { id: "design", name: "Design", members: [person] },
    ],
  });
  for (const [partition, id] of [
    [scope, "different"],
    [`https://other.test:${"a".repeat(64)}`, source],
    [`https://community.test:${"d".repeat(64)}`, source],
  ] as const) {
    expect(
      readShareHistory(viewRevision(partition, shareHistoryKey(id))).channels,
    ).toEqual([]);
  }
  clearViewScope(scope);
  expect(current().channels).toEqual([]);
});

it("preserves malformed history and surfaces denied storage rather than silently replacing provenance", () => {
  const key = shareHistoryKey(source);
  writeView(scope, key, {
    version: 1,
    channels: [{ id: "planning", name: "Planning", members: ["invalid"] }],
    people: [],
  });
  const original = viewRevision(scope, key);
  expect(() => saveShareHistory(scope, source, [person])).toThrow(
    "Sharing history is unavailable on this device.",
  );
  expect(viewRevision(scope, key)).toBe(original);
  localStorage.clear();
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Full");
  });
  expect(() => saveShareHistory(scope, source, [person])).toThrow(
    "couldn’t be saved",
  );
  set.mockRestore();
  expect(viewRevision(scope, key)).toBeNull();
});

it("bounds the total serialized history and leaves the last saved segments intact", () => {
  saveShareHistory(scope, source, [person]);
  const original = viewRevision(scope, shareHistoryKey(source));
  const members = Array.from({ length: 1000 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  expect(() =>
    saveShareHistory(scope, source, [], {
      id: "large",
      name: "Large",
      members,
    }),
  ).toThrow("Sharing history is full on this device. Access is unchanged.");
  expect(viewRevision(scope, shareHistoryKey(source))).toBe(original);
});
