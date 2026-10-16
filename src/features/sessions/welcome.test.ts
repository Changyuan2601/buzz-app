// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  prepareWelcome,
  readWelcome,
  saveWelcome,
  observedWelcome,
  saveDefaultAssistant,
  defaultAssistant,
} from "./welcome";
import { readSelectedAssistant } from "./selected-assistant";
import type { Agents, Agent } from "../agents/service";
import { createRelaySession, type RelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import {
  bounds,
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
} from "../relay/testing";

const scope = `https://community.example:${"a".repeat(64)}`;
const agent = "b".repeat(64);
const channel = "11111111-1111-4111-8111-111111111111";
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
function fixture() {
  const created = {
    pubkey: agent,
    type: "claude/claude",
    name: "Welcome",
    owner: "a".repeat(64),
  } as Agent;
  const agents = {
    create: vi.fn(async () => created),
    find: () => created,
  } as unknown as Agents;
  const workSessions = {
    create: vi.fn(() => "c".repeat(64)),
    invite: vi.fn(() => "d".repeat(64)),
    delivered: vi.fn(async (_id: string) => {}),
    refresh: vi.fn(async () => {}),
  };
  const messages = { send: vi.fn() };
  const session = {
    viewer: created.owner,
    workSessions,
    messages,
    mePlacement: { admit: vi.fn(async () => {}), set: vi.fn(async () => {}) },
    agentChoices: {
      refresh: vi.fn(async () => {}),
      snapshot: () => ({ selectable: [{ pubkey: agent }] }),
    },
    read: vi.fn(async () => []),
  } as unknown as RelaySession;
  return { agents, session, workSessions, messages };
}

it("resumes exact agent/channel/invitation after interrupted setup without sending a viewer message", async () => {
  const { agents, session, workSessions, messages } = fixture();
  workSessions.delivered
    .mockImplementationOnce(async () => {})
    .mockRejectedValueOnce(new Error("Invitation unconfirmed"));
  await expect(
    prepareWelcome(
      session,
      agents,
      scope,
      "claude/claude",
      {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("Invitation unconfirmed");
  const pending = readWelcome(scope);
  expect(pending?.agent).toBe(agent);
  expect(pending?.creationId).toBe("c".repeat(64));
  expect(pending?.invitationId).toBe("d".repeat(64));
  workSessions.delivered.mockResolvedValue(undefined);
  const complete = await prepareWelcome(
    session,
    agents,
    scope,
    "claude/claude",
    {},
    new AbortController().signal,
  );
  expect(complete.channelId).toBe(pending?.channelId);
  expect(agents.create).toHaveBeenCalledTimes(1);
  expect(workSessions.create).toHaveBeenCalledTimes(1);
  expect(workSessions.invite).toHaveBeenCalledTimes(1);
  expect(readSelectedAssistant(scope, complete.channelId)).toBe(agent);
  expect(messages.send).not.toHaveBeenCalled();
});

it("does not create another agent after an uncertain native create or a failed durable checkpoint", async () => {
  const { agents, session } = fixture();
  vi.mocked(agents.create).mockRejectedValueOnce(
    new Error("Disconnected during creation"),
  );
  await expect(
    prepareWelcome(
      session,
      agents,
      scope,
      "claude/claude",
      {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("Disconnected");
  await expect(
    prepareWelcome(
      session,
      agents,
      scope,
      "claude/claude",
      {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("may have been created");
  expect(agents.create).toHaveBeenCalledTimes(1);
  localStorage.clear();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  await expect(
    prepareWelcome(
      session,
      agents,
      scope,
      "claude/claude",
      {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("could not be saved");
  expect(agents.create).toHaveBeenCalledTimes(1);
});

it("records the exact created key after view cancellation and resumes without duplicate creation", async () => {
  const { agents, session, workSessions } = fixture();
  let release!: (value: Agent) => void;
  vi.mocked(agents.create).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const operation = prepareWelcome(
    session,
    agents,
    scope,
    "claude/claude",
    {},
    controller.signal,
  );
  const failure = operation.catch((error: unknown) => error);
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalledTimes(1));
  controller.abort();
  release({
    pubkey: agent,
    type: "claude/claude",
    owner: "a".repeat(64),
  } as Agent);
  expect(await failure).toBeDefined();
  expect(readWelcome(scope)?.agent).toBe(agent);
  expect(workSessions.create).not.toHaveBeenCalled();
  await prepareWelcome(
    session,
    agents,
    scope,
    "claude/claude",
    {},
    new AbortController().signal,
  );
  expect(agents.create).toHaveBeenCalledTimes(1);
});

it("keeps the introduction reconciliation read alive while the channel's live route establishes", async () => {
  const viewer = keypair();
  const relay = keypair();
  const assistant = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, prioritize() {}, retry() {}, dispose() {} };
    },
  });
  try {
    live.receive([roster(relay, channel, [viewer.pubkey, assistant.pubkey])]);
    owner.session.channels.ensure(channel);
    wire
      .next()
      .respond([
        bounds(relay, channel, "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    const reply = message(assistant, channel, "Hello", 1_700_000_001);
    const result = observedWelcome(
      owner.session,
      {
        type: "claude/claude",
        channelId: channel,
        agent: assistant.pubkey,
        kickoffAt: 1_700_000_000,
      },
      new AbortController().signal,
    ).then(
      (event) => ({ event, error: undefined }),
      (error: unknown) => ({ event: undefined, error }),
    );
    const checking = wire.next();
    live.state({
      status: "connected",
      routes: [
        { id: "profiles", status: "live", replay: "unknown" },
        { id: "membership", status: "live", replay: "unknown" },
      ],
    });
    live.established(channel);
    await flush();
    expect(checking.signal?.aborted).toBe(false);
    checking.respond([reply]);
    expect(await result).toEqual({ event: reply, error: undefined });
  } finally {
    owner.dispose();
  }
});

it("keeps defaults scoped to account/community and recognizes only post-attempt top-level agent replies", async () => {
  const { session } = fixture();
  saveDefaultAssistant(scope, agent);
  expect(defaultAssistant(scope)).toBe(agent);
  expect(defaultAssistant(`https://other.example:${"a".repeat(64)}`)).toBe("");
  expect(defaultAssistant(`https://community.example:${"c".repeat(64)}`)).toBe(
    "",
  );
  const receipt = {
    type: "claude/claude",
    channelId: channel,
    agent,
    kickoff: "attempted" as const,
    kickoffAt: 100,
  };
  saveWelcome(scope, receipt);
  vi.mocked(session.read).mockResolvedValue([
    {
      id: "1".repeat(64),
      pubkey: agent,
      kind: 9,
      created_at: 99,
      content: "old",
      tags: [["h", channel]],
    },
    {
      id: "2".repeat(64),
      pubkey: agent,
      kind: 9,
      created_at: 101,
      content: "wrong thread",
      tags: [
        ["h", channel],
        ["e", "x"],
      ],
    },
    {
      id: "3".repeat(64),
      pubkey: agent,
      kind: 9,
      created_at: 101,
      content: "Hello",
      tags: [["h", channel]],
    },
  ]);
  expect(
    (await observedWelcome(session, receipt, new AbortController().signal))?.id,
  ).toBe("3".repeat(64));
  expect(session.read).toHaveBeenCalledWith(
    [
      expect.objectContaining({
        authors: [agent],
        "#h": [channel],
        since: 100,
        consistency: "strong",
      }),
    ],
    expect.anything(),
  );
  vi.mocked(session.read).mockResolvedValue(
    Array.from({ length: 20 }, (_, index) => ({
      id: index.toString(16).padStart(64, "0"),
      pubkey: agent,
      kind: 9,
      created_at: 101,
      content: "Thread reply",
      tags: [
        ["h", channel],
        ["e", "x"],
      ],
    })),
  );
  await expect(
    observedWelcome(session, receipt, new AbortController().signal),
  ).rejects.toThrow("history limit");
});
