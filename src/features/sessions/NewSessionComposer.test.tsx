// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { sectionTemplateId } from "./workspace";
import { composerDOMFixture } from "../messages/composer-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RelaySession } from "../relay/session";
import { writeView } from "../../shared/view-state";
import { NewSessionComposer, resetNewChatProject } from "./NewSessionComposer";
import { readSelectedAssistant } from "./selected-assistant";
import { createWorkSessions } from "../relay/work-sessions";
import { createOutbox } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import { sessionDescription } from "./metadata";

composerDOMFixture();
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => localStorage.clear());
const parent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Engineering",
  channelType: "stream" as const,
  members: ["a".repeat(64)],
};
function setup(available = true) {
  const rows = [
    { pubkey: "a".repeat(64), name: "Member agent" },
    { pubkey: "b".repeat(64), name: "Outside agent" },
  ];
  const agents = {
    status: "ready",
    identities: rows,
    selectable: rows,
    archives: { status: "unavailable" as const, archived: [] },
  };
  const emoji = { status: "ready", entries: [] };
  const workSessions = {
    available,
    addAgents: vi.fn(async () => {}),
    create: vi.fn<RelaySession["workSessions"]["create"]>(() => "c".repeat(64)),
    invite: vi.fn(() => "e".repeat(64)),
    delivered: vi.fn<RelaySession["workSessions"]["delivered"]>(async () => {}),
    refresh: vi.fn(async () => {}),
    failed: (_id: string) => false,
    discardFailed: vi.fn(async (_id: string) => {}),
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(() => "d".repeat(64)),
  };
  let channelSnapshot = {
    channels: [
      { id: "", channelType: "session" as const, members: parent.members },
    ],
  };
  const profileSnapshot = new Map();
  const placed = new Set<string>();
  const mePlacement = {
    available: true,
    admit: vi.fn(
      async (_id: string, _options: { sectionId?: string | undefined }) => {},
    ),
    set: vi.fn(async (id: string, personal: boolean) => {
      if (personal) placed.add(id);
      else placed.delete(id);
    }),
    has: (id: string) => placed.has(id),
    refresh: vi.fn(async () => {}),
  };
  const session = {
    mePlacement,
    workSessions,
    messages,
    channels: {
      list: () => {
        const id = workSessions.create.mock.calls[0]?.[0] ?? "";
        if (channelSnapshot.channels[0]?.id !== id)
          channelSnapshot = {
            channels: [{ id, channelType: "session", members: parent.members }],
          };
        return channelSnapshot;
      },
      subscribeList: () => () => {},
    },
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => profileSnapshot,
      subscribe: () => () => {},
    },
    agentChoices: {
      retain: () => () => {},
      snapshot: () => agents,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    emoji: {
      snapshot: () => emoji,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    outbox: { supports: () => true },
    media: (url: string) => url,
  } as unknown as RelaySession;
  return { session, workSessions, messages, mePlacement };
}
it.each(
  [true, false].flatMap((child) =>
    [false, true].map((removeMention) => ({ child, removeMention })),
  ),
)(
  "uses restored explicit mentions, not a separate picker: child=$child, removed=$removeMention",
  async ({ child, removeMention }) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    writeView(
      "test",
      `${child ? `sessions:channel:${parent.id}` : "sessions"}:new-draft`,
      {
        text: "@Outside agent Help",
        recipients: [
          { pubkey: "b".repeat(64), name: "Outside agent", start: 0, end: 14 },
        ],
      },
    );
    render(
      <NewSessionComposer
        session={test.session}
        scope="test"
        parent={child ? parent : undefined}
        onStarted={onStarted}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Choose an agent" }),
    ).toBeNull();
    if (removeMention)
      await user.click(
        screen.getByRole("button", {
          name: `Remove mention Outside agent ${"b".repeat(64)}`,
        }),
      );
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    const id = test.workSessions.create.mock.calls[0]?.[0];
    expect(test.workSessions.invite).not.toHaveBeenCalled();
    expect(test.workSessions.addAgents.mock.calls).toEqual(
      removeMention
        ? child
          ? [[id, [], expect.any(Function)]]
          : []
        : (child ? [parent.id, id] : [id]).map((target) => [
            target,
            ["b".repeat(64)],
            expect.any(Function),
          ]),
    );
    expect(test.messages.send).toHaveBeenCalledWith(id, "@Outside agent Help", [
      (removeMention ? "a" : "b").repeat(64),
    ]);
  },
);
it("keeps parent drafts separate and cannot send on an unsupported community", async () => {
  const test = setup(false),
    user = userEvent.setup();
  const view = render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={() => {}}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Parent draft");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  view.unmount();
  const solo = render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      onStarted={() => {}}
    />,
  );
  expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  solo.unmount();
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={() => {}}
    />,
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Parent draft");
  expect(test.workSessions.create).not.toHaveBeenCalled();
});

it("discards a recovered draft with a malformed session identifier", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  writeView("test", "sessions:pending", {
    id: "f".repeat(36),
    text: "Stale draft",
  });
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      onStarted={onStarted}
    />,
  );
  const input = screen.getByRole("textbox");
  expect(input).toHaveProperty("value", "");
  await user.type(input, "Fresh start");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.workSessions.create).toHaveBeenCalledWith(
    expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    ),
    "Fresh start",
    undefined,
    undefined,
    false,
  );
});

it("keeps the prompt through an uncertain delivery and retries without duplicate writes", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  test.workSessions.delivered.mockRejectedValueOnce(
    new Error("Still waiting for delivery"),
  );
  const view = render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Recover this prompt");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox")).toHaveTextContent("Recover this prompt");
  expect(test.messages.send).not.toHaveBeenCalled();
  view.unmount();
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.workSessions.create).toHaveBeenCalledOnce();
  expect(test.messages.send).toHaveBeenCalledOnce();
});

it("recovers a legacy submitted agent recipient without offering a new picker", async () => {
  const test = setup(),
    started = vi.fn();
  const id = "22222222-2222-4222-8222-222222222222";
  writeView("test", "sessions:pending", {
    id,
    text: "Continue",
    creationId: "c".repeat(64),
    agent: "b".repeat(64),
  });
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      onStarted={started}
    />,
  );
  expect(screen.queryByRole("button", { name: "Choose an agent" })).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledWith(id));
  expect(test.workSessions.create).not.toHaveBeenCalled();
  expect(test.workSessions.invite).toHaveBeenCalledExactlyOnceWith(
    id,
    "b".repeat(64),
  );
  expect(test.messages.send).toHaveBeenCalledExactlyOnceWith(id, "Continue", [
    "b".repeat(64),
  ]);
});

