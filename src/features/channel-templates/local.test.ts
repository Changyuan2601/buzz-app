// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { channelTemplates, templateAgents, TEMPLATES_KEY } from "./local";

afterEach(() => localStorage.clear());

it("saves, replaces and removes templates, telling listeners each time", () => {
  const heard = vi.fn();
  const stop = channelTemplates.subscribe(heard);
  const made = channelTemplates.save({
    name: "  Launch ",
    teams: ["t1", "t1"],
    canvas: "# Goal",
  });
  expect(made).toMatchObject({ name: "Launch", teams: ["t1"] });
  expect(channelTemplates.snapshot()).toEqual([made]);
  expect(channelTemplates.snapshot()).toBe(channelTemplates.snapshot());
  channelTemplates.save({ ...made, name: "Ship" });
  expect(channelTemplates.snapshot().map((item) => item.name)).toEqual([
    "Ship",
  ]);
  channelTemplates.remove(made.id);
  expect(channelTemplates.snapshot()).toEqual([]);
  expect(heard).toHaveBeenCalledTimes(3);
  stop();
});

it("rejects an unnamed template, an unknown id and an oversized Canvas", () => {
  expect(() =>
    channelTemplates.save({ name: " ", teams: [], canvas: "" }),
  ).toThrow("Name the template");
  expect(() =>
    channelTemplates.save({ id: "nope", name: "A", teams: [], canvas: "" }),
  ).toThrow("No such template");
  expect(() =>
    channelTemplates.save({
      name: "A",
      teams: [],
      canvas: "x".repeat(24 * 1024 + 1),
    }),
  ).toThrow("Canvas is too large");
  expect(channelTemplates.snapshot()).toEqual([]);
  expect(
    channelTemplates.save({ name: "Blank", teams: [], canvas: " \n " }).canvas,
  ).toBe("");
});

it("reads what another window saved and skips what is not a template", () => {
  channelTemplates.save({ name: "Here", teams: [], canvas: "" });
  localStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify({
      version: 1,
      templates: [
        { id: "x", name: "There", teams: ["t", 3], canvas: "" },
        { id: "y", name: "Broken" },
      ],
    }),
  );
  expect(channelTemplates.snapshot()).toEqual([
    { id: "x", name: "There", teams: ["t"], canvas: "" },
  ]);
});

it("adds each member of its teams once, if it is one of the given agents", () => {
  const teams = [
    { id: "t1", members: ["a", "b"] },
    { id: "t2", members: ["b", "c"] },
  ];
  expect(
    templateAgents(
      { id: "x", name: "X", teams: ["t2", "t1", "gone"], canvas: "" },
      teams,
      new Set(["a", "b"]),
    ),
  ).toEqual(["b", "a"]);
});
