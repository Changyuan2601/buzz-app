import { expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import { eligible } from "./index";

it("offers usage only for an authorized live channel with archive support", () => {
  const viewer = "a".repeat(64);
  const session = { viewer, agentActivity: { archive: {} } } as RelaySession;
  const channel = {
    id: "channel",
    name: "Channel",
    members: [viewer],
  } as ChannelSummary;
  expect(eligible(channel, session)).toBe(true);
  for (const changed of [
    { cached: true },
    { readOnly: true },
    { archived: true },
    { members: [] },
  ] as const)
    expect(eligible({ ...channel, ...changed }, session)).toBe(false);
  expect(eligible(channel, { viewer } as RelaySession)).toBe(false);
});