it("loads the new session roster profiles before sending without an explicit agent", async () => {
  const test = setup(),
    user = userEvent.setup(),
    onStarted = vi.fn();
  let finish: () => void = () => {};
  vi.mocked(test.session.profiles.ensure).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Keep going");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(test.session.profiles.ensure).toHaveBeenCalledWith(
      parent.members,
      "background",
    ),
  );
  expect(test.messages.send).not.toHaveBeenCalled();
  finish();
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.messages.send).toHaveBeenCalledOnce();
});

it.each([
  { child: false, members: ["a".repeat(64)], error: undefined },
  { child: true, members: ["a".repeat(64)], error: undefined },
  { child: false, members: [], error: undefined },
  {
    child: false,
    members: ["a".repeat(64), "b".repeat(64)],
    error: "There are multiple agents",
  },
  {
    child: false,
    members: ["f".repeat(64)],
    error: "Session participants are still loading",
  },
])(
  "resolves recovered session recipients after refreshing membership: $child, $members",
  async ({ child, members, error }) => {
    const test = setup(),
      user = userEvent.setup(),
      onStarted = vi.fn();
    const id = "22222222-2222-4222-8222-222222222222";
    const key = child ? `sessions:channel:${parent.id}` : "sessions";
    writeView("test", `${key}:pending`, {
      id,
      text: "Continue the work",
      draft: { text: "Continue the work", recipients: [] },
      creationId: "c".repeat(64),
    });
    const channel = {
      id,
      name: "Recovered session",
      channelType: "session" as const,
      members: [] as string[],
    };
    vi.spyOn(test.session.channels, "list").mockReturnValue({
      status: "ready",
      channels: [channel],
    });
    // Another client admitted these participants after creation was interrupted.
    test.workSessions.refresh.mockImplementationOnce(async () => {
      channel.members = members;
    });
    render(
      <NewSessionComposer
        session={test.session}
        scope="test"
        parent={child ? parent : undefined}
        onStarted={onStarted}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    if (error) {
      expect(await screen.findByRole("alert")).toHaveTextContent(error);
      expect(test.messages.send).not.toHaveBeenCalled();
      expect(onStarted).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox")).toHaveProperty(
        "value",
        "Continue the work",
      );
    } else {
      await waitFor(() => expect(onStarted).toHaveBeenCalledWith(id));
      expect(test.messages.send).toHaveBeenCalledExactlyOnceWith(
        id,
        "Continue the work",
        members,
      );
    }
    expect(test.workSessions.create).not.toHaveBeenCalled();
    expect(test.workSessions.invite).not.toHaveBeenCalled();
  },
);

it("deduplicates the effective recipient before parent admission", async () => {
  const test = setup(),
    user = userEvent.setup(),
    onStarted = vi.fn();
  let release = () => {};
  test.workSessions.addAgents.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  writeView("test", `sessions:channel:${parent.id}:new-draft`, {
    text: "@Outside agent Help",
    recipients: [
      { pubkey: "b".repeat(64), name: "Outside agent", start: 0, end: 14 },
    ],
  });
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(test.workSessions.addAgents).toHaveBeenCalledWith(
      parent.id,
      ["b".repeat(64)],
      expect.any(Function),
    ),
  );
  try {
    expect(test.workSessions.create).not.toHaveBeenCalled();
    expect(test.messages.send).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.messages.send).toHaveBeenCalledWith(
    expect.any(String),
    "@Outside agent Help",
    ["b".repeat(64)],
  );
});
it("keeps an editable draft when parent admission fails and retries admission first", async () => {
  const test = setup(),
    user = userEvent.setup(),
    onStarted = vi.fn();
  test.workSessions.addAgents.mockRejectedValueOnce(
    new Error("Only channel admins can add agents"),
  );
  writeView("test", `sessions:channel:${parent.id}:new-draft`, {
    text: "@Outside agent ",
    recipients: [
      { pubkey: "b".repeat(64), name: "Outside agent", start: 0, end: 14 },
    ],
  });
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Help");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Only channel admins",
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Help");
  expect(screen.getByRole("textbox")).not.toBeDisabled();
  expect(test.workSessions.create).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.workSessions.addAgents).toHaveBeenCalledTimes(3);
});

it.each(
  [true, false].flatMap((child) =>
    [true, false].map((sent) => ({ child, sent })),
  ),
)(
  "restores effective recipients without replaying an overridden invitation: child=$child, sent=$sent",
  async ({ child, sent }) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    const key = child ? `sessions:channel:${parent.id}` : "sessions";
    const id = "22222222-2222-4222-8222-222222222222";
    const draft = {
      text: "@Member agent Continue",
      recipients: [
        { pubkey: "a".repeat(64), name: "Member agent", start: 0, end: 13 },
      ],
    };
    writeView("test", `${key}:pending`, {
      id,
      text: draft.text,
      draft,
      agent: "b".repeat(64),
      creationId: "c".repeat(64),
      invitationId: "e".repeat(64),
      ...(sent ? { messageId: "d".repeat(64) } : {}),
    });
    render(
      <NewSessionComposer
        session={test.session}
        scope="test"
        parent={child ? parent : undefined}
        onStarted={onStarted}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(test.workSessions.create).not.toHaveBeenCalled();
    expect(test.workSessions.invite).not.toHaveBeenCalled();
    expect(test.workSessions.delivered).not.toHaveBeenCalledWith(
      "e".repeat(64),
    );
    if (sent) {
      expect(test.workSessions.addAgents).not.toHaveBeenCalled();
      expect(test.messages.send).not.toHaveBeenCalled();
    } else {
      expect(test.workSessions.addAgents.mock.calls).toEqual(
        (child ? [parent.id, id] : [id]).map((target) => [
          target,
          ["a".repeat(64)],
          expect.any(Function),
        ]),
      );
      expect(test.messages.send).toHaveBeenCalledExactlyOnceWith(
        id,
        draft.text,
        ["a".repeat(64)],
      );
    }
  },
);

