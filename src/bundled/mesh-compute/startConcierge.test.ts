// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import legacyPrompt from "./fixtures/concierge-legacy.md?raw";
import currentPrompt from "./BUZZ_CONCIERGE.md?raw";
import { readView } from "../../shared/view-state";
import { readSelectedAssistant } from "../../features/sessions/selected-assistant";
import { startConcierge, ONBOARDING_COMMUNITY } from "./startConcierge";
import { CONCIERGE_PRESET, MESH_TYPE } from "./Concierge";
const viewer = "a".repeat(64),
  pubkey = "b".repeat(64),
  scope = `${ONBOARDING_COMMUNITY}:${viewer}`;
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
function fixture() {
  let agent: Agent | undefined;
  const placements = new Set<string>();
  const session = {
    mePlacement: {
      admit: vi.fn(async () => {}),
      set: vi.fn(async (id: string) => {
        placements.add(id);
      }),
      has: (id: string) => placements.has(id),
      refresh: vi.fn(async () => {}),
    },
    agentChoices: {
      refresh: vi.fn(async () => {}),
      snapshot: () => ({ selectable: agent ? [agent] : [] }),
    },
    workSessions: {
      create: vi.fn(() => "c".repeat(64)),
      delivered: vi.fn(async (_id: string) => {}),
      refresh: vi.fn(async () => {}),
      addAgents: vi.fn(async () => {}),
    },
    messages: { send: vi.fn(() => "d".repeat(64)) },
  };
  let state = {
    status: "ready",
    origin: ONBOARDING_COMMUNITY,
    scope,
    viewer,
    session,
  };
  const relay = { snapshot: () => state } as unknown as RelayData;
  const agents = {
    snapshot: () => ({ status: "ready", agents: agent ? [agent] : [] }),
    create: vi.fn(async (input) => {
      agent = { ...input, pubkey, owner: viewer, place: "here" } as Agent;
      return agent;
    }),
    save: vi.fn(async (_key, change) => {
      agent = { ...agent, ...change } as Agent;
    }),
    find: (key: string) => (agent?.pubkey === key ? agent : undefined),
    relay: () => relay,
  } as unknown as Agents;
  return {
    agents,
    relay,
    session,
    changeCommunity: () => {
      state = { ...state, scope: "other", session: { ...session } };
    },
    setAgent: (value: Agent) => {
      agent = value;
    },
  };
}
it("creates a private Solo conversation, confirms admission, sends one genuine welcome seed and resumes without duplicates", async () => {
  const f = fixture();
  const result = await startConcierge(
    f.agents,
    f.relay,
    new AbortController().signal,
  );
  expect(f.agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: MESH_TYPE,
      config: expect.objectContaining({
        mode: "chat",
        preset: CONCIERGE_PRESET,
      }),
    }),
  );
  expect(f.session.workSessions.create).toHaveBeenCalledExactlyOnceWith(
    result.channelId,
    "Welcome to Buzz",
    undefined,
    true,
  );
  expect(f.session.mePlacement.has(result.channelId)).toBe(true);
  expect(f.session.workSessions.addAgents).toHaveBeenCalledWith(
    result.channelId,
    [pubkey],
    expect.any(Function),
  );
  expect(f.session.messages.send).toHaveBeenCalledExactlyOnceWith(
    result.channelId,
    "Help me name you and connect you to my preferred AI.",
    [pubkey],
  );
  expect(readSelectedAssistant(scope, result.channelId)).toBe(pubkey);
  expect(
    await startConcierge(f.agents, f.relay, new AbortController().signal),
  ).toEqual(result);
  expect(f.agents.create).toHaveBeenCalledTimes(1);
  expect(f.session.workSessions.create).toHaveBeenCalledTimes(1);
  expect(f.session.messages.send).toHaveBeenCalledTimes(1);
});
it("reuses an existing Concierge but saves the updated guide and tool-free config before admission", async () => {
  const f = fixture();
  f.setAgent({
    pubkey,
    owner: viewer,
    type: MESH_TYPE,
    place: "here",
    config: { preset: CONCIERGE_PRESET, mode: "agent", prompt: "old" },
  } as Agent);
  await startConcierge(f.agents, f.relay, new AbortController().signal);
  expect(f.agents.create).not.toHaveBeenCalled();
  expect(f.agents.find(pubkey)?.config).toMatchObject({
    mode: "chat",
    scope: "channel",
    prompt: expect.stringContaining("Solo conversation"),
  });
});
it("keeps a lost identity outcome paused across restarts", async () => {
  const f = fixture();
  vi.mocked(f.agents.create).mockRejectedValueOnce(
    new Error("Keychain interrupted"),
  );
  await expect(
    startConcierge(f.agents, f.relay, new AbortController().signal),
  ).rejects.toThrow("Keychain interrupted");
  await expect(
    startConcierge(f.agents, f.relay, new AbortController().signal),
  ).rejects.toThrow("unfinished");
  expect(f.agents.create).toHaveBeenCalledTimes(1);
  expect(f.session.workSessions.create).not.toHaveBeenCalled();
});
it("reuses the same channel and welcome after an unconfirmed send", async () => {
  const f = fixture();
  f.session.workSessions.delivered.mockImplementation(async (id) => {
    if (id === "d".repeat(64)) throw new Error("Lost acknowledgement");
  });
  await expect(
    startConcierge(f.agents, f.relay, new AbortController().signal),
  ).rejects.toThrow("Lost acknowledgement");
  expect(readView(scope, "concierge:pending", {})).toMatchObject({
    messageId: "d".repeat(64),
  });
  f.session.workSessions.delivered.mockResolvedValue(undefined);
  await startConcierge(f.agents, f.relay, new AbortController().signal);
  expect(f.session.messages.send).toHaveBeenCalledTimes(1);
  expect(f.session.workSessions.create).toHaveBeenCalledTimes(1);
});
it("stops before channel creation when identity settings cannot persist or the connection changes", async () => {
  for (const failure of ["storage", "community"] as const) {
    localStorage.clear();
    const f = fixture();
    vi.mocked(f.agents.save).mockImplementationOnce(async () => {
      if (failure === "community") f.changeCommunity();
      else throw new Error("Storage unavailable");
    });
    await expect(
      startConcierge(f.agents, f.relay, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.session.workSessions.create).not.toHaveBeenCalled();
    expect(f.session.messages.send).not.toHaveBeenCalled();
  }
});

it("coalesces concurrent starts even when Concierge already exists", async () => {
  const f = fixture();
  f.setAgent({
    pubkey,
    owner: viewer,
    type: MESH_TYPE,
    place: "here",
    config: { preset: CONCIERGE_PRESET, mode: "chat" },
  } as Agent);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const save = vi.mocked(f.agents.save).getMockImplementation();
  if (!save) throw new Error("Missing save fixture");
  vi.mocked(f.agents.save).mockImplementationOnce(async (key, change) => {
    entered();
    await gate;
    await save(key, change);
  });
  const first = startConcierge(f.agents, f.relay, new AbortController().signal);
  await started;
  const second = startConcierge(
    f.agents,
    f.relay,
    new AbortController().signal,
  );
  try {
    expect(second).toBe(first);
    expect(f.session.workSessions.create).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await Promise.all([first, second]);
  expect(f.session.workSessions.create).toHaveBeenCalledTimes(1);
  expect(f.session.messages.send).toHaveBeenCalledTimes(1);
});

it("reopens a renamed and retyped agent without resetting its harness, instructions or selection", async () => {
  const f = fixture();
  const result = await startConcierge(
    f.agents,
    f.relay,
    new AbortController().signal,
  );
  const live = f.agents.find(pubkey);
  if (!live) throw new Error("Missing Concierge fixture");
  f.setAgent({
    ...live,
    name: "Milo",
    type: "buzz.codex/codex",
    config: { instructions: "My personal assistant", model: "chosen" },
  });
  vi.mocked(f.agents.save).mockClear();
  expect(
    await startConcierge(f.agents, f.relay, new AbortController().signal),
  ).toEqual(result);
  expect(f.agents.find(pubkey)).toMatchObject({
    name: "Milo",
    type: "buzz.codex/codex",
    config: { instructions: "My personal assistant", model: "chosen" },
  });
  expect(f.agents.save).not.toHaveBeenCalled();
  expect(f.session.messages.send).toHaveBeenCalledTimes(1);
  expect(f.agents.create).toHaveBeenCalledTimes(1);
});

it("upgrades only an exact shipped legacy guide when reopening an established chat", async () => {
  const f = fixture();
  await startConcierge(f.agents, f.relay, new AbortController().signal);
  const live = f.agents.find(pubkey);
  if (!live) throw new Error("Missing fixture");
  f.setAgent({
    ...live,
    config: { preset: CONCIERGE_PRESET, mode: "chat", prompt: legacyPrompt },
  });
  await startConcierge(f.agents, f.relay, new AbortController().signal);
  expect(f.agents.find(pubkey)?.config).toMatchObject({
    prompt: currentPrompt,
  });
  f.setAgent({
    ...live,
    config: {
      preset: CONCIERGE_PRESET,
      mode: "chat",
      prompt: "My custom concierge guide",
    },
  });
  vi.mocked(f.agents.save).mockClear();
  await startConcierge(f.agents, f.relay, new AbortController().signal);
  expect(f.agents.save).not.toHaveBeenCalled();
});
it("loads persisted Solo placement after restart and distinguishes genuine absence or a read failure", async () => {
  const f = fixture();
  const result = await startConcierge(
    f.agents,
    f.relay,
    new AbortController().signal,
  );
  let loaded = false;
  vi.spyOn(f.session.mePlacement, "has").mockImplementation(() => loaded);
  f.session.mePlacement.refresh.mockImplementation(async () => {
    loaded = true;
  });
  expect(
    await startConcierge(f.agents, f.relay, new AbortController().signal),
  ).toEqual(result);
  loaded = false;
  f.session.mePlacement.refresh.mockResolvedValue(undefined);
  await expect(
    startConcierge(f.agents, f.relay, new AbortController().signal),
  ).rejects.toThrow("moved out of Solo");
  f.session.mePlacement.refresh.mockRejectedValue(
    new Error("Placement read failed"),
  );
  await expect(
    startConcierge(f.agents, f.relay, new AbortController().signal),
  ).rejects.toThrow("Placement read failed");
  expect(f.agents.create).toHaveBeenCalledTimes(1);
});
