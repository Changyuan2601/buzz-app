// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type {
  ChannelMessage,
  ChannelSummary,
} from "../../features/relay/contracts";
import {
  conciergeCreation,
  conciergeDraft,
  ConciergeDraft,
  MESH_TYPE,
  CONCIERGE_PRESET,
} from "./Concierge";
import { meshAgentConfig, DEFAULT_MESH_AGENT_CONFIG } from "./meshAgent";

afterEach(cleanup);
const owner = "a".repeat(64),
  author = "b".repeat(64),
  created = "c".repeat(64);
const draft = {
  name: "Idea Buddy",
  instructions: "Offer three concise community event ideas.",
  test: "Suggest an event for next month.",
};
const block = (value: unknown) =>
  `Review this draft.\n\n\`\`\`buzz-agent\n${JSON.stringify(value)}\n\`\`\``;
const message = {
  id: "d".repeat(64),
  authorId: author,
  channelId: "onboarding",
  content: block(draft),
  mentions: [],
  attachments: [],
  createdAt: 1,
  reactions: [],
} as unknown as ChannelMessage;
function fixture() {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  let channel = {
    id: "onboarding",
    name: "onboarding",
    channelType: "stream",
    members: [owner, author],
  } as ChannelSummary;
  let channels = { channels: [channel] };
  const concierge = {
    pubkey: author,
    owner,
    place: "here",
    type: MESH_TYPE,
    config: { preset: CONCIERGE_PRESET, mode: "chat" },
  } as Agent;
  let state = { status: "ready", agents: [concierge], running: [], teams: [] };
  const add = vi.fn(async (_channel: string, pubkey: string) => {
    channel = { ...channel, members: [...(channel.members ?? []), pubkey] };
    channels = { channels: [channel] };
    notify();
  });
  let snapshot = {
    status: "ready",
    viewer: owner,
    scope: `https://fixture.example:${owner}`,
    session: {
      viewer: owner,
      outbox: { supports: () => true },
      channels: { list: () => channels, subscribeList: subscribe },
      memberAdditions: { add },
    },
  } as unknown as RelaySnapshot;
  const relay = { snapshot: () => snapshot, subscribe } as RelayData;
  const create = vi.fn(async (input) => {
    const agent = { ...input, pubkey: created, owner, place: "here" } as Agent;
    state = { ...state, agents: [...state.agents, agent] };
    notify();
    return agent;
  });
  const agents = {
    snapshot: () => state,
    subscribe,
    types: () => [
      {
        key: MESH_TYPE,
        title: "Shared Compute",
        defaults: () => ({ config: DEFAULT_MESH_AGENT_CONFIG }),
      },
    ],
    create,
    save: vi.fn(async (pubkey, change) => {
      state = {
        ...state,
        agents: state.agents.map((agent) =>
          agent.pubkey === pubkey ? { ...agent, ...change } : agent,
        ),
      };
      notify();
    }),
    find: (key: string) => state.agents.find((a) => a.pubkey === key),
    relay: () => relay,
  } as unknown as Agents;
  const creation = conciergeCreation(agents, relay);
  return {
    agents,
    relay,
    creation,
    create,
    add,
    concierge,
    switchCommunity: () => {
      snapshot = {
        ...snapshot,
        scope: `https://other.example:${owner}`,
        session: { ...snapshot.session },
      };
      notify();
    },
    channel: (change: Partial<ChannelSummary>) => {
      channel = { ...channel, ...change };
      channels = { channels: [channel] };
      notify();
    },
    snapshot: (change: Partial<RelaySnapshot>) => {
      snapshot = { ...snapshot, ...change };
      notify();
    },
    mount: () =>
      render(
        <ConciergeDraft
          message={message}
          agents={agents}
          relay={relay}
          creation={creation}
        />,
      ),
  };
}
it("accepts one bounded proposal and rejects executable settings, invalid JSON and multiple drafts", () => {
  expect(conciergeDraft(message.content)).toEqual(draft);
  for (const value of [
    null,
    [],
    { ...draft, tools: ["shell"] },
    { ...draft, name: " " },
    { ...draft, instructions: "x".repeat(4001) },
    { ...draft, test: 7 },
    { ...draft, name: "bad\u0000name" },
  ])
    expect(conciergeDraft(block(value))).toBeUndefined();
  expect(conciergeDraft("```buzz-agent\nnot json\n```")).toBeUndefined();
  expect(
    conciergeDraft(`${message.content}\n${message.content}`),
  ).toBeUndefined();
});
it("requires a click, creates a tool-free agent, confirms membership, and survives remount without duplicates", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = f.mount();
  expect(f.create).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(f.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: MESH_TYPE,
      name: draft.name,
      config: expect.objectContaining({
        mode: "chat",
        scope: "channel",
        prompt: draft.instructions,
        onboardingSource: message.id,
      }),
    }),
  );
  expect(f.add).toHaveBeenCalledExactlyOnceWith(message.channelId, created);
  expect(f.agents.find(author)?.attentionEnabled).toBe(false);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Idea Buddy has been created",
  );
  view.unmount();
  f.mount();
  expect(
    screen.queryByRole("button", { name: "Create agent" }),
  ).not.toBeInTheDocument();
  const reloaded = conciergeCreation(f.agents, f.relay);
  await reloaded.create(message);
  expect(f.create).toHaveBeenCalledTimes(1);
});
it("coalesces concurrent views while creation is explicitly held", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const original = f.create.getMockImplementation();
  if (!original) throw new Error("Missing creation fixture");
  f.create.mockImplementationOnce(async (input) => {
    await gate;
    return original(input);
  });
  const first = f.creation.create(message),
    second = f.creation.create(message);
  try {
    expect(first).toBe(second);
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
    expect(f.add).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await first;
  expect(f.add).toHaveBeenCalledTimes(1);
});
it("retries membership with the already created agent, including after renderer recreation", async () => {
  const f = fixture();
  f.add.mockRejectedValueOnce(new Error("Membership not confirmed"));
  await expect(f.creation.create(message)).rejects.toThrow(
    "Membership not confirmed",
  );
  await conciergeCreation(f.agents, f.relay).create(message);
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.add).toHaveBeenCalledTimes(2);
});
it("keeps pending state until completion and pauses uncertain creation instead of duplicating it", async () => {
  const f = fixture(),
    user = userEvent.setup();
  let reject!: (error: Error) => void;
  f.create.mockImplementationOnce(
    () =>
      new Promise<Agent>((_done, fail) => {
        reject = fail;
      }),
  );
  f.mount();
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  try {
    expect(
      screen.getByRole("button", { name: "Create agent" }),
    ).toHaveAttribute("aria-busy", "true");
  } finally {
    await act(async () => {
      reject(new Error("Compute setup unavailable"));
    });
  }
  expect(
    await screen.findByText("Compute setup unavailable"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/draft is paused to prevent another copy/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Create agent" }),
  ).not.toBeInTheDocument();
});
it.each(["community", "disposed"])(
  "does not continue writes after %s changes while creation runs",
  async (change) => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const original = f.create.getMockImplementation();
    if (!original) throw new Error("Missing creation fixture");
    f.create.mockImplementationOnce(async (input) => {
      await gate;
      return original(input);
    });
    const operation = f.creation.create(message);
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
    if (change === "community") f.switchCommunity();
    else f.creation.dispose();
    release();
    await expect(operation).rejects.toThrow("conversation changed");
    expect(f.add).not.toHaveBeenCalled();
  },
);
it("refuses foreign authors, signers and owners, archived channels, cached state and revoked membership", async () => {
  for (const change of [
    "author",
    "signer",
    "owner",
    "preset",
    "archived",
    "cached",
    "membership",
  ] as const) {
    const f = fixture();
    let target = message;
    if (change === "author") target = { ...message, authorId: owner };
    if (change === "signer") target = { ...message, signerId: owner };
    if (change === "owner") f.snapshot({ viewer: created });
    if (change === "preset") (f.concierge as { config: unknown }).config = {};
    if (change === "archived") f.channel({ archived: true });
    if (change === "cached") f.snapshot({ cached: true });
    if (change === "membership") f.channel({ members: [author] });
    expect(f.creation.available(target)).toBe(false);
    await expect(f.creation.create(target)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  }
});
it("preserves the creation source through normal Mesh settings normalization", () => {
  expect(
    meshAgentConfig({ onboardingSource: message.id }).onboardingSource,
  ).toBe(message.id);
  expect(
    meshAgentConfig({ onboardingSource: "not-a-message" }).onboardingSource,
  ).toBeUndefined();
});

it("uses the registered harness's adoption and model controls without inventing Pi support", async () => {
  const f = fixture();
  const mesh = f.agents.types()[0];
  if (!mesh) throw new Error("Missing Mesh fixture");
  const codex = {
    key: "buzz.codex/codex",
    title: "Codex",
    defaults: () => ({
      config: { instructions: "default", model: "existing-default" },
    }),
    adopt: (carry: { instructions?: string }, config: object) => ({
      ...config,
      instructions: carry.instructions,
    }),
    CreateModel: ({
      config,
      onChange,
    }: {
      config: { model: string };
      onChange(config: object): void;
    }) => (
      <button
        type="button"
        onClick={() => onChange({ ...config, model: "chosen-model" })}
      >
        Choose existing model
      </button>
    ),
  } as unknown as import("../../features/agents/service").RegisteredAgentType;
  vi.spyOn(f.agents, "types").mockReturnValue([mesh, codex]);
  f.channel({ channelType: "session", private: true });
  const session = f.relay.snapshot().session;
  Object.assign(session, {
    agentChoices: {
      refresh: vi.fn(async () => {}),
      snapshot: () => ({ selectable: [{ pubkey: created }] }),
    },
    workSessions: {
      addAgents: vi.fn(async () => f.add(message.channelId, created)),
    },
    mePlacement: { has: () => true },
  });
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  expect(screen.queryByRole("option", { name: "Pi" })).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option", { name: "Codex" }));
  await user.click(
    screen.getByRole("button", { name: "Choose existing model" }),
  );
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await screen.findByRole("status");
  expect(f.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: codex.key,
      config: { instructions: draft.instructions, model: "chosen-model" },
    }),
  );
  expect(session.workSessions.addAgents).toHaveBeenCalledWith(
    message.channelId,
    [created],
    expect.any(Function),
  );
  expect(f.agents.find(author)?.config).toMatchObject({
    onboardingCreated: { source: message.id, pubkey: created, type: codex.key },
  });
  await conciergeCreation(f.agents, f.relay).create(message);
  expect(f.create).toHaveBeenCalledTimes(1);
  await f.agents.save(created, {
    config: { instructions: "changed", model: "chosen-model" },
  });
  await expect(
    conciergeCreation(f.agents, f.relay).create(message),
  ).rejects.toThrow("settings differ");
});

