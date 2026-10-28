// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { rowGeometryKeys, rowSizes } from "./geometry";
import { membershipRows } from "./membership-rows";
import { foldMessages } from "../relay/fold";
import { keypair, message } from "../relay/testing";

afterEach(() => localStorage.clear());

const author = keypair();
const history = (...contents: string[]) =>
  membershipRows(
    foldMessages(
      "room",
      "relay",
      contents.map((content, index) =>
        message(author, "room", content, 100 + index),
      ),
    ),
  );
const keys = (rows: ReturnType<typeof history>, folded = new Set<string>()) =>
  rowGeometryKeys(rows, folded, new Map(), new Map());

it("seeds only rows whose content, neighbors and fold are unchanged", () => {
  const rows = history("one", "two", "three");
  rowSizes.set("seed", "room", "layout", () => keys(rows), [
    [100, 200, 300],
    40,
  ]);
  expect(rowSizes.get("seed", "room", "layout", () => keys(rows))).toEqual([
    [100, 200, 300],
    40,
  ]);
  // Another width, font or pixel ratio seeds nothing.
  expect(
    rowSizes.get("seed", "room", "other", () => keys(rows)),
  ).toBeUndefined();
  const edited = rows.map((row, index) =>
    index === 1 ? { ...row, content: "edited" } : row,
  );
  expect(
    rowSizes.get("seed", "room", "layout", () => keys(edited))?.[0],
  ).toEqual([100, -1, 300]);
  // An arrival changes the stacking context of the previous last row.
  const appended = history("one", "two", "three", "four");
  expect(
    rowSizes.get("seed", "room", "layout", () => keys(appended))?.[0],
  ).toEqual([100, 200, -1, -1]);
  // Folding a row changes its own key and its neighbors'.
  const folded = new Set([rows[1]?.id ?? ""]);
  expect(
    rowSizes.get("seed", "room", "layout", () => keys(rows, folded)),
  ).toBeUndefined();
});

it("keeps measured rows only and forgets the oldest channels", () => {
  const rows = history("one", "two");
  rowSizes.set("bound", "room", "layout", () => keys(rows), [[-1, 50], 40]);
  expect(
    rowSizes.get("bound", "room", "layout", () => keys(rows))?.[0],
  ).toEqual([-1, 50]);
  rowSizes.set("bound", "empty", "layout", () => keys(rows), [[-1, -1], 40]);
  expect(
    rowSizes.get("bound", "empty", "layout", () => keys(rows)),
  ).toBeUndefined();
  for (let index = 0; index < 16; index++)
    rowSizes.set("bound", `c${index}`, "layout", () => keys(rows), [
      [1, 2],
      40,
    ]);
  expect(
    rowSizes.get("bound", "room", "layout", () => keys(rows)),
  ).toBeUndefined();
  expect(rowSizes.get("bound", "c0", "layout", () => keys(rows))?.[0]).toEqual([
    1, 2,
  ]);
});

it("persists sizes with the scope's view state when the page hides", async () => {
  const rows = history("one", "two");
  rowSizes.set("persist", "closed", "layout", () => keys(rows), [[10, 20], 40]);
  const stop = rowSizes.live(() =>
    rowSizes.set("persist", "open", "layout", () => keys(rows), [[30, 40], 40]),
  );
  window.dispatchEvent(new Event("pagehide"));
  stop();
  expect(
    localStorage.getItem(
      `buzz-view.v1:${JSON.stringify(["persist", "timeline-geometry"])}`,
    ),
  ).not.toBeNull();
  vi.resetModules();
  const next = await import("./geometry");
  expect(
    next.rowSizes.get("persist", "closed", "layout", () => keys(rows)),
  ).toEqual([[10, 20], 40]);
  expect(
    next.rowSizes.get("persist", "open", "layout", () => keys(rows)),
  ).toEqual([[30, 40], 40]);
  expect(
    next.rowSizes.get("other", "open", "layout", () => keys(rows)),
  ).toBeUndefined();
});

it("ignores malformed saved sizes", async () => {
  const rows = history("one", "two");
  const [first, second] = keys(rows);
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify(["malformed", "timeline-geometry"])}`,
    JSON.stringify({
      sizeless: { layout: "layout" },
      partial: {
        layout: "layout",
        estimate: "tall",
        sizes: { [first ?? ""]: "40", [second ?? ""]: 60 },
      },
    }),
  );
  vi.resetModules();
  const next = await import("./geometry");
  expect(
    next.rowSizes.get("malformed", "sizeless", "layout", () => keys(rows)),
  ).toBeUndefined();
  expect(
    next.rowSizes.get("malformed", "partial", "layout", () => keys(rows)),
  ).toEqual([[-1, 60]]);
});
