import { expect, it } from "vitest";
import {
  MAX_AGENT_SNAPSHOT_JSON_BYTES,
  MAX_AGENT_SNAPSHOT_PNG_BYTES,
} from "./snapshot";
import {
  MAX_TEAM_SNAPSHOT_JSON_BYTES,
  MAX_TEAM_SNAPSHOT_PNG_BYTES,
} from "./team-encoding";

import { validateSnapshotFile } from "./snapshot-file";

it.each([
  ["agent.png", MAX_AGENT_SNAPSHOT_PNG_BYTES],
  ["agent.json", MAX_AGENT_SNAPSHOT_JSON_BYTES],
  ["team.png", MAX_TEAM_SNAPSHOT_PNG_BYTES],
  ["team.json", MAX_TEAM_SNAPSHOT_JSON_BYTES],
])("uses the owner limit for %s", (format, limit) => {
  const type = format.endsWith("png") ? "image/png" : "application/json";
  expect(() =>
    validateSnapshotFile(
      new File([new Uint8Array(limit)], `worker.${format}`, { type }),
    ),
  ).not.toThrow();
  expect(() =>
    validateSnapshotFile(
      new File([new Uint8Array(limit + 1)], `worker.${format}`, { type }),
    ),
  ).toThrow();
});

it("rejects empty and mismatched file forms", () => {
  for (const file of [
    new File([], "empty.json", { type: "application/json" }),
    new File(["{}"], "worker.pdf", { type: "application/pdf" }),
    new File(["{}"], "worker.png", { type: "application/json" }),
  ]) {
    expect(() => validateSnapshotFile(file)).toThrow();
  }
});