it.each([false, true])(
  "keeps edits after discarding a failed session send and remounting, child=%s",
  async (child) => {
    const t = setup();
    const user = userEvent.setup();
    const onStarted = vi.fn();
    const id = "d".repeat(64);
    let failed = true;
    t.workSessions.failed = (eventId) => failed && eventId === id;
    t.workSessions.discardFailed = vi.fn(async () => {
      failed = false;
    });
    t.workSessions.delivered.mockImplementation(async (eventId) => {
      if (failed && eventId === id) throw new Error("Not sent");
    });
    const mount = () =>
      render(
        <NewSessionComposer
          session={t.session}
          scope="test"
          parent={child ? parent : undefined}
          onStarted={onStarted}
        />,
      );
    const page = mount();
    await user.type(screen.getByRole("textbox"), "Original draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.click(
      await screen.findByRole("button", { name: "Edit and retry" }),
    );
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Corrected draft");
    page.unmount();
    mount();
    expect(screen.getByRole("textbox")).toHaveTextContent("Corrected draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(t.messages.send.mock.calls[1]?.[1]).toBe("Corrected draft");
  },
);

it.each([false, true])(
  "applies section defaults before first send and blocks failed setup (failure=%s)",
  async (failure) => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const test = setup();
      const sequence: string[] = [];
      const onStarted = vi.fn();
      const id = await sectionTemplateId("work");
      const canvasSave = vi.fn(async (_channel: string, _content: string) => {
        sequence.push("canvas");
        if (failure) throw new Error("Canvas save failed");
        return { id: "f".repeat(64) };
      });
      Object.assign(test.session, {
        channelKit: {
          refresh: async () => {},
          snapshot: () => ({
            status: "ready",
            entries: [
              {
                eventId: "head",
                record: {
                  value: {
                    type: "template",
                    id,
                    canvas: "Use /repo",
                    agents: [],
                    teamIds: [],
                  },
                },
              },
            ],
          }),
        },
        sidebarPreferences: {
          writable: true,
          refresh: async () => {},
          snapshot: () => ({
            status: "ready",
            data: { sections: [{ id: "work", name: "Work" }], assignments: {} },
          }),
          assign: async () => {
            sequence.push("placement");
          },
        },
        canvas: { read: async () => undefined, save: canvasSave },
      });
      test.messages.send.mockImplementation(() => {
        sequence.push("send");
        return "d".repeat(64);
      });
      writeView("test", "sessions:section:work:new-draft", "Build this");
      render(
        <NewSessionComposer
          session={test.session}
          scope="test"
          sectionId="work"
          onStarted={onStarted}
        />,
      );
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("textbox", { name: "Message this session" }),
      );
      await user.keyboard("{Enter}");
      if (failure) {
        expect(await screen.findByText("Canvas save failed")).toBeVisible();
        expect(test.messages.send).not.toHaveBeenCalled();
        expect(onStarted).not.toHaveBeenCalled();
        expect(sequence).toEqual(["canvas"]);
        canvasSave.mockResolvedValue({ id: "f".repeat(64) });
        await user.click(
          screen.getByRole("textbox", { name: "Message this session" }),
        );
        await user.keyboard("{Enter}");
        await waitFor(() => expect(onStarted).toHaveBeenCalled());
        expect(test.workSessions.create).toHaveBeenCalledTimes(1);
        expect(canvasSave.mock.calls[1]?.[1]).toBe("Use /repo");
      } else {
        await waitFor(() => expect(onStarted).toHaveBeenCalled());
        expect(sequence).toEqual(["canvas", "placement", "send"]);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("edits draft settings before creation, restores them, and applies Canvas before the first send", async () => {
  const test = setup();
  const order: string[] = [];
  const saveCanvas = vi.fn(async () => {
    order.push("canvas");
  });
  Object.assign(test.session, {
    canvas: { read: async () => undefined, save: saveCanvas },
  });
  test.messages.send.mockImplementation(() => {
    order.push("send");
    return "d".repeat(64);
  });
  test.workSessions.delivered.mockRejectedValueOnce(
    new Error("Unknown creation"),
  );
  const onStarted = vi.fn();
  const user = userEvent.setup();
  const view = (focusRequest: number | AbortSignal = 0) => (
    <NewSessionComposer
      standalone
      focusRequest={focusRequest}
      session={test.session}
      scope="test"
      onStarted={onStarted}
    />
  );
  writeView("test", "sessions:settings", "Legacy Canvas");
  let mounted = render(view());
  await user.click(screen.getByRole("button", { name: "Session settings" }));
  const canvas = await screen.findByRole("textbox", { name: /^Instructions/ });
  expect(canvas).toHaveValue("Legacy Canvas");
  await user.clear(canvas);
  await user.type(canvas, "Keep the change small");
  await user.click(screen.getByRole("radio", { name: /^Temporary/ }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Session settings" }),
    ).toHaveFocus(),
  );
  expect(screen.queryByRole("menu")).toBeNull();
  expect(test.workSessions.create).not.toHaveBeenCalled();
  expect(saveCanvas).not.toHaveBeenCalled();
  mounted.unmount();
  mounted = render(view(1));
  const composer = screen.getByRole("textbox", {
    name: "Message this session",
  });
  expect(composer).toHaveFocus();
  const actions = screen.getByRole("button", { name: "Session settings" });
  actions.focus();
  expect(actions).toHaveFocus();
  mounted.rerender(view(new AbortController().signal));
  expect(composer).toHaveFocus();
  await user.type(composer, "Build this");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unknown creation",
  );
  expect(test.workSessions.create.mock.calls[0]?.[3]).toBe(604800);
  mounted.unmount();
  // A changed local setting must not replace the frozen first-attempt lifetime.
  writeView("test", "sessions:settings", {
    canvas: "Other settings",
    ttlSeconds: 86400,
  });
  render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(test.workSessions.create).toHaveBeenCalledOnce();
  expect(saveCanvas).toHaveBeenCalledWith(
    expect.any(String),
    "Keep the change small",
    undefined,
  );
  expect(order).toEqual(["canvas", "send"]);
});

it("recovers a deleted destination without duplicating the session or dropping its Canvas", async () => {
  const test = setup();
  const onStarted = vi.fn();
  const id = "22222222-2222-4222-8222-222222222222";
  const canvas = { id: "f".repeat(64), content: "Frozen instructions" };
  const assign = vi.fn();
  const channels = { status: "ready", channels: [{ id, members: [] }] };
  Object.assign(test.session, {
    canvas: { read: async () => canvas, save: vi.fn() },
    channels: {
      list: () => channels,
      subscribeList: () => () => {},
    },
    sidebarPreferences: {
      refresh: async () => {},
      snapshot: () => ({
        status: "ready",
        data: { sections: [], assignments: {} },
      }),
      assign,
    },
  });
  writeView("test", "sessions:section:deleted:pending", {
    id,
    text: "Continue my work",
    creationId: "c".repeat(64),
    setup: { sectionId: "deleted", canvas: canvas.content, agents: [] },
  });
  const view = () => (
    <NewSessionComposer
      session={test.session}
      scope="test"
      sectionId="deleted"
      resumeDraftKey="sessions:section:deleted"
      onStarted={onStarted}
    />
  );
  const first = render(view());
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(
    "The section was removed. Continue without a section to retry.",
  );
  expect(test.messages.send).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Continue without section" }),
  );
  first.unmount();
  render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(id));
  expect(test.workSessions.create).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
  expect(test.messages.send).toHaveBeenCalledExactlyOnceWith(
    id,
    "Continue my work",
    [],
  );
});

