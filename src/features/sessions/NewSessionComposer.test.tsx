// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { sectionTemplateId } from "./workspace";
import { composerDOMFixture } from "../messages/composer-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RelaySession } from "../relay/session";
import { writeView } from "../../shared/view-state";
import { NewSessionComposer } from "./NewSessionComposer";

composerDOMFixture();
afterEach(cleanup);
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
  let mounted = render(view());
  await user.click(screen.getByRole("button", { name: "Session actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Session settings…" }),
  );
  await user.type(
    await screen.findByRole("textbox", { name: "Canvas" }),
    "Keep the change small",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(test.workSessions.create).not.toHaveBeenCalled();
  expect(saveCanvas).not.toHaveBeenCalled();
  mounted.unmount();
  mounted = render(view(1));
  const composer = screen.getByRole("textbox", {
    name: "Message this session",
  });
  expect(composer).toHaveFocus();
  const actions = screen.getByRole("button", { name: "Session actions" });
  actions.focus();
  expect(actions).toHaveFocus();
  mounted.rerender(view(new AbortController().signal));
  expect(composer).toHaveFocus();
  await user.type(composer, "Build this");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
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
  f.mePlacement.admit.mockRejectedValueOnce(new Error("Me storage is full"));
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
  await screen.findByText("Me storage is full");
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

it("opens and saves local draft settings in a fresh Me-only group", async () => {
  vi.stubGlobal("crypto", webcrypto);
  try {
    const f = setup();
    const refreshMe = vi.fn(async () => {});
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
      await user.click(screen.getByRole("button", { name: "Session actions" }));
      await user.click(
        await screen.findByRole("menuitem", { name: "Session settings…" }),
      );
      return screen.findByRole("textbox", { name: "Canvas" });
    };
    await user.type(await open(), "Keep this Me draft");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(refreshMe).toHaveBeenCalledOnce();
    expect(refreshMessages).not.toHaveBeenCalled();
    mounted.unmount();
    render(view());
    expect(await open()).toHaveValue("Keep this Me draft");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(f.workSessions.create).not.toHaveBeenCalled();
    expect(f.messages.send).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
