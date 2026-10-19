import { expect, it } from "vitest";
import { InstructionSuggestions } from "./instruction-suggestions";

it("offers bounded text only under matching explicit consent and clears partition evidence", () => {
  const store = new InstructionSuggestions();
  const key = "community:viewer:agent";
  expect(() => store.propose(key, "Be brief.", "solo", "type", "")).toThrow(
    "owner must choose",
  );
  store.allow(key, { type: "type", basedOn: "saved", channelId: "solo" });
  expect(() =>
    store.propose(key, "Be brief.", "other", "type", "saved"),
  ).toThrow("owner must choose");
  expect(() =>
    store.propose(key, "Be brief.", "solo", "type", "edited"),
  ).toThrow("changed during");
  for (const bad of ["", "a".repeat(20_001), `bad${String.fromCharCode(0)}`])
    expect(() => store.propose(key, bad, "solo", "type", "saved")).toThrow(
      "1–20,000",
    );
  store.propose(key, "Be brief.", "solo", "type", "saved");
  const proposal = store.snapshot(key);
  expect(proposal).toMatchObject({ text: "Be brief.", basedOn: "saved" });
  expect(() =>
    store.propose(key, "second proposal", "solo", "type", "saved"),
  ).toThrow("owner must choose");
  store.dismiss(key, "stale");
  expect(store.snapshot(key)).toBe(proposal);
  store.clearScope("community:viewer");
  expect(store.snapshot(key)).toBeUndefined();
  expect(() => store.propose(key, "late", "solo", "type", "saved")).toThrow(
    "owner must choose",
  );
});
