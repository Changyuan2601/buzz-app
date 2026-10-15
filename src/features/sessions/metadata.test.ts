import { expect, it } from "vitest";
import {
  SESSION_CHANNEL_DESCRIPTION,
  sessionDescription,
  sessionMetadata,
} from "./metadata";

const parent = "22222222-2222-4222-8222-222222222222";

it("round-trips parent and personal session descriptions", () => {
  expect(sessionDescription()).toBe(SESSION_CHANNEL_DESCRIPTION);
  for (const [parentId, personal, metadata] of [
    [undefined, false, {}],
    [parent, false, { parentId: parent }],
    [undefined, true, { personal: true }],
    [parent, true, { parentId: parent, personal: true }],
  ] as const)
    expect(sessionMetadata(sessionDescription(parentId, personal))).toEqual(
      metadata,
    );
  expect(sessionDescription(undefined, true)).toBe(
    `${SESSION_CHANNEL_DESCRIPTION}\npersonal`,
  );
});

it("rejects session descriptions outside the exact line grammar", () => {
  for (const description of [
    undefined,
    "",
    "Buzz session (notes)",
    `${SESSION_CHANNEL_DESCRIPTION}\n`,
    `${SESSION_CHANNEL_DESCRIPTION}\nparent:`,
    `${SESSION_CHANNEL_DESCRIPTION}\nparent:not-a-uuid`,
    `${SESSION_CHANNEL_DESCRIPTION}\npersonal\nparent:${parent}`,
    `${SESSION_CHANNEL_DESCRIPTION}\npersonal\npersonal`,
    `${SESSION_CHANNEL_DESCRIPTION}\nPersonal`,
    `${SESSION_CHANNEL_DESCRIPTION}\nme`,
    ` ${SESSION_CHANNEL_DESCRIPTION}`,
  ])
    expect(sessionMetadata(description)).toBeUndefined();
});