it("retries Me placement on the same created channel before sending, including after remount", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  f.mePlacement.set.mockRejectedValueOnce(new Error("Placement unavailable"));
  writeView("me-test", "me:new-draft", "Private thought");
  const view = render(
    <NewSessionComposer
      personal
      session={f.session}
      scope="me-test"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Placement unavailable");
  expect(f.messages.send).not.toHaveBeenCalled();
  const id = f.workSessions.create.mock.calls[0]?.[0];
  if (!id) throw new Error("Missing creation");
  view.unmount();
  render(
    <NewSessionComposer
      personal
      session={f.session}
      scope="me-test"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledWith(id));
  expect(f.workSessions.create).toHaveBeenCalledTimes(1);
  expect(f.mePlacement.set).toHaveBeenNthCalledWith(2, id, true, {
    sectionId: undefined,
  });
  expect(f.messages.send).toHaveBeenCalledExactlyOnceWith(
    id,
    "Private thought",
    [],
  );
});

it("starts a Me chat with a visible assistant and remembers it for the created chat", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  render(
    <NewSessionComposer
      personal
      session={f.session}
      scope="me-assistant"
      onStarted={started}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Start here");
  await user.click(
    screen.getByRole("button", { name: "Choose follow-up assistant" }),
  );
  await user.click(screen.getByRole("button", { name: "Outside agent" }));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const id = f.workSessions.create.mock.calls[0]?.[0];
  if (!id) throw new Error("Missing created chat");
  expect(f.messages.send).toHaveBeenCalledWith(id, "Start here", [
    "b".repeat(64),
  ]);
  expect(readSelectedAssistant("me-assistant", id)).toBe("b".repeat(64));
});

it("freezes the assistant while a Me creation receipt is pending", () => {
  const f = setup();
  const id = "22222222-2222-4222-8222-222222222222";
  writeView("me-pending", "me:new-agent", "a".repeat(64));
  writeView("me-pending", "me:pending", {
    id,
    text: "Retry this thought",
    agent: "b".repeat(64),
    invitationId: "e".repeat(64),
    creationId: "c".repeat(64),
  });
  render(
    <NewSessionComposer
      personal
      session={f.session}
      scope="me-pending"
      onStarted={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: /^Change agent: Outside agent/ }),
  ).toBeDisabled();
});

it("passes the frozen Me section into initial placement before setup and send", async () => {
  const f = setup();
  const id = "22222222-2222-4222-8222-222222222222";
  const started = vi.fn();
  const assign = vi.fn();
  const preferences = {
    status: "ready",
    data: { sections: [{ id: "work" }], assignments: { [id]: "work" } },
  };
  Object.assign(f.session, {
    canvas: { read: async () => undefined },
    mePreferences: {
      refresh: async () => {},
      snapshot: () => preferences,
      assign,
    },
  });
  writeView("me-section", "me:section:work:pending", {
    id,
    text: "First thought",
    creationId: "c".repeat(64),
    setup: { sectionId: "work", canvas: "", agents: [] },
  });
  render(
    <NewSessionComposer
      personal
      session={f.session}
      scope="me-section"
      sectionId="work"
      resumeDraftKey="me:section:work"
      onStarted={started}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledWith(id));
  expect(f.mePlacement.set).toHaveBeenCalledExactlyOnceWith(id, true, {
    sectionId: "work",
  });
  expect(assign).not.toHaveBeenCalled();
  expect(f.messages.send).toHaveBeenCalledExactlyOnceWith(
    id,
    "First thought",
    [],
  );
});

it("keeps the Me draft and creates nothing until capacity admission succeeds", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  f.mePlacement.admit.mockRejectedValueOnce(new Error("Solo storage is full"));
  writeView("me-full", "me:new-draft", "Keep this thought");
  const view = render(
    <NewSessionComposer
      personal
      session={f.session}
      scope="me-full"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Solo storage is full");
  expect(f.workSessions.create).not.toHaveBeenCalled();
  expect(f.messages.send).not.toHaveBeenCalled();
  const id = f.mePlacement.admit.mock.calls[0]?.[0];
  view.unmount();
  render(
    <NewSessionComposer
      personal
      session={f.session}
      scope="me-full"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledWith(id));
  expect(f.workSessions.create).toHaveBeenCalledOnce();
  expect(f.mePlacement.admit).toHaveBeenNthCalledWith(2, id, {
    sectionId: undefined,
  });
  expect(f.messages.send).toHaveBeenCalledExactlyOnceWith(
    id,
    "Keep this thought",
    [],
  );
});