it("keeps provider setup with the harness and refuses creation while sign-in is needed", async () => {
  const f = fixture();
  const providerState = { readiness: "attention" as const };
  const mesh = f.agents.types()[0];
  if (!mesh) throw new Error("Missing Mesh fixture");
  const type = {
    key: "buzz.claude-code/claude",
    title: "Claude",
    defaults: () => ({ config: {} }),
    adopt: (_carry: unknown, config: unknown) => config,
    provider: {
      snapshot: () => providerState,
      subscribe: () => () => {},
      check: vi.fn(),
      DialogBody: () => <p>Complete Claude sign-in here</p>,
    },
  } as unknown as import("../../features/agents/service").RegisteredAgentType;
  vi.spyOn(f.agents, "types").mockReturnValue([mesh, type]);
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Claude" }));
  expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Set up Claude" }));
  expect(await screen.findByText("Complete Claude sign-in here")).toBeVisible();
  await expect(
    f.creation.create(message, { type: type.key, config: {} }),
  ).rejects.toThrow("Finish Claude setup");
  expect(f.create).not.toHaveBeenCalled();
});

it("keeps local provider setup on the created card without creating another agent", async () => {
  const f = fixture();
  const state = { readiness: "ready" as const, blocking: true };
  const mesh = f.agents.types()[0];
  if (!mesh) throw new Error("Missing Mesh fixture");
  const type = {
    key: "buzz.claude-code/claude",
    title: "Claude",
    defaults: () => ({ config: {} }),
    adopt: (_carry: unknown, config: unknown) => config,
    provider: {
      snapshot: () => state,
      subscribe: () => () => {},
      check: vi.fn(),
      DialogBody: () => <p>Local Claude sign-in</p>,
    },
  } as unknown as import("../../features/agents/service").RegisteredAgentType;
  vi.spyOn(f.agents, "types").mockReturnValue([mesh, type]);
  const view = f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Claude" }));
  expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
  await expect(
    f.creation.create(message, { type: type.key, config: {} }),
  ).rejects.toThrow("Finish Claude setup");
  expect(f.create).not.toHaveBeenCalled();
  state.blocking = false;
  view.rerender(
    <ConciergeDraft
      message={message}
      agents={f.agents}
      relay={f.relay}
      creation={f.creation}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "has been created",
  );
  view.unmount();
  f.mount();
  await user.click(screen.getByRole("button", { name: "Manage Claude" }));
  expect(await screen.findByText("Local Claude sign-in")).toBeVisible();
  expect(f.create).toHaveBeenCalledTimes(1);
});

