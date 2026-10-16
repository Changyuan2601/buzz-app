import { expect, it } from "vitest";
import {
  SESSION_CHANNEL_DESCRIPTION,
  sessionDescription,
  sessionMetadata,
  SESSION_NAMED_LABEL,
  sessionLinkName,
} from "./metadata";

const parent = "22222222-2222-4222-8222-222222222222";

it("shares IDs until a chosen name is recorded, never an automatic first prompt", () => {
  const channel = { id: parent, name: "Private first prompt" };
  expect(sessionLinkName(channel)).toBe("22222222");
  expect(sessionLinkName({ ...channel, labels: ["work"] })).toBe("22222222");
  expect(
    sessionLinkName({
      ...channel,
      name: "PR 45 fixes",
      labels: [SESSION_NAMED_LABEL],
    }),
  ).toBe("PR 45 fixes");
});

it("retains the exact legacy marker, parent and personal grammar", () => {
  expect(sessionMetadata(sessionDescription())).toEqual({});
  expect(sessionMetadata(sessionDescription(parent))).toEqual({
    parentId: parent,
  });
  expect(sessionMetadata(sessionDescription(undefined, true))).toEqual({
    personal: true,
  });
  expect(sessionMetadata(sessionDescription(parent, true))).toEqual({
    parentId: parent,
    personal: true,
  });
  expect(sessionDescription(undefined, true)).toBe(
    `${SESSION_CHANNEL_DESCRIPTION}\npersonal`,
  );
});

it.each([
  '{"automatic":"First prompt","explicit":true}',
  '{"automatic":"First prompt","explicit":false}',
  '{"explicit":true}',
  '{"explicit":false}',
  '{"automatic":"","explicit":false}',
  '{"automatic":null,"explicit":true}',
  '{"automatic":"#name","explicit":true}',
  '{"automatic":"name ","explicit":false}',
  '{"automatic":"name","explicit":"true"}',
  '{"automatic":"name","explicit":true,"extra":1}',
  '{"explicit":true,"automatic":"name"}',
  '{"automatic":"name","automatic":"name","explicit":true}',
  JSON.stringify({ automatic: "a".repeat(81), explicit: true }),
])(
  "rejects deferred naming extensions, including malformed evidence %s",
  (json) => {
    expect(
      sessionMetadata(`${sessionDescription()}\nnaming:${json}`),
    ).toBeUndefined();
  },
);

it("rejects extra lines and malformed ancestry without changing legacy recognition", () => {
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
  expect(
    sessionMetadata(`${sessionDescription()}\nnaming:{"explicit":true}\nextra`),
  ).toBeUndefined();
});