it.each([false, true])(
  "opens and saves local draft settings in a fresh Me-only group, failed initial read=%s",
  async (failedRead) => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const f = setup();
      const refreshMe = vi.fn(async () => {});
      if (failedRead)
        refreshMe.mockRejectedValueOnce(new Error("Settings unavailable"));
      const refreshMessages = vi.fn(async () => {
        throw new Error("Wrong namespace");
      });
      Object.assign(f.session, {
        mePreferences: {
          writable: true,
          refresh: refreshMe,
          snapshot: () => ({
            status: "ready",
            data: {
              sections: [{ id: "me-only", name: "Work" }],
              assignments: {},
            },
          }),
        },
        sidebarPreferences: { refresh: refreshMessages },
        channelKit: {
          refresh: async () => {},
          snapshot: () => ({ status: "ready", entries: [] }),
        },
      });
      const view = () => (
        <NewSessionComposer
          standalone
          personal
          session={f.session}
          scope="me-settings"
          sectionId="me-only"
          onStarted={() => {}}
        />
      );
      const user = userEvent.setup();
      const mounted = render(view());
      const open = async () => {
        await user.click(
          screen.getByRole("button", { name: "Session settings" }),
        );
      };
      await open();
      if (failedRead) {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "Settings unavailable",
        );
        expect(screen.queryByText("Loading settings…")).toBeNull();
        expect(
          screen.getByRole("button", { name: "Save changes" }),
        ).toBeDisabled();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        refreshMe.mockImplementationOnce(() => held);
        try {
          await user.click(
            screen.getByRole("button", { name: "Retry settings" }),
          );
          await waitFor(() => expect(refreshMe).toHaveBeenCalledTimes(2));
          expect(screen.getByRole("status")).toHaveTextContent(
            "Loading settings…",
          );
          expect(screen.queryByRole("alert")).toBeNull();
          expect(
            screen.getByRole("button", { name: "Save changes" }),
          ).toBeDisabled();
        } finally {
          release();
        }
      }
      await user.type(
        await screen.findByRole("textbox", { name: /^Instructions/ }),
        "Keep this Me draft",
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      expect(refreshMe).toHaveBeenCalledTimes(failedRead ? 2 : 1);
      expect(refreshMessages).not.toHaveBeenCalled();
      mounted.unmount();
      render(view());
      await open();
      expect(
        await screen.findByRole("textbox", { name: /^Instructions/ }),
      ).toHaveValue("Keep this Me draft");
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled();
      expect(f.workSessions.create).not.toHaveBeenCalled();
      expect(f.messages.send).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each(["draft", "nonnumber draft", "receipt"])(
  "invalid stored %s lifetime fails visibly without a new create",
  async (source) => {
    const h = setup();
    writeView("test", "sessions:new-draft", "Keep this draft");
    if (source !== "receipt")
      writeView("test", "sessions:settings", {
        canvas: "",
        ttlSeconds: source === "draft" ? -1 : "broken",
      });
    else
      writeView("test", "sessions:pending", {
        id: parent.id,
        text: "Keep this draft",
        ttlSeconds: -1,
        creationId: "c".repeat(64),
      });
    const user = userEvent.setup();
    render(
      <NewSessionComposer
        session={h.session}
        scope="test"
        onStarted={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "duration could not be verified",
    );
    expect(h.workSessions.create).not.toHaveBeenCalled();
    expect(h.workSessions.delivered).not.toHaveBeenCalled();
  },
);

it("freezes lifetime even when the first create fails before receiving an event ID", async () => {
  const h = setup(),
    user = userEvent.setup(),
    started = vi.fn();
  Object.assign(h.session, {
    canvas: { read: async () => undefined, save: vi.fn(async () => {}) },
  });
  h.workSessions.create.mockImplementationOnce(() => {
    throw new Error("Creation unavailable");
  });
  writeView("test", "sessions:settings", { ttlSeconds: 600 });
  writeView("test", "sessions:new-draft", "Keep this prompt");
  const view = () => (
    <NewSessionComposer
      standalone
      session={h.session}
      scope="test"
      onStarted={started}
    />
  );
  const mounted = render(view());
  await user.click(screen.getByRole("button", { name: "Session settings" }));
  const temporary = await screen.findByRole("radio", { name: /^Temporary/ });
  await user.click(screen.getByRole("radio", { name: /^Ongoing/ }));
  await user.click(temporary);
  expect(temporary).toHaveAccessibleDescription(
    "Archives after 10 minutes without activity.",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Creation unavailable",
  );
  mounted.unmount();
  writeView("test", "sessions:settings", { ttlSeconds: 86400 });
  render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(h.workSessions.create.mock.calls.map((call) => call[3])).toEqual([
    600, 600,
  ]);
});

it.each([-1, "broken"])(
  "parent-linked settings hide and clear invalid inherited lifetime %s",
  async (ttlSeconds) => {
    const h = setup(),
      user = userEvent.setup(),
      started = vi.fn();
    Object.assign(h.session, {
      canvas: { read: async () => undefined, save: vi.fn(async () => {}) },
    });
    writeView("test", `sessions:channel:${parent.id}:settings`, {
      canvas: "Keep parent Canvas",
      ttlSeconds,
    });
    writeView(
      "test",
      `sessions:channel:${parent.id}:new-draft`,
      "Keep parent prompt",
    );
    render(
      <NewSessionComposer
        standalone
        session={h.session}
        parent={parent}
        scope="test"
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "duration could not be verified",
    );
    expect(h.workSessions.create).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Session settings" }));
    expect(
      await screen.findByRole("textbox", { name: /^Instructions/ }),
    ).toHaveValue("Keep parent Canvas");
    expect(screen.queryByRole("radio", { name: /^Ongoing/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /^Temporary/ })).toBeNull();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeEnabled();
    await user.click(save);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(h.workSessions.create.mock.calls[0]?.[3]).toBeUndefined();
  },
);

it("invalid stored Canvas is safely editable without dropping a malformed lifetime", async () => {
  const h = setup(),
    user = userEvent.setup();
  writeView("test", "sessions:settings", {
    canvas: { invalid: true },
    ttlSeconds: "broken",
  });
  writeView("test", "sessions:new-draft", "Keep this prompt");
  render(
    <NewSessionComposer
      standalone
      session={h.session}
      scope="test"
      onStarted={() => {}}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Session settings" }));
  const canvas = await screen.findByRole("textbox", { name: /^Instructions/ });
  expect(canvas).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "duration could not be verified",
  );
  expect(h.workSessions.create).not.toHaveBeenCalled();
});

async function projectSetup() {
  vi.stubGlobal("crypto", webcrypto);
  const f = setup();
  const entries = await Promise.all(
    ["work", "other"].map(async (id) => ({
      eventId: id,
      record: {
        value: {
          type: "template",
          id: await sectionTemplateId(id, true),
          canvas: `${id} instructions`,
          agents: [],
          teamIds: [],
        },
      },
    })),
  );
  const preferences = {
    status: "ready",
    data: {
      sections: [
        { id: "work", name: "Work" },
        { id: "other", name: "Other" },
      ],
      assignments: {},
    },
  };
  const saveCanvas = vi.fn(async () => {});
  Object.assign(f.session, {
    mePreferences: {
      writable: true,
      refresh: async () => {},
      snapshot: () => preferences,
      subscribe: () => () => {},
      assign: async () => {},
    },
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries }),
    },
    canvas: { read: async () => undefined, save: saveCanvas },
  });
  return { ...f, saveCanvas };
}

