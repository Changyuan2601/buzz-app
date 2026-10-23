import { expect, it, vi } from "vitest";
import { disableCheckIn, enableCheckIn } from "./checkin";

const agent = { id: "agent-1" };
const community = "wss://community.example";
const signal = new AbortController().signal;
const beekeeper = (result: Record<string, unknown>) => ({
  beekeeper: vi.fn(async () => result),
});

it("turns check-in on in one channel", async () => {
  const agents = beekeeper({ status: "succeeded" });
  await enableCheckIn(agents, agent, community, "channel-1", signal);
  expect(agents.beekeeper).toHaveBeenCalledWith(
    "enable-bestie",
    { agent_id: "agent-1", community_url: community, channel_id: "channel-1" },
    signal,
  );
});
it("turns check-in off", async () => {
  const agents = beekeeper({ status: "succeeded" });
  await disableCheckIn(agents, agent, community, signal);
  expect(agents.beekeeper).toHaveBeenCalledWith(
    "disable-bestie",
    { agent_id: "agent-1", community_url: community },
    signal,
  );
});
it("reports Beekeeper's reason when check-in is not confirmed", async () => {
  const agents = beekeeper({
    status: "failed",
    error_message: "No active Buzz agent",
  });
  await expect(
    enableCheckIn(agents, agent, community, "channel-1", signal),
  ).rejects.toThrow("No active Buzz agent");
  await expect(
    disableCheckIn(agents, agent, community, signal),
  ).rejects.toThrow("No active Buzz agent");
});
it("falls back to a generic reason without one", async () => {
  const agents = beekeeper({ status: "failed" });
  await expect(
    enableCheckIn(agents, agent, community, "channel-1", signal),
  ).rejects.toThrow("could not turn on");
  await expect(
    disableCheckIn(agents, agent, community, signal),
  ).rejects.toThrow("could not turn off");
});
it("refuses an agent without an ID before calling Beekeeper", async () => {
  const agents = beekeeper({ status: "succeeded" });
  await expect(
    enableCheckIn(agents, { id: " " }, community, "channel-1", signal),
  ).rejects.toThrow("Agent ID is unavailable.");
  expect(agents.beekeeper).not.toHaveBeenCalled();
});