it("does not overwrite a saved harness edit when Concierge's completion receipt failed", async () => {
  const f = fixture();
  const type = {
    key: "example/coding",
    title: "Coding",
    defaults: () => ({ config: {} }),
    adopt: (_carry: unknown, config: unknown) => config,
  } as unknown as import("../../features/agents/service").RegisteredAgentType;
  vi.spyOn(f.agents, "types").mockReturnValue([type]);
  const originalSave = vi.mocked(f.agents.save).getMockImplementation();
  if (!originalSave) throw new Error("Missing save fixture");
  vi.spyOn(f.agents, "save").mockImplementation(async (pubkey, change) => {
    if (pubkey === author && meshAgentConfig(change.config).onboardingCreated)
      throw new Error("Receipt storage unavailable");
    return originalSave(pubkey, change);
  });
  const config = { instructions: draft.instructions, model: "first" };
  await expect(
    f.creation.create(message, { type: type.key, config }),
  ).rejects.toThrow("Receipt storage unavailable");
  await f.agents.save(created, {
    config: { ...config, model: "person-edited" },
  });
  await expect(
    f.creation.create(message, { type: type.key, config }),
  ).rejects.toThrow("settings differ");
  expect(f.agents.find(created)?.config).toMatchObject({
    model: "person-edited",
  });
  expect(f.add).not.toHaveBeenCalled();
});