it.each([false, true])(
  "re-entering a mounted project clears changed defaults and preserves pending starts (pending=%s)",
  async (submitted) => {
    const f = await projectSetup();
    const started = vi.fn();
    const scope = `project-reset-${submitted}`;
    const key = "me:section:work";
    writeView(scope, `${key}:new-project`, "other");
    writeView(scope, `${key}:settings`, "other edited instructions");
    if (submitted)
      writeView(scope, `${key}:pending`, {
        id: "22222222-2222-4222-8222-222222222222",
        text: "Keep me",
        setup: {
          sectionId: "other",
          agents: [],
          canvas: "other edited instructions",
        },
      });
    render(
      <NewSessionComposer
        personal
        standalone
        sectionId="work"
        session={f.session}
        scope={scope}
        onStarted={started}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Project: Other" }),
    ).toBeVisible();
    act(() => resetNewChatProject(scope, true, "work"));
    expect(
      await screen.findByRole("button", {
        name: submitted ? "Project: Other" : "Project: Work",
      }),
    ).toBeVisible();
    if (!submitted) {
      await userEvent.click(
        screen.getByRole("button", { name: "Session settings" }),
      );
      expect(
        await screen.findByRole("textbox", { name: /^Instructions/ }),
      ).toHaveValue("work instructions");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await userEvent.type(screen.getByRole("textbox"), "Start in Work");
    }
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.mePlacement.set).toHaveBeenCalledWith(expect.any(String), true, {
      sectionId: submitted ? "other" : "work",
    });
    expect(f.saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      submitted ? "other edited instructions" : "work instructions",
      undefined,
    );
  },
);

it("re-entering a project while a start loads its defaults keeps the submitted project", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const user = userEvent.setup();
  const scope = "project-reset-loading";
  writeView(scope, "me:section:work:new-project", "other");
  let release = () => {};
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(f.session.channelKit, "refresh").mockReturnValue(loading);
  f.mePlacement.admit.mockRejectedValueOnce(new Error("Admission unavailable"));
  render(
    <NewSessionComposer
      personal
      standalone
      sectionId="work"
      session={f.session}
      scope={scope}
      onStarted={started}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Start in Other");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  act(() => resetNewChatProject(scope, true, "work"));
  release();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Admission unavailable",
  );
  expect(screen.getByRole("button", { name: "Project: Other" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.mePlacement.set).toHaveBeenCalledWith(expect.any(String), true, {
    sectionId: "other",
  });
  expect(f.saveCanvas).toHaveBeenCalledWith(
    expect.any(String),
    "other instructions",
    undefined,
  );
});

it("keeps a locally chosen project when its persistence fails and other draft writes succeed", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const user = userEvent.setup();
  const scope = "project-write-failure";
  const key = `buzz-view.v1:${JSON.stringify([scope, "me:section:work:new-project"])}`;
  const setItem = Storage.prototype.setItem;
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new Error("Storage unavailable");
      setItem.call(this, name, value);
    });
  try {
    render(
      <NewSessionComposer
        personal
        sectionId="work"
        session={f.session}
        scope={scope}
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Project: Work" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Other" }),
    );
    await user.type(screen.getByRole("textbox"), "Keep this project");
    expect(
      screen.getByRole("button", { name: "Project: Other" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.mePlacement.admit).toHaveBeenCalledWith(expect.any(String), {
      sectionId: "other",
    });
  } finally {
    storage.mockRestore();
  }
});

it("inherits the project's defaults for two consecutive new chats", async () => {
  const f = await projectSetup();
  const user = userEvent.setup();
  const started = vi.fn();
  for (let index = 0; index < 2; index++) {
    const view = render(
      <NewSessionComposer
        personal
        session={f.session}
        scope="repeat-project"
        sectionId="work"
        onStarted={started}
      />,
    );
    expect(screen.getByRole("button", { name: "Project: Work" })).toBeVisible();
    await user.type(screen.getByRole("textbox"), `Chat ${index}`);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledTimes(index + 1));
    expect(f.saveCanvas).toHaveBeenNthCalledWith(
      index + 1,
      expect.any(String),
      "work instructions",
      undefined,
    );
    view.unmount();
  }
  expect(f.workSessions.create.mock.calls[0]?.[0]).not.toBe(
    f.workSessions.create.mock.calls[1]?.[0],
  );
});

