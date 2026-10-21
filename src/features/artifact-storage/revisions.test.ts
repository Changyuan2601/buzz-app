import { expect, it } from "vitest";
import { emptyArtifact, receiveRevision } from "./revisions";
const revision = (id: string, parents: string[] = []) => ({
  id,
  parents,
  content: id,
});

it("keeps descendants when older confirmations arrive", () => {
  let saved = receiveRevision(emptyArtifact("task"), revision("v0"));
  saved = receiveRevision(saved, revision("v1", ["v0"]));
  saved = receiveRevision(saved, revision("v0"));
  expect(saved.record.current?.id).toBe("v1");
  expect(saved.record.conflicts).toEqual([]);
});
it("retains conflicts and the usable view until a merge descends from both", () => {
  let saved = receiveRevision(emptyArtifact("task"), revision("root"));
  saved = receiveRevision(saved, revision("left", ["root"]));
  saved = receiveRevision(saved, revision("right", ["root"]));
  expect(saved.record.current?.id).toBe("left");
  expect(saved.record.conflicts.map((r) => r.id)).toEqual(["right"]);
  saved = receiveRevision(saved, revision("merge", ["left", "right"]));
  expect(saved.record.current?.id).toBe("merge");
  expect(saved.record.conflicts).toEqual([]);
});
it("keeps unknown ancestry unresolved and joins it when missing parents arrive", () => {
  let saved = receiveRevision(emptyArtifact("task"), revision("root"));
  saved = receiveRevision(saved, revision("new", ["missing"]));
  expect(saved.record.current?.id).toBe("root");
  expect(saved.record.unresolved).toBe(true);
  saved = receiveRevision(saved, revision("missing", ["root"]));
  expect(saved.record.current?.id).toBe("new");
  expect(saved.record.unresolved).toBe(false);
});
it("rejects ancestry cycles and changed immutable revisions", () => {
  const saved = receiveRevision(emptyArtifact("task"), revision("a", ["b"]));
  expect(() => receiveRevision(saved, revision("b", ["a"]))).toThrow("cycle");
  expect(() => receiveRevision(saved, revision("a"))).toThrow(
    "ancestry mismatch",
  );
  expect(() =>
    receiveRevision(saved, { ...revision("a", ["b"]), content: "changed" }),
  ).toThrow("content mismatch");
});
