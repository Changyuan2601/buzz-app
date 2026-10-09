import { expect, it } from "vitest";
import { activityTarget, activitySelection } from "./activity-target";
const agent = "a".repeat(64);
const root = "c".repeat(64);
it("round-trips an exact agent, optional channel and optional thread", () => {
  expect(activitySelection(activityTarget(agent))).toEqual({ agent });
  expect(activitySelection(activityTarget(agent, "a/b & c"))).toEqual({
    agent,
    channelId: "a/b & c",
  });
  expect(activitySelection(activityTarget(agent, "alpha", root))).toEqual({
    agent,
    channelId: "alpha",
    threadRootId: root,
  });
  // A thread without its channel is not encoded.
  expect(activitySelection(activityTarget(agent, undefined, root))).toEqual({
    agent,
  });
});
it("rejects other targets, ambiguous keys and malformed selection", () => {
  for (const target of [
    "",
    "nostr:npub1abc",
    activityTarget("Carl", "alpha"),
    `${activityTarget(agent)}&agent=${agent}`,
    `${activityTarget(agent)}&channel=`,
    `${activityTarget(agent)}&channel=a&channel=b`,
    `${activityTarget(agent)}#fragment`,
    `${activityTarget(agent)}&thread=one`,
    `${activityTarget(agent)}&thread=${root}`,
    `${activityTarget(agent, "alpha")}&thread=${root.slice(1)}`,
    `${activityTarget(agent, "alpha", root)}&thread=${root}`,
    activityTarget(agent, "x".repeat(257)),
  ])
    expect(activitySelection(target)).toBeUndefined();
});