it("rechecks reviewed settings after Solo agent-choice refresh before granting conversation access", async () => {
  const f = fixture();
  f.channel({ channelType: "session", private: true });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const addAgents = vi.fn();
  Object.assign(f.relay.snapshot().session, {
    agentChoices: {
      refresh: async () => {
        started();
        await gate;
      },
    },
    workSessions: { addAgents },
  });
  const operation = f.creation.create(message);
  await entered;
  try {
    await f.agents.save(created, {
      config: { mode: "agent", prompt: "Changed by person" },
    });
  } finally {
    release();
  }
  await expect(operation).rejects.toThrow("settings differ");
  expect(addAgents).not.toHaveBeenCalled();
});

it("consumes initial-config repair permission before a later receipt failure", async () => {
  const f = fixture();
  const fallback = { model: "default" };
  const config = { instructions: draft.instructions, model: "chosen" };
  const type = {
    key: "example/coding",
    title: "Coding",
    defaults: () => ({ config: fallback }),
    adopt: (_carry: unknown, next: unknown) => next,
  } as unknown as import("../../features/agents/service").RegisteredAgentType;
  vi.spyOn(f.agents, "types").mockReturnValue([type]);
  const create = f.create.getMockImplementation();
  const save = vi.mocked(f.agents.save).getMockImplementation();
  if (!create || !save) throw new Error("Missing service fixture");
  f.create.mockImplementationOnce(async (input) => {
    const optimistic = await create(input);
    await save(created, { config: fallback });
    return optimistic;
  });
  vi.mocked(f.agents.save).mockImplementation(async (pubkey, change) => {
    if (pubkey === author && meshAgentConfig(change.config).onboardingCreated)
      throw new Error("Receipt failed");
    return save(pubkey, change);
  });
  await expect(
    f.creation.create(message, { type: type.key, config }),
  ).rejects.toThrow("Receipt failed");
  expect(f.agents.find(created)?.config).toEqual(config);
  await f.agents.save(created, { config: fallback });
  await expect(
    f.creation.create(message, { type: type.key, config }),
  ).rejects.toThrow("settings differ");
  expect(f.agents.find(created)?.config).toEqual(fallback);
  expect(f.add).not.toHaveBeenCalled();
});
