import { expect, it } from "vitest";
import { detailsParts, messageAudience } from "./audience";

const event = (...tags: string[][]) =>
  ({ tags }) as unknown as Parameters<typeof messageAudience>[0];

it("reads agents and details audiences; anything else is for everyone", () => {
  expect(messageAudience(event(["audience", "agents"]))).toBe("agents");
  expect(messageAudience(event(["audience", "details"]))).toBe("details");
  expect(messageAudience(event(["audience", "everyone"]))).toBeUndefined();
  expect(messageAudience(event(["audience", "detail"]))).toBeUndefined();
  expect(messageAudience(event())).toBeUndefined();
});

it("takes a details title from its leading heading", () => {
  expect(detailsParts("# Release notes\n\n- One\n- Two")).toEqual({
    title: "Release notes",
    body: "- One\n- Two",
    start: 17,
  });
  expect(detailsParts("\n## Findings ##\n    indented")).toEqual({
    title: "Findings",
    body: "    indented",
    start: 16,
  });
  expect(detailsParts("# Only a title").body).toBe("");
  for (const content of ["No heading\n\nBody", "#Tag\nBody", "#  \nBody"])
    expect(detailsParts(content)).toEqual({
      title: undefined,
      body: content,
      start: 0,
    });
});
