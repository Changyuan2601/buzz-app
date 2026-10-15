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
import { meshAgentConfig } from "./meshAgent";

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
        scope: "thread",
        prompt: draft.instructions,
        onboardingSource: message.id,
      }),
    }),
  );
  expect(f.add).toHaveBeenCalledExactlyOnceWith(message.channelId, created);
  expect(f.agents.find(author)?.attentionEnabled).toBe(false);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Idea Buddy is ready",
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