it.each(
  [false, true].flatMap((saved) =>
    [false, true].flatMap((remount) =>
      [false, true].map((fromProject) => ({ saved, remount, fromProject })),
    ),
  ),
)(
  "switching projects uses new defaults and retains independent naming/lifetime (saved=$saved, remount=$remount, fromProject=$fromProject)",
  async ({ saved, remount, fromProject }) => {
    const f = await projectSetup();
    const user = userEvent.setup();
    const started = vi.fn();
    const draftKey = fromProject ? "me:section:work" : "me";
    writeView("switch-project", `${draftKey}:settings`, {
      name: "My chosen title",
      ttlSeconds: 600,
    });
    const view = () => (
      <NewSessionComposer
        standalone
        personal
        session={f.session}
        scope="switch-project"
        sectionId={fromProject ? "work" : undefined}
        onStarted={started}
      />
    );
    const mounted = render(view());
    const openSettings = async () => {
      await user.click(
        screen.getByRole("button", { name: "Session settings" }),
      );
      return screen.findByRole("textbox", { name: /^Instructions/ });
    };
    if (saved) {
      const canvas = await openSettings();
      await waitFor(() =>
        expect(canvas).toHaveValue(fromProject ? "work instructions" : ""),
      );
      await user.clear(canvas);
      await user.type(canvas, "Old project override");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
    }
    await user.click(
      screen.getByRole("button", {
        name: fromProject ? "Project: Work" : "Project: No project",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: /^Other$/ }),
    );
    if (remount) {
      mounted.unmount();
      render(view());
    }
    const canvas = await openSettings();
    await waitFor(() => expect(canvas).toHaveValue("other instructions"));
    expect(
      screen.getByRole("textbox", { name: "Session name (optional)" }),
    ).toHaveValue("My chosen title");
    expect(screen.getByRole("radio", { name: /^Temporary/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.type(screen.getByRole("textbox"), "New project chat");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "other instructions",
      undefined,
    );
    expect(f.mePlacement.admit).toHaveBeenCalledWith(expect.any(String), {
      sectionId: "other",
    });
    expect(f.workSessions.create).toHaveBeenCalledWith(
      expect.any(String),
      "My chosen title",
      undefined,
      600,
      true,
    );
  },
);

it.each([false, true])(
  "editing a failed invitation clears the assistant consistently (remount=%s)",
  async (remount) => {
    const f = setup();
    const user = userEvent.setup();
    const started = vi.fn();
    const invitation = "e".repeat(64);
    f.workSessions.failed = (id) => id === invitation;
    f.workSessions.delivered.mockImplementation(async (id) => {
      if (id === invitation) throw new Error("Invitation rejected");
    });
    writeView("failed-agent", "me:new-agent", "b".repeat(64));
    writeView("failed-agent", "me:new-draft", "Keep the text");
    const view = () => (
      <NewSessionComposer
        personal
        session={f.session}
        scope="failed-agent"
        onStarted={started}
      />
    );
    let mounted = render(view());
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Invitation rejected");
    await user.click(screen.getByRole("button", { name: "Edit and retry" }));
    if (remount) {
      mounted.unmount();
      mounted = render(view());
    }
    expect(
      screen.getByRole("button", { name: "Choose follow-up assistant" }),
    ).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.workSessions.invite).toHaveBeenCalledTimes(1);
    expect(f.messages.send).toHaveBeenCalledWith(
      expect.any(String),
      "Keep the text",
      [],
    );
    mounted.unmount();
  },
);

it.each([
  { invited: true, saved: "a".repeat(64), mentioned: false },
  { invited: true, saved: undefined, mentioned: false },
  { invited: false, saved: undefined, mentioned: false },
  { invited: false, saved: "", mentioned: false },
  { invited: true, saved: undefined, mentioned: true },
])(
  "restores receipt routing (invited=$invited, saved=$saved, mentioned=$mentioned)",
  async ({ invited, saved, mentioned }) => {
    const f = setup();
    const started = vi.fn();
    const id = "22222222-2222-4222-8222-222222222222";
    const recipient = "b".repeat(64);
    if (saved !== undefined)
      writeView("receipt-routing", "me:new-agent", saved);
    writeView("receipt-routing", "me:pending", {
      id,
      text: mentioned ? "@Member agent Continue" : "Continue",
      ...(mentioned
        ? {
            draft: {
              text: "@Member agent Continue",
              recipients: [
                {
                  pubkey: "a".repeat(64),
                  name: "Member agent",
                  start: 0,
                  end: 13,
                },
              ],
            },
          }
        : {}),
      agent: recipient,
      creationId: "c".repeat(64),
      ...(invited ? { invitationId: "e".repeat(64) } : {}),
    });
    render(
      <NewSessionComposer
        personal
        session={f.session}
        scope="receipt-routing"
        onStarted={started}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledWith(id));
    expect(f.messages.send).toHaveBeenCalledWith(
      id,
      mentioned ? "@Member agent Continue" : "Continue",
      mentioned ? ["a".repeat(64)] : saved === "" ? [] : [recipient],
    );
    if (invited || saved === "")
      expect(f.workSessions.invite).not.toHaveBeenCalled();
    else expect(f.workSessions.invite).toHaveBeenCalledWith(id, recipient);
    if (!mentioned && saved !== "")
      expect(f.workSessions.refresh).toHaveBeenCalledWith(id, {
        member: recipient,
      });
  },
);

it("allows changing an unavailable assistant before any remote creation", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const choices = f.session.agentChoices.snapshot();
  vi.spyOn(f.session.agentChoices, "snapshot").mockReturnValue({
    ...choices,
    selectable: choices.selectable.filter(
      (agent) => agent.pubkey === "a".repeat(64),
    ),
  });
  writeView("unavailable-agent", "me:new-agent", "b".repeat(64));
  writeView("unavailable-agent", "me:new-draft", "Keep my draft");
  render(
    <NewSessionComposer
      personal
      session={f.session}
      scope="unavailable-agent"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(
    "Solo chats can only use your available agents. Check mentions and section defaults.",
  );
  expect(f.workSessions.create).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Change selected agent" }),
  );
  await user.click(screen.getByRole("button", { name: /^Member agent$/ }));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.messages.send).toHaveBeenCalledWith(
    expect.any(String),
    "Keep my draft",
    ["a".repeat(64)],
  );
});

it.each(["", "Make contrast accessible"])(
  "freezes the chosen or first-prompt name %j before asynchronous setup",
  async (name) => {
    const h = setup(),
      user = userEvent.setup(),
      started = vi.fn();
    writeView("test", "sessions:settings", { name, ttlSeconds: 600 });
    writeView("test", "sessions:new-draft", "Original prompt");
    h.workSessions.create.mockImplementationOnce(() => {
      throw new Error("Unavailable");
    });
    const view = () => (
      <NewSessionComposer
        session={h.session}
        scope="test"
        onStarted={started}
      />
    );
    const mounted = render(view());
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
    mounted.unmount();
    writeView("test", "sessions:settings", { name: "Later name" });
    render(view());
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Control>}a{/Control}Replacement prompt");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    for (const call of h.workSessions.create.mock.calls) {
      expect(call[1]).toBe(name || "Original prompt");
      expect(call[4]).toBe(false);
    }
    expect(h.messages.send).toHaveBeenCalledOnce();
  },
);
it("draft naming shares the existing Save and persists locally without creation", async () => {
  const h = setup(),
    user = userEvent.setup();
  render(
    <NewSessionComposer
      standalone
      session={h.session}
      scope="test"
      onStarted={() => {}}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Session settings" }));
  const input = await screen.findByRole("textbox", {
    name: "Session name (optional)",
  });
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, "Named draft");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await user.click(screen.getByRole("button", { name: "Session settings" }));
  expect(
    await screen.findByRole("textbox", { name: "Session name (optional)" }),
  ).toHaveValue("Named draft");
  expect(h.workSessions.create).not.toHaveBeenCalled();
  expect(h.messages.send).not.toHaveBeenCalled();
});

