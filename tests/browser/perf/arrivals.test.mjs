import { describe, expect, it } from "vitest";
import { arrivalLatencies, latencySummary } from "./arrivals.mjs";

describe("arrivalLatencies", () => {
  it("uses the first frame showing each row in recording time", () => {
    const recording = {
      startMs: 1000,
      frames: [
        { t: 10, rows: [["old", 0, 10]] },
        { t: 30, rows: [["a", 0, 10]] },
        {
          t: 50,
          rows: [
            ["a", 0, 10],
            ["b", 10, 10],
          ],
        },
      ],
    };
    // Node clock is 500ms behind the page clock.
    const arrivals = arrivalLatencies(
      recording,
      [
        { id: "a", at: 515 },
        { id: "b", at: 530 },
        { id: "c", at: 540 },
      ],
      500,
    );
    expect(arrivals).toEqual([
      { id: "a", emitT: 15, visibleT: 30, latencyMs: 15 },
      { id: "b", emitT: 30, visibleT: 50, latencyMs: 20 },
      { id: "c", emitT: 40, visibleT: undefined, latencyMs: undefined },
    ]);
    expect(latencySummary(arrivals)).toEqual({
      arrivalP50Ms: 15,
      arrivalP95Ms: 20,
      arrivalMaxMs: 20,
    });
  });

  it("rejects a burst with no visible arrival", () => {
    expect(() => latencySummary([{ latencyMs: undefined }])).toThrow();
  });
});
