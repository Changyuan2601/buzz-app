import { expect, test } from "vitest";
import { editorMetrics } from "./editor-recorder.mjs";

test("missing input keeps queue evidence without attributing another key to acceptance", () => {
  const recording = {
    actions: [
      { key: "a", phase: "typing", text: "a" },
      { key: "Enter", phase: "accept", recipient: "Axel" },
    ],
    events: [
      { key: "Enter", eventMs: 10, handlerMs: 50, target: true, trusted: true },
    ],
    frames: [
      {
        t: 100,
        text: "a",
        selection: [1, 1],
        options: [],
        recipients: ["Axel"],
        chips: 1,
        probeMs: 1,
      },
    ],
  };
  const metrics = editorMetrics(recording, {
    receipts: [{ plannedMs: 0, sentMs: 1, ackMs: 90 }],
  });
  expect(recording.inputReceipt.ordered).toBe(false);
  expect(metrics.inputQueueMaxMs).toBe(40);
  expect(metrics.typingStateMaxMs).toBeUndefined();
  expect(metrics.acceptStateMaxMs).toBeUndefined();
  expect(recording.keys[0].phase).toBe("unattributed");
});

test("recreated text cannot credit an earlier key, while acceptance can appear during continued typing", () => {
  const recording = {
    actions: [
      { key: "a", phase: "typing", text: "a", selection: [1, 1] },
      { key: "b", phase: "typing", text: "ab", selection: [2, 2] },
      { key: "Backspace", phase: "backspace", text: "a", selection: [1, 1] },
      { key: "Enter", phase: "accept", recipient: "Axel" },
      { key: "c", phase: "continue", text: "ac", selection: [2, 2] },
    ],
    events: ["a", "b", "Backspace", "Enter", "c"].map((key, i) => ({
      key,
      eventMs: [0, 10, 20, 40, 50][i],
      handlerMs: [5, 15, 25, 45, 55][i],
      target: true,
      trusted: true,
    })),
    frames: [
      {
        t: 35,
        text: "a",
        selection: [1, 1],
        options: [],
        recipients: [],
        chips: 0,
        probeMs: 1,
      },
      {
        t: 65,
        text: "ac",
        selection: [2, 2],
        options: [],
        recipients: ["Axel"],
        chips: 1,
        probeMs: 1,
      },
    ],
  };
  const metrics = editorMetrics(recording, { receipts: [] });
  expect(recording.keys[0].stateObservedMs).toBeNull();
  expect(metrics.typingUnobservedStates).toBe(2);
  expect(metrics.backspaceStateMaxMs).toBe(15);
  expect(metrics.acceptStateMaxMs).toBe(25);
  expect(metrics.continueStateMaxMs).toBe(15);
});
