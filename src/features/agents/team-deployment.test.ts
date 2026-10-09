import { expect, it, vi } from "vitest";
import type { TeamSnapshot } from "./team-bundles";
import type { AgentView, AgentControl } from "./control";
import type { RelaySession } from "../relay/session";
import { addChannelMember, startAddedAgent } from "../channel-members/members";
import { deployTeam, teamDeployment } from "./team-deployment";
vi.mock("../channel-members/members", () => ({
  addChannelMember: vi.fn(),
  startAddedAgent: vi.fn(),
}));
it("retries every saved member using the exact imported pubkeys without creating identities", async () => {
  const keys = ["a".repeat(64), "b".repeat(64)];
  const create = vi.fn();
  const control = {
    create,
    refresh: vi.fn(),
    snapshot: () => ({ data: { agents: [] } }),
  } as unknown as AgentControl;
  const session = {
    viewer: "b".repeat(64),
    scope: `https://relay.example:${"b".repeat(64)}`,
  } as RelaySession;
  const attempt = teamDeployment(
    { type: "team", id: "team", name: "Saved", agents: keys },
    "channel",
  );
  const signal = new AbortController().signal;
  vi.mocked(addChannelMember).mockRejectedValueOnce(
    new Error("first addition failed"),
  );
  await expect(deployTeam(control, session, attempt, signal)).rejects.toThrow(
    "first addition failed",
  );
  expect(addChannelMember).toHaveBeenCalledTimes(2);
  expect(startAddedAgent).toHaveBeenCalledExactlyOnceWith(
    control,
    session,
    "channel",
    keys[1],
    signal,
    true,
  );
  vi.mocked(addChannelMember).mockClear();
  vi.mocked(startAddedAgent).mockClear();
  await deployTeam(control, session, attempt, signal);
  for (const [index, pubkey] of keys.entries()) {
    expect(addChannelMember).toHaveBeenNthCalledWith(
      index + 1,
      session,
      "channel",
      pubkey,
      signal,
      attempt.additions[index],
    );
    expect(startAddedAgent).toHaveBeenNthCalledWith(
      index + 1,
      control,
      session,
      "channel",
      pubkey,
      signal,
      true,
    );
  }
  expect(create).not.toHaveBeenCalled();
});

it("applies shared instructions separately and restarts an existing copy when its revision changes", async () => {
  vi.mocked(addChannelMember).mockClear();
  vi.mocked(startAddedAgent).mockClear();
  const agent = {
    id: "saved-copy",
    pubkey: "a".repeat(64),
    revision: 2,
    runningRevision: 1,
    status: "running",
    systemPrompt: "INDIVIDUAL",
    relayUrl: "wss://relay.example",
  } as AgentView;
  const applyTeamInstructions = vi.fn(async () => ({ agents: [agent] }));
  const action = vi.fn(async () => ({
    agents: [{ ...agent, runningRevision: 2 }],
  }));
  const create = vi.fn();
  const control = {
    create,
    refresh: vi.fn(),
    snapshot: () => ({ data: { agents: [agent] } }),
    applyTeamInstructions,
    action,
  } as unknown as AgentControl;
  const session = {
    viewer: "b".repeat(64),
    scope: `https://relay.example:${"b".repeat(64)}`,
  } as RelaySession;
  const attempt = teamDeployment(
    { type: "team", id: "team", name: "Saved", agents: [agent.pubkey] },
    "channel",
  );
  const snapshot = {
    team: { name: "Saved", instructions: "TEAM" },
  } as TeamSnapshot;
  await deployTeam(
    control,
    session,
    attempt,
    new AbortController().signal,
    snapshot,
  );
  expect(applyTeamInstructions).toHaveBeenCalledExactlyOnceWith(
    agent.id,
    2,
    "TEAM",
    "team",
    "https://relay.example",
  );
  expect(action).toHaveBeenCalledExactlyOnceWith(agent.id, "restart");
  expect(create).not.toHaveBeenCalled();
  expect(agent.systemPrompt).toBe("INDIVIDUAL");
});

it.each([false, true])(
  "only mutates the deployment community regardless of inventory order (%s)",
  async (reverse) => {
    vi.mocked(addChannelMember).mockClear();
    vi.mocked(startAddedAgent).mockClear();
    const pubkey = "a".repeat(64);
    const local = {
      id: "local",
      pubkey,
      relayUrl: "wss://relay.example",
      revision: 1,
      status: "stopped",
    } as AgentView;
    const foreign = {
      ...local,
      id: "foreign",
      relayUrl: "wss://foreign.example",
    };
    const agents = reverse ? [local, foreign] : [foreign, local];
    const applyTeamInstructions = vi.fn(async () => ({ agents }));
    const action = vi.fn();
    const control = {
      refresh: vi.fn(),
      snapshot: () => ({ data: { agents } }),
      applyTeamInstructions,
      action,
    } as unknown as AgentControl;
    const session = {
      viewer: "b".repeat(64),
      scope: `https://relay.example:${"b".repeat(64)}`,
    } as RelaySession;
    const attempt = teamDeployment(
      { type: "team", id: "team", name: "Saved", agents: [pubkey] },
      "channel",
    );
    await deployTeam(control, session, attempt, new AbortController().signal, {
      team: { name: "Saved", instructions: "TEAM" },
    } as TeamSnapshot);
    expect(applyTeamInstructions).toHaveBeenCalledExactlyOnceWith(
      "local",
      1,
      "TEAM",
      "team",
      "https://relay.example",
    );
    expect(action).not.toHaveBeenCalled();
  },
);
it("refuses portable deployment when only a foreign-community record exists", async () => {
  vi.mocked(addChannelMember).mockClear();
  vi.mocked(startAddedAgent).mockClear();
  const pubkey = "a".repeat(64);
  const applyTeamInstructions = vi.fn();
  const action = vi.fn();
  const control = {
    refresh: vi.fn(),
    snapshot: () => ({
      data: {
        agents: [{ id: "foreign", pubkey, relayUrl: "wss://foreign.example" }],
      },
    }),
    applyTeamInstructions,
    action,
  } as unknown as AgentControl;
  const session = {
    viewer: "b".repeat(64),
    scope: `https://relay.example:${"b".repeat(64)}`,
  } as RelaySession;
  await expect(
    deployTeam(
      control,
      session,
      teamDeployment(
        { type: "team", id: "team", name: "Saved", agents: [pubkey] },
        "channel",
      ),
      new AbortController().signal,
      { team: { name: "Saved", instructions: "TEAM" } } as TeamSnapshot,
    ),
  ).rejects.toThrow("unavailable locally");
  expect(applyTeamInstructions).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
  expect(addChannelMember).not.toHaveBeenCalled();
});