it.each([
  { source: "draft", fields: { name: null } },
  { source: "draft", fields: { name: 7 } },
  { source: "draft", fields: { name: { invalid: true } } },
  { source: "draft", fields: { name: "x".repeat(121) } },
  { source: "receipt", fields: { name: { invalid: true } } },
])(
  "rejects malformed persisted naming before start side effects: $source $fields",
  async ({ source, fields }) => {
    const h = setup(),
      user = userEvent.setup(),
      started = vi.fn();
    const refreshPreferences = vi.fn(async () => {});
    const refreshSetup = vi.fn(async () => {});
    const readCanvas = vi.fn(async () => undefined);
    const saveCanvas = vi.fn(async () => {});
    const refreshAgents = vi.fn(async () => {});
    Object.assign(h.session, {
      channelKit: { refresh: refreshSetup },
      mePreferences: {
        refresh: refreshPreferences,
        snapshot: () => ({
          data: { sections: [{ id: "work", name: "Work" }] },
        }),
      },
      canvas: { read: readCanvas, save: saveCanvas },
      agentChoices: { ...h.session.agentChoices, refresh: refreshAgents },
    });
    const key = "me:section:work";
    writeView("test", `${key}:new-draft`, "Keep this draft");
    if (source === "draft") writeView("test", `${key}:settings`, fields);
    else
      writeView("test", `${key}:pending`, {
        id: parent.id,
        text: "Keep this draft",
        ...fields,
      });
    render(
      <NewSessionComposer
        personal
        session={h.session}
        scope="test"
        sectionId="work"
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/name/i);
    for (const operation of [
      refreshPreferences,
      refreshSetup,
      readCanvas,
      saveCanvas,
      refreshAgents,
      h.mePlacement.admit,
      h.mePlacement.set,
      h.mePlacement.refresh,
      h.workSessions.create,
      h.workSessions.delivered,
      h.workSessions.refresh,
      h.workSessions.invite,
      h.workSessions.addAgents,
      h.messages.send,
      started,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it.each(
  [false, true].flatMap((personal) =>
    [false, true].map((explicit) => ({ personal, explicit })),
  ),
)(
  "naming crosses the real composer → creation/outbox boundary with frozen intent (personal=$personal, explicit=$explicit)",
  async ({ personal, explicit }) => {
    const h = setup();
    const viewer = keypair();
    const publish = vi.fn(async (_event: Parameters<typeof signed>[1]) => {});
    const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(viewer, template),
    );
    const outbox = createOutbox(
      viewer.pubkey,
      { kinds: [9, 9007], sign, publish },
      { load: () => [], save() {} },
    );
    const lifetime = new AbortController();
    const namespace = personal ? "me" : "sessions";
    writeView("real-creation", `${namespace}:settings`, {
      name: explicit ? "Chosen title" : "",
      ttlSeconds: 600,
    });
    writeView("real-creation", `${namespace}:new-draft`, "Original prompt");
    let observed = outbox.outbox.snapshot();
    let channelList = {
      status: "ready" as const,
      channels: [] as {
        id: string;
        name: string;
        channelType: "session";
        members: string[];
      }[],
    };
    const channels = {
      ...h.session.channels,
      list: () => {
        const next = outbox.outbox.snapshot();
        if (next !== observed) {
          observed = next;
          channelList = {
            status: "ready",
            channels: next
              .filter(({ event }) => event.kind === 9007)
              .map(({ event }) => ({
                id: event.tags.find(([key]) => key === "h")?.[1] ?? "",
                name: "Chosen title",
                channelType: "session",
                members: [viewer.pubkey],
              })),
          };
        }
        return channelList;
      },
    };
    const workSessions = createWorkSessions(
      outbox.outbox,
      channels,
      { read: async () => [] },
      lifetime.signal,
    );
    const session = {
      ...h.session,
      viewer: viewer.pubkey,
      channels,
      workSessions,
      messages: {
        ...h.session.messages,
        send: (id: string, text: string) =>
          outbox.outbox.send({ kind: 9, content: text, tags: [["h", id]] }),
      },
    } as RelaySession;
    const started = vi.fn();
    const mounted = render(
      <NewSessionComposer
        personal={personal}
        session={session}
        scope="real-creation"
        onStarted={started}
      />,
    );
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      const created = publish.mock.calls
        .map(([event]) => event)
        .find((event) => event.kind === 9007);
      expect(created?.tags).toContainEqual([
        "name",
        explicit ? "Chosen title" : "Original prompt",
      ]);
      expect(created?.tags).toContainEqual([
        "about",
        sessionDescription(undefined, personal),
      ]);
      expect(created?.tags).toContainEqual(["ttl", "600"]);
      expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([
        9007, 9,
      ]);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      mounted.unmount();
      lifetime.abort();
      outbox.dispose();
    }
  },
);

it.each([
  { fields: { name: "Frozen title" }, title: "Frozen title" },
  { fields: { name: "" }, title: "Original receipt prompt" },
  { fields: {}, title: "Original receipt prompt" },
])(
  "recovers pending receipts without changing original intent: $fields",
  async ({ fields, title }) => {
    const h = setup(),
      user = userEvent.setup(),
      started = vi.fn();
    writeView("test", "sessions:pending", {
      id: parent.id,
      text: "Original receipt prompt",
      ...fields,
    });
    render(
      <NewSessionComposer
        session={h.session}
        scope="test"
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(h.workSessions.create).toHaveBeenCalledWith(
      parent.id,
      title,
      undefined,
      undefined,
      false,
    );
    expect(h.workSessions.create).toHaveBeenCalledOnce();
    expect(h.messages.send).toHaveBeenCalledOnce();
  },
);
