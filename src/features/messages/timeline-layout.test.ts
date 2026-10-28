import { describe, expect, it } from "vitest";

import { createTimelineLayout } from "./timeline-layout";

describe("createTimelineLayout", () => {
  it("places unmeasured rows at the default estimate", () => {
    const layout = createTimelineLayout();
    layout.setKeys(["a", "b", "c"]);
    expect(layout.offset(2)).toBe(80);
    expect(layout.total()).toBe(120);
    expect(layout.estimating()).toBe(true);
  });

  it("keeps sizes with their keys when rows are inserted before them", () => {
    const layout = createTimelineLayout();
    layout.setKeys(["a", "b"]);
    layout.setSizes(
      [
        ["a", 10],
        ["b", 30],
      ],
      0,
    );
    layout.setKeys(["a", "x", "b"]);
    expect(layout.size(2)).toBe(30);
    expect(layout.offset(2)).toBe(50);
    expect(layout.measured(1)).toBe(false);
  });

  it("estimates the median measured size once measurements exceed the viewport", () => {
    const layout = createTimelineLayout();
    layout.setKeys(["a", "b", "c", "d"]);
    layout.setSizes(
      [
        ["a", 20],
        ["b", 100],
        ["c", 30],
      ],
      100,
    );
    expect(layout.estimating()).toBe(false);
    expect(layout.size(3)).toBe(30);
    expect(layout.total()).toBe(180);
  });

  it("offsets every row by the drift", () => {
    const layout = createTimelineLayout();
    layout.setKeys(["a", "b"]);
    layout.setDrift(-15);
    expect(layout.offset(0)).toBe(-15);
    expect(layout.offset(1)).toBe(25);
  });

  it("finds the last row starting at or before an offset", () => {
    const layout = createTimelineLayout();
    layout.setKeys(["a", "b", "c"]);
    expect(layout.find(-5)).toBe(0);
    expect(layout.find(40)).toBe(1);
    expect(layout.find(79)).toBe(1);
    expect(layout.find(500)).toBe(2);
  });

  it("restores a snapshot of the current rows", () => {
    const layout = createTimelineLayout();
    layout.setKeys(["a", "b"]);
    layout.setSizes(
      [
        ["a", 70],
        ["b", 90],
        ["gone", 5],
      ],
      100,
    );
    const snapshot = layout.snapshot();
    expect([...snapshot.sizes]).toEqual([
      ["a", 70],
      ["b", 90],
    ]);
    const restored = createTimelineLayout(snapshot);
    restored.setKeys(["new", "a", "b"]);
    expect(restored.estimating()).toBe(false);
    expect(restored.total()).toBe(snapshot.estimate + 160);
  });
});
