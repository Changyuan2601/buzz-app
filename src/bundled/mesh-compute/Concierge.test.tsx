// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type {
  ChannelMessage,
  ChannelSummary,
} from "../../features/relay/contracts";
import {
  conciergeSetup,
  conciergeConnection,
  conciergeDraft,
  ConciergeDraft,
  MESH_TYPE,
  CONCIERGE_PRESET,
} from "./Concierge";
import { DEFAULT_MESH_AGENT_CONFIG } from "./meshAgent";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
const owner = "a".repeat(64),
  author = "b".repeat(64);
const rename = { action: "rename", name: "Milo" };
const connect = {
  action: "connect",
  instructions: "Help brainstorm MUD game ideas.",
  test: "Suggest three mechanics.",
  harness: "buzz.codex/codex",
};
const block = (value: unknown) =>
  `Review this step.\n\n\`\`\`buzz-agent\n${JSON.stringify(value)}\n\`\`\``;
const message = (draft: unknown = connect) =>
  ({
    id: "d".repeat(64),
    authorId: author,
    channelId: "onboarding",
    content: block(draft),
    mentions: [],
    attachments: [],
    createdAt: 1,
    reactions: [],
  }) as unknown as ChannelMessage;
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
    channelType: "session",
    private: true,
    members: [owner, author],
  } as ChannelSummary;
  let channels = { channels: [channel] };
  let agent = {
    pubkey: author,
    name: "Buzz Concierge",
    owner,
    place: "here",
    type: MESH_TYPE,
    attentionEnabled: false,
    config: {
      preset: CONCIERGE_PRESET,
      mode: "chat",
      prompt: "Original guide",
    },
  } as Agent;
  let state = { status: "ready", agents: [agent], running: [], teams: [] };
  let snapshot = {
    status: "ready",
    viewer: owner,
    scope: `https://fixture.example:${owner}`,
    session: {
      viewer: owner,
      channels: { list: () => channels, subscribeList: subscribe },
    },
  } as unknown as RelaySnapshot;
  const relay = { snapshot: () => snapshot, subscribe } as RelayData;
  const update = (change: Partial<Agent>) => {
    agent = { ...agent, ...change };
    state = { ...state, agents: [agent] };
    notify();
  };
  const providerState = { readiness: "ready", blocking: false };
  const codex = {
    key: connect.harness,
    title: "Codex",
    description: "Uses tools in the selected workspace.",
    defaults: () => ({ config: { model: "default", workspace: "~/.buzz" } }),
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
        onClick={() => onChange({ ...config, model: "chosen" })}
      >
        Choose existing model
      </button>
    ),
    provider: {
      snapshot: () => providerState,
      subscribe,
      check: vi.fn(),
      DialogBody: () => <p>Existing provider sign-in</p>,
    },
  } as unknown as RegisteredAgentType;
  const agents = {
    snapshot: () => state,
    subscribe,
    types: () => [
      {
        key: MESH_TYPE,
        title: "Shared Compute",
        defaults: () => ({ config: DEFAULT_MESH_AGENT_CONFIG }),
      },
      codex,
    ],
    create: vi.fn(),
    save: vi.fn(async (_key, change) => update(change)),
    retype: vi.fn(async (_key, type, change) => {
      update({ type, config: change.config });
      return [];
    }),
    find: (key: string) => (key === agent.pubkey ? agent : undefined),
    relay: () => relay,
  } as unknown as Agents;
  const setup = conciergeSetup(agents, relay);
  return {
    agents,
    relay,
    setup,
    update,
    providerState,
    codex,
    notify,
    channel: (change: Partial<ChannelSummary>) => {
      channel = { ...channel, ...change };
      channels = { channels: [channel] };
      notify();
    },
    snapshot: (change: Partial<RelaySnapshot>) => {
      snapshot = { ...snapshot, ...change };
      notify();
    },
    switchCommunity: () => {
      snapshot = {
        ...snapshot,
        scope: "other",
        session: { ...snapshot.session },
      };
      notify();
    },
    mount: (target = message()) =>
      render(
        <ConciergeDraft
          message={target}
          agents={agents}
          relay={relay}
          setup={setup}
        />,
      ),
  };
}
it("accepts bounded self-edits and rejects old creation drafts, extra fields and malformed output", () => {
  expect(conciergeDraft(block(rename))).toEqual(rename);
  expect(conciergeDraft(block(connect))).toEqual(connect);
  for (const value of [
    null,
    [],
    { name: "Child", instructions: "Job", test: "Hello" },
    { ...rename, name: " " },
    { ...rename, tools: ["shell"] },
    { ...rename, name: "bad\u0000name" },
    { ...connect, instructions: "x".repeat(4001) },
    { ...connect, harness: "" },
    { ...connect, test: 7 },
    { ...connect, action: "create" },
  ])
    expect(conciergeDraft(block(value))).toBeUndefined();
  expect(conciergeDraft("```buzz-agent\nnot json\n```")).toBeUndefined();
  expect(conciergeDraft(`${block(rename)}\n${block(connect)}`)).toBeUndefined();
});
it("renames the existing agent only after approval and keeps the onboarding guide and identity", async () => {
  const f = fixture(),
    target = message(rename),
    original = f.agents.find(author);
  const view = f.mount(target);
  expect(f.agents.save).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Use this name" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Name saved: Milo",
  );
  expect(f.agents.save).toHaveBeenCalledExactlyOnceWith(author, {
    name: "Milo",
  });
  expect(f.agents.find(author)).toMatchObject({
    pubkey: original?.pubkey,
    config: original?.config,
    type: MESH_TYPE,
  });
  view.unmount();
  f.mount(target);
  expect(
    screen.queryByRole("button", { name: "Use this name" }),
  ).not.toBeInTheDocument();
  await conciergeSetup(f.agents, f.relay).apply(target);
  expect(f.agents.save).toHaveBeenCalledTimes(1);
  expect(f.agents.create).not.toHaveBeenCalled();
});
it("connects that same identity with registered adoption/model controls, preserving membership and attention", async () => {
  const f = fixture();
  f.update({ name: "Milo" });
  f.mount();
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Choose existing model" }),
  );
  await user.click(screen.getByRole("button", { name: "Connect this agent" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Milo is connected",
  );
  expect(f.agents.retype).toHaveBeenCalledExactlyOnceWith(
    author,
    connect.harness,
    {
      config: {
        model: "chosen",
        workspace: "~/.buzz",
        instructions: connect.instructions,
      },
    },
  );
  expect(f.agents.find(author)).toMatchObject({
    name: "Milo",
    pubkey: author,
    attentionEnabled: false,
  });
  expect(
    f.relay.snapshot().session.channels.list().channels[0]?.members,
  ).toEqual([owner, author]);
  expect(f.agents.create).not.toHaveBeenCalled();
  await conciergeSetup(f.agents, f.relay).apply(message());
  expect(f.agents.retype).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Manage Codex" }));
  expect(await screen.findByText("Existing provider sign-in")).toBeVisible();
});
it("can explicitly remain on tool-free shared compute without creating an agent", async () => {
  const f = fixture();
  await f.setup.apply(message({ ...connect, harness: MESH_TYPE }));
  expect(f.agents.find(author)?.config).toMatchObject({
    mode: "chat",
    scope: "channel",
    prompt: connect.instructions,
  });
  expect(f.agents.retype).not.toHaveBeenCalled();
  expect(f.agents.create).not.toHaveBeenCalled();
});
it("holds pending until the service finishes and coalesces duplicate mounted actions", async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((done) => {
    started = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const original = vi.mocked(f.agents.retype).getMockImplementation();
  if (!original) throw new Error("Missing retype fixture");
  vi.mocked(f.agents.retype).mockImplementationOnce(async (...args) => {
    started();
    await gate;
    return original(...args);
  });
  f.mount();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Connect this agent" }));
  await entered;
  const repeated = f.setup.apply(message());
  try {
    expect(
      screen.getByRole("button", { name: "Connect this agent" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(f.agents.retype).toHaveBeenCalledTimes(1);
    await expect(
      f.setup.apply({ ...message(rename), id: "e".repeat(64) }),
    ).rejects.toThrow("Finish the current");
  } finally {
    await act(async () => {
      release();
      await repeated;
    });
  }
  expect(await screen.findByRole("status")).toHaveTextContent("is connected");
});
it.each(["community", "disposed"])(
  "stops further progress writes after %s changes during a mutation",
  async (change) => {
    const f = fixture();
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((done) => {
      started = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const original = vi.mocked(f.agents.retype).getMockImplementation();
    if (!original) throw new Error("Missing retype fixture");
    vi.mocked(f.agents.retype).mockImplementationOnce(async (...args) => {
      started();
      await gate;
      return original(...args);
    });
    const operation = f.setup.apply(message());
    await entered;
    if (change === "community") f.switchCommunity();
    else f.setup.dispose();
    release();
    await expect(operation).rejects.toThrow("conversation changed");
    expect(f.setup.completed(message())).toBe(false);
  },
);
it.each([
  "author",
  "signer",
  "owner",
  "preset",
  "archived",
  "cached",
  "membership",
  "agent-membership",
  "parent",
  "remote",
])("refuses a self-edit with invalid %s", async (change) => {
  const f = fixture();
  let target = message();
  if (change === "author") target = { ...target, authorId: owner };
  if (change === "signer") target = { ...target, signerId: owner };
  if (change === "owner") f.snapshot({ viewer: "c".repeat(64) });
  if (change === "preset") f.update({ config: {} });
  if (change === "archived") f.channel({ archived: true });
  if (change === "cached") f.snapshot({ cached: true });
  if (change === "membership") f.channel({ members: [author] });
  if (change === "agent-membership") f.channel({ members: [owner] });
  if (change === "parent") f.channel({ parentChannelId: "parent" });
  if (change === "remote") f.update({ place: "elsewhere" as Agent["place"] });
  expect(f.setup.available(target)).toBe(false);
  await expect(f.setup.apply(target)).rejects.toThrow();
  expect(f.agents.retype).not.toHaveBeenCalled();
  expect(f.agents.save).not.toHaveBeenCalled();
});
it.each(["attention", "blocking"])(
  "keeps setup in the existing provider dialog and refuses connection while %s",
  async (reason) => {
    const f = fixture();
    if (reason === "attention") f.providerState.readiness = "attention";
    else f.providerState.blocking = true;
    f.mount();
    const user = userEvent.setup();
    expect(
      screen.getByRole("button", { name: "Connect this agent" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: /(?:Set up|Manage) Codex/ }),
    );
    expect(await screen.findByText("Existing provider sign-in")).toBeVisible();
    await expect(f.setup.apply(message())).rejects.toThrow(
      "Finish Codex setup",
    );
    expect(f.agents.retype).not.toHaveBeenCalled();
  },
);
it("does not silently substitute Shared Compute for an unavailable harness", async () => {
  const f = fixture(),
    target = message({ ...connect, harness: "pi/not-installed" });
  f.mount(target);
  expect(
    screen.getByRole("button", { name: "Connect this agent" }),
  ).toBeDisabled();
  await expect(f.setup.apply(target)).rejects.toThrow(
    "available local harness",
  );
  expect(f.agents.save).not.toHaveBeenCalled();
});
it("leaves the original guide intact when retyping fails and can retry the reviewed configuration", async () => {
  const f = fixture();
  vi.mocked(f.agents.retype).mockRejectedValueOnce(
    new Error("Agent is still running"),
  );
  await expect(f.setup.apply(message())).rejects.toThrow("still running");
  expect(f.agents.find(author)?.type).toBe(MESH_TYPE);
  await conciergeSetup(f.agents, f.relay).apply(message());
  expect(f.agents.find(author)?.type).toBe(connect.harness);
});
it("does not mutate anything if the initial progress write fails", async () => {
  const f = fixture();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Full");
  });
  await expect(f.setup.apply(message())).rejects.toThrow(
    "progress could not be saved",
  );
  expect(f.agents.retype).not.toHaveBeenCalled();
});
it("recovers a failed completion receipt without overwriting later edits or retyping twice", async () => {
  const f = fixture(),
    set = Storage.prototype.setItem;
  let writes = 0;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (++writes === 2) throw new Error("Full");
    set.call(this, key, value);
  });
  await expect(f.setup.apply(message())).rejects.toThrow(
    "progress could not be saved",
  );
  await conciergeSetup(f.agents, f.relay).apply(message());
  expect(f.agents.retype).toHaveBeenCalledTimes(1);
  f.update({ config: { instructions: "My later edits" } });
  await conciergeSetup(f.agents, f.relay).apply(message());
  expect(f.agents.find(author)?.config).toEqual({
    instructions: "My later edits",
  });
  expect(f.agents.retype).toHaveBeenCalledTimes(1);
});
it("preserves edits after a failed mutation and checks the persisted target provider on retry", async () => {
  const f = fixture();
  vi.mocked(f.agents.retype).mockRejectedValueOnce(new Error("Try later"));
  await expect(f.setup.apply(message())).rejects.toThrow("Try later");
  f.providerState.blocking = true;
  await expect(
    conciergeSetup(f.agents, f.relay).apply(message(), {
      type: MESH_TYPE,
      config: {},
    }),
  ).rejects.toThrow("Finish Codex setup");
  f.providerState.blocking = false;
  f.update({ config: { prompt: "Edited guide" } });
  await expect(
    conciergeSetup(f.agents, f.relay).apply(message()),
  ).rejects.toThrow("settings changed");
  expect(f.agents.retype).toHaveBeenCalledTimes(1);
});

it("shows concrete choices immediately after naming; choosing opens setup and successful completion connects the same agent", async () => {
  const f = fixture(),
    target = message(rename);
  if (!f.codex.provider) throw new Error("Missing provider fixture");
  Object.assign(f.codex.provider, {
    DialogBody: ({
      onClose,
      onComplete,
    }: {
      onClose(): void;
      onComplete?: () => void;
    }) => (
      <div>
        <p>Account setup</p>
        <button type="button" onClick={onClose}>
          Cancel setup
        </button>
        <button type="button" onClick={onComplete}>
          Finish setup
        </button>
      </div>
    ),
  });
  const view = f.mount(target);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Use this name" }));
  expect(await screen.findByRole("button", { name: "Codex" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Shared Compute" })).toBeVisible();
  expect(screen.queryByText(/buzz.codex/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Codex" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("Account setup");
  expect(f.agents.retype).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Finish setup" }));
  await screen.findByText(/Milo is connected/);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(f.agents.retype).toHaveBeenCalledExactlyOnceWith(
    author,
    connect.harness,
    {
      config: expect.objectContaining({
        model: "default",
        workspace: "~/.buzz",
      }),
    },
  );
  expect(f.agents.find(author)?.name).toBe("Milo");
  expect(f.agents.create).not.toHaveBeenCalled();
  view.unmount();
  f.mount(target);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Manage Codex" })).toBeVisible();
  expect(f.setup.completed(conciergeConnection(target, connect.harness))).toBe(
    true,
  );
});
it("returns from cancelled setup without switching the agent", async () => {
  const f = fixture(),
    target = message(rename);
  if (!f.codex.provider) throw new Error("Missing provider fixture");
  Object.assign(f.codex.provider, {
    DialogBody: ({ onClose }: { onClose(): void }) => (
      <button type="button" onClick={onClose}>
        Cancel setup
      </button>
    ),
  });
  await f.setup.apply(target);
  f.mount(target);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Codex" }));
  await user.click(await screen.findByRole("button", { name: "Cancel setup" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Manage Codex" })).toHaveFocus();
  expect(f.agents.retype).not.toHaveBeenCalled();
  expect(f.agents.find(author)?.type).toBe(MESH_TYPE);
  await user.click(screen.getByRole("button", { name: "Codex" }));
  expect(await screen.findByRole("dialog")).toBeVisible();
  expect(f.agents.retype).not.toHaveBeenCalled();
});
