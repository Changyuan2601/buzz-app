// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { projectTemplateId } from "./workspace";
import { composerDOMFixture } from "../messages/composer-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RelaySession } from "../relay/session";
import { writeView } from "../../shared/view-state";
import { SoloDraft, resetNewChatProject } from "./SoloDraft";
import { createChannelWrites } from "../relay/channel-writes";
import { createOutbox } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import { SOLO_LABEL } from "./labels";

composerDOMFixture();
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => localStorage.clear());
const existing = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Engineering",
  channelType: "stream" as const,
  members: ["a".repeat(64)],
};
function taggedDraft(
  text: string,
  key = "a".repeat(64),
  name = "Member agent",
) {
  const mention = `@${name}`;
  return {
    text: `${mention} ${text}`,
    recipients: [{ pubkey: key, name, start: 0, end: mention.length }],
  };
}
function setup(available = true) {
  const rows = [
    { pubkey: "a".repeat(64), name: "Member agent" },
    { pubkey: "b".repeat(64), name: "Outside agent" },
  ];
  const agents = {
    status: "ready",
    complete: true,
    identities: rows,
    selectable: rows,
    archives: { status: "unavailable" as const, archived: [] },
  };
  const emoji = { status: "ready", entries: [] };
  const channelWrites = {
    available,
    addAgents: vi.fn(async () => {}),
    create: vi.fn<RelaySession["channelWrites"]["create"]>(() =>
      "c".repeat(64),
    ),
    delivered: vi.fn<RelaySession["channelWrites"]["delivered"]>(
      async () => {},
    ),
    refresh: vi.fn(async () => {}),
    failed: (_id: string) => false,
    discardFailed: vi.fn(async (_id: string) => {}),
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(() => "d".repeat(64)),
  };
  const viewer = "f".repeat(64);
  let channelSnapshot = {
    channels: [
      {
        id: "",
        channelType: "solo" as const,
        creator: viewer,
        members: existing.members,
      },
    ],
  };
  const profileSnapshot = new Map();
  const session = {
    viewer,
    channelWrites,
    messages,
    channels: {
      list: () => {
        // The chat a start last refreshed, or the one it just created.
        const id =
          (
            channelWrites.refresh.mock.calls.at(-1) as string[] | undefined
          )?.[0] ??
          channelWrites.create.mock.calls.at(-1)?.[0] ??
          "";
        if (channelSnapshot.channels[0]?.id !== id)
          channelSnapshot = {
            channels: [
              {
                id,
                channelType: "solo",
                creator: viewer,
                members: existing.members,
              },
            ],
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
  return { session, channelWrites, messages };
}
it("uses restored explicit mentions, not a separate picker", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  writeView("test", "solo:new-draft", {
    text: "@Outside agent Help",
    recipients: [
      { pubkey: "b".repeat(64), name: "Outside agent", start: 0, end: 14 },
    ],
  });
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  expect(screen.queryByRole("button", { name: "Choose an agent" })).toBeNull();
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  expect(test.channelWrites.addAgents.mock.calls).toEqual([
    [id, ["b".repeat(64)], expect.any(Function)],
  ]);
  expect(test.messages.send).toHaveBeenCalledWith(id, "@Outside agent Help", [
    "b".repeat(64),
  ]);
});
it("retries a rejected creation as a new request after discarding it", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  let rejected = true;
  test.channelWrites.failed = (id: string) => rejected && id === "c".repeat(64);
  test.channelWrites.discardFailed.mockImplementation(async () => {
    rejected = false;
  });
  test.channelWrites.delivered.mockRejectedValueOnce(
    new Error("Channel creation rejected"),
  );
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.type(screen.getByRole("textbox"), "Try again");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Channel creation rejected",
  );
  expect(test.channelWrites.discardFailed).toHaveBeenCalledWith("c".repeat(64));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.channelWrites.create).toHaveBeenCalledTimes(2);
  expect(test.messages.send).toHaveBeenCalledOnce();
});
it("cannot send on an unsupported community", async () => {
  const test = setup(false),
    user = userEvent.setup();
  render(
    <SoloDraft session={test.session} scope="test" onStarted={() => {}} />,
  );
  await user.type(screen.getByRole("textbox"), "Draft");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
});

it("keeps the prompt through an uncertain creation and retries it without another create", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  test.channelWrites.delivered.mockRejectedValueOnce(
    new Error("Still waiting for delivery"),
  );
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.type(screen.getByRole("textbox"), "Recover this prompt");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox")).toHaveTextContent("Recover this prompt");
  expect(test.messages.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.channelWrites.create).toHaveBeenCalledOnce();
  expect(test.messages.send).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "applies section defaults before first send; failed setup still opens the chat (failure=%s)",
  async (failure) => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const test = setup();
      const sequence: string[] = [];
      const onStarted = vi.fn();
      const id = await projectTemplateId("work");
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
        soloPreferences: {
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
      writeView(
        "test",
        "solo:project:work:new-draft",
        taggedDraft("Build this"),
      );
      render(
        <SoloDraft
          session={test.session}
          scope="test"
          projectId="work"
          onStarted={onStarted}
        />,
      );
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("textbox", { name: "Message your agents" }),
      );
      await user.keyboard("{Enter}");
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      expect(test.channelWrites.create).toHaveBeenCalledOnce();
      expect(sequence).toEqual(
        failure ? ["canvas", "send"] : ["canvas", "placement", "send"],
      );
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
  test.channelWrites.delivered.mockRejectedValueOnce(
    new Error("Unknown creation"),
  );
  const onStarted = vi.fn();
  const user = userEvent.setup();
  const view = (focusRequest: number | AbortSignal = 0) => (
    <SoloDraft
      focusRequest={focusRequest}
      session={test.session}
      scope="test"
      onStarted={onStarted}
    />
  );
  let mounted = render(view());
  await user.click(screen.getByRole("button", { name: "Chat settings" }));
  const canvas = await screen.findByRole("textbox", { name: /^Instructions/ });
  expect(canvas).toHaveValue("");
  await user.clear(canvas);
  await user.type(canvas, "Keep the change small");
  await user.click(screen.getByRole("radio", { name: /^Temporary/ }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Chat settings" })).toHaveFocus(),
  );
  expect(screen.queryByRole("menu")).toBeNull();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  expect(saveCanvas).not.toHaveBeenCalled();
  mounted.unmount();
  mounted = render(view(1));
  const composer = screen.getByRole("textbox", {
    name: "Message your agents",
  });
  expect(composer).toHaveFocus();
  const actions = screen.getByRole("button", { name: "Chat settings" });
  actions.focus();
  expect(actions).toHaveFocus();
  mounted.rerender(view(new AbortController().signal));
  expect(composer).toHaveFocus();
  await user.type(composer, "Build this");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unknown creation",
  );
  expect(test.channelWrites.create.mock.calls[0]?.[2]).toBe(604800);
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(test.channelWrites.create).toHaveBeenCalledOnce();
  expect(saveCanvas).toHaveBeenCalledWith(
    expect.any(String),
    "Keep the change small",
    undefined,
  );
  expect(order).toEqual(["canvas", "send"]);
});

it("a new Solo chat for a named agent starts tagged with it, not the default", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const agent = "b".repeat(64);
  render(
    <SoloDraft
      agent={agent}
      session={f.session}
      scope="me-route-agent"
      onStarted={started}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input).toHaveTextContent("@Outside agent"));
  expect(input).not.toHaveTextContent("@Member agent");
  await user.type(input, "Hello");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const [id] = started.mock.calls[0] ?? [];
  expect(f.messages.send).toHaveBeenCalledExactlyOnceWith(
    id,
    expect.stringContaining("Hello"),
    [agent],
  );
});

it("a new Solo chat needs a tagged agent to send", async () => {
  const f = setup();
  const user = userEvent.setup();
  render(
    <SoloDraft session={f.session} scope="me-untagged" onStarted={vi.fn()} />,
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.value = "Start here";
  fireEvent.input(input);
  await user.keyboard("{Enter}");
  const form = input.closest("form");
  if (!form) throw new Error("Missing composer form");
  fireEvent.submit(form);
  expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(f.channelWrites.create).not.toHaveBeenCalled();
});

it("opens and saves local draft settings in a fresh Solo project after a failed initial read", async () => {
  vi.stubGlobal("crypto", webcrypto);
  try {
    const f = setup();
    const refreshSolo = vi.fn(async () => {});
    refreshSolo.mockRejectedValueOnce(new Error("Settings unavailable"));
    Object.assign(f.session, {
      soloPreferences: {
        writable: true,
        refresh: refreshSolo,
        snapshot: () => ({
          status: "ready",
          data: {
            sections: [{ id: "solo-only", name: "Work" }],
            assignments: {},
          },
        }),
      },
      channelKit: {
        refresh: async () => {},
        snapshot: () => ({ status: "ready", entries: [] }),
      },
    });
    const view = () => (
      <SoloDraft
        session={f.session}
        scope="solo-settings"
        projectId="solo-only"
        onStarted={() => {}}
      />
    );
    const user = userEvent.setup();
    const mounted = render(view());
    const open = async () => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
    };
    await open();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings unavailable",
    );
    expect(screen.queryByText("Loading settings…")).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshSolo.mockImplementationOnce(() => held);
    try {
      await user.click(screen.getByRole("button", { name: "Retry settings" }));
      await waitFor(() => expect(refreshSolo).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("status")).toHaveTextContent("Loading settings…");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await user.type(
      await screen.findByRole("textbox", { name: /^Instructions/ }),
      "Keep this Solo draft",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(refreshSolo).toHaveBeenCalledTimes(2);
    mounted.unmount();
    render(view());
    await open();
    expect(
      await screen.findByRole("textbox", { name: /^Instructions/ }),
    ).toHaveValue("Keep this Solo draft");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(f.channelWrites.create).not.toHaveBeenCalled();
    expect(f.messages.send).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("invalid stored draft lifetime fails visibly without a new create", async () => {
  const h = setup();
  writeView("test", "solo:new-draft", taggedDraft("Keep this draft"));
  writeView("test", "solo:settings", { canvas: "", ttlSeconds: -1 });
  const user = userEvent.setup();
  render(<SoloDraft session={h.session} scope="test" onStarted={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "duration could not be verified",
  );
  expect(h.channelWrites.create).not.toHaveBeenCalled();
  expect(h.channelWrites.delivered).not.toHaveBeenCalled();
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
          id: await projectTemplateId(id),
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
  const assign = vi.fn(async (_id: string, _sectionId?: string) => {});
  Object.assign(f.session, {
    soloPreferences: {
      writable: true,
      refresh: async () => {},
      snapshot: () => preferences,
      subscribe: () => () => {},
      assign,
    },
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries }),
    },
    canvas: { read: async () => undefined, save: saveCanvas },
  });
  return { ...f, saveCanvas, assign };
}

it("re-entering a mounted project clears changed defaults", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const scope = "project-reset";
  const key = "solo:project:work";
  writeView(scope, `${key}:new-project`, "other");
  writeView(scope, `${key}:settings`, "other edited instructions");
  render(
    <SoloDraft
      projectId="work"
      session={f.session}
      scope={scope}
      onStarted={started}
    />,
  );
  expect(screen.getByRole("button", { name: "Project: Other" })).toBeVisible();
  act(() => resetNewChatProject(scope, "work"));
  expect(
    await screen.findByRole("button", { name: "Project: Work" }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Chat settings" }));
  expect(
    await screen.findByRole("textbox", { name: /^Instructions/ }),
  ).toHaveValue("work instructions");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.type(screen.getByRole("textbox"), "Start in Work");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.assign).toHaveBeenCalledWith(expect.any(String), "work");
  expect(f.saveCanvas).toHaveBeenCalledWith(
    expect.any(String),
    "work instructions",
    undefined,
  );
});

it("keeps a locally chosen project when its persistence fails and other draft writes succeed", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const user = userEvent.setup();
  const scope = "project-write-failure";
  const key = `buzz-view.v1:${JSON.stringify([scope, "solo:project:work:new-project"])}`;
  const setItem = Storage.prototype.setItem;
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new Error("Storage unavailable");
      setItem.call(this, name, value);
    });
  try {
    render(
      <SoloDraft
        projectId="work"
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
    expect(f.assign).toHaveBeenCalledWith(expect.any(String), "other");
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
      <SoloDraft
        session={f.session}
        scope="repeat-project"
        projectId="work"
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
  expect(f.channelWrites.create.mock.calls[0]?.[0]).not.toBe(
    f.channelWrites.create.mock.calls[1]?.[0],
  );
});

it.each([
  { saved: true, remount: true, fromProject: true },
  { saved: false, remount: false, fromProject: false },
])(
  "switching projects uses new defaults and retains independent naming/lifetime (saved=$saved, remount=$remount, fromProject=$fromProject)",
  async ({ saved, remount, fromProject }) => {
    const f = await projectSetup();
    const user = userEvent.setup();
    const started = vi.fn();
    const draftKey = fromProject ? "solo:project:work" : "solo";
    writeView("switch-project", `${draftKey}:settings`, {
      name: "My chosen title",
      ttlSeconds: 600,
    });
    const view = () => (
      <SoloDraft
        session={f.session}
        scope="switch-project"
        projectId={fromProject ? "work" : undefined}
        onStarted={started}
      />
    );
    const mounted = render(view());
    const openSettings = async () => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
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
        name: fromProject ? "Project: Work" : "Add project",
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
      screen.getByRole("textbox", { name: "Chat name (optional)" }),
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
    expect(f.assign).toHaveBeenCalledWith(expect.any(String), "other");
    expect(f.channelWrites.create).toHaveBeenCalledWith(
      expect.any(String),
      "My chosen title",
      600,
      true,
    );
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
  writeView(
    "unavailable-agent",
    "solo:new-draft",
    taggedDraft("Keep my draft", "b".repeat(64), "Outside agent"),
  );
  render(
    <SoloDraft
      session={f.session}
      scope="unavailable-agent"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(
    "Only your available agents can be mentioned in Solo chats. Remove the unavailable recipient and retry.",
  );
  expect(f.channelWrites.create).not.toHaveBeenCalled();
  cleanup();
  writeView(
    "unavailable-agent",
    "solo:new-draft",
    taggedDraft("Keep my draft"),
  );
  render(
    <SoloDraft
      session={f.session}
      scope="unavailable-agent"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.messages.send).toHaveBeenCalledWith(
    expect.any(String),
    "@Member agent Keep my draft",
    ["a".repeat(64)],
  );
});

it.each([{ fields: { name: 7 } }, { fields: { name: "x".repeat(121) } }])(
  "rejects malformed persisted naming before start side effects: $fields",
  async ({ fields }) => {
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
      soloPreferences: {
        refresh: refreshPreferences,
        snapshot: () => ({
          data: { sections: [{ id: "work", name: "Work" }] },
        }),
      },
      canvas: { read: readCanvas, save: saveCanvas },
      agentChoices: { ...h.session.agentChoices, refresh: refreshAgents },
    });
    const key = "solo:project:work";
    writeView("test", `${key}:new-draft`, taggedDraft("Keep this draft"));
    writeView("test", `${key}:settings`, fields);
    render(
      <SoloDraft
        session={h.session}
        scope="test"
        projectId="work"
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
      h.channelWrites.create,
      h.channelWrites.delivered,
      h.channelWrites.refresh,
      h.channelWrites.addAgents,
      h.messages.send,
      started,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])(
  "naming crosses the real composer → creation/outbox boundary with frozen intent (explicit=%s)",
  async (explicit) => {
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
    writeView("real-creation", "solo:settings", {
      name: explicit ? "Chosen title" : "",
      ttlSeconds: 600,
    });
    writeView(
      "real-creation",
      "solo:new-draft",
      taggedDraft("Original prompt", viewer.pubkey, "Viewer"),
    );
    let observed = outbox.outbox.snapshot();
    let channelList = {
      status: "ready" as const,
      channels: [] as {
        id: string;
        name: string;
        channelType: "solo";
        creator: string;
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
                channelType: "solo",
                creator: viewer.pubkey,
                members: [viewer.pubkey],
              })),
          };
        }
        return channelList;
      },
    };
    const authority = keypair();
    const channelWrites = createChannelWrites(
      outbox.outbox,
      channels,
      {
        read: async (filters) =>
          filters.flatMap((filter) =>
            filter.kinds?.includes(39002)
              ? [
                  signed(authority, {
                    kind: 39002,
                    content: "",
                    created_at: 1,
                    tags: [
                      ["d", filter["#d"]?.[0] ?? ""],
                      ["p", viewer.pubkey],
                    ],
                  }),
                ]
              : [],
          ),
      },
      lifetime.signal,
      undefined,
      undefined,
      undefined,
      authority.pubkey,
      undefined,
      true,
    );
    const eligible = {
      ...h.session.agentChoices.snapshot(),
      selectable: [{ pubkey: viewer.pubkey, name: "Viewer", managed: true }],
    };
    const session = {
      ...h.session,
      agentChoices: { ...h.session.agentChoices, snapshot: () => eligible },
      viewer: viewer.pubkey,
      channels,
      channelWrites,
      messages: {
        ...h.session.messages,
        send: (id: string, text: string, recipients: readonly string[] = []) =>
          outbox.outbox.send({
            kind: 9,
            content: text,
            tags: [["h", id], ...recipients.map((key) => ["p", key])],
          }),
      },
    } as RelaySession;
    const started = vi.fn();
    const mounted = render(
      <SoloDraft session={session} scope="real-creation" onStarted={started} />,
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
      expect(created?.tags).toContainEqual(["t", SOLO_LABEL]);
      expect(created?.tags.some(([key]) => key === "about")).toBe(false);
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

it("starts a new chat with a session card and no caption", async () => {
  const h = setup(),
    started = vi.fn(),
    user = userEvent.setup();
  const link = "[Session: Fix](buzz://channel/session-id)";
  writeView("test", "solo:new-draft", taggedDraft(link));
  render(<SoloDraft session={h.session} scope="test" onStarted={started} />);
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toBeEnabled();
  await user.click(send);
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(h.channelWrites.create).toHaveBeenCalledOnce();
  expect(h.messages.send).toHaveBeenCalledWith(
    h.channelWrites.create.mock.calls[0]?.[0],
    expect.stringContaining(link),
    ["a".repeat(64)],
  );
});

it("starting titles omit structured leading tags but retain literal @ text", async () => {
  const f = setup();
  const content = "@Literal investigate this";
  writeView("clean-title", "solo:new-draft", taggedDraft(content));
  render(
    <SoloDraft session={f.session} scope="clean-title" onStarted={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(f.messages.send).toHaveBeenCalledOnce());
  expect(f.channelWrites.create.mock.calls[0]?.[1]).toBe(content);
});

it.each(["remember", "off", "storage-failure"])(
  "first Solo send transfers all tagged agents into the saved chat draft (%s)",
  async (mode) => {
    const { readView } = await import("../../shared/view-state");
    const { setRememberAgentsPreference } = await import(
      "../messages/mention-preferences"
    );
    const { followupDraft } = await import("../messages/mention-draft");
    const f = setup();
    const recipients = [
      { pubkey: "a".repeat(64), name: "Member agent" },
      { pubkey: "b".repeat(64), name: "Outside agent" },
    ];
    const tags = followupDraft(recipients);
    writeView("first-followup", "solo:new-draft", {
      ...tags,
      text: `${tags.text}Start here`,
    });
    if (mode === "off") setRememberAgentsPreference(false);
    const setItem = Storage.prototype.setItem;
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (mode === "storage-failure" && key.includes('"draft:'))
          throw new Error("Storage unavailable");
        setItem.call(this, key, value);
      });
    const started = vi.fn();
    render(
      <SoloDraft
        session={f.session}
        scope="first-followup"
        onStarted={started}
      />,
    );
    try {
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      if (mode === "storage-failure") {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "message couldn’t be saved",
        );
        expect(started).not.toHaveBeenCalled();
        storage.mockRestore();
        await userEvent.click(
          screen.getByRole("button", { name: "Send message" }),
        );
      }
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      expect(f.messages.send).toHaveBeenCalledOnce();
      expect(f.channelWrites.create).toHaveBeenCalledOnce();
      const id = started.mock.calls[0]?.[0];
      expect(readView("first-followup", `draft:${id}`, null)).toEqual(
        mode === "off" ? { text: "", recipients: [] } : tags,
      );
      expect(f.messages.send.mock.calls[0]?.[2]).toEqual(
        recipients.map((r) => r.pubkey),
      );
    } finally {
      storage.mockRestore();
      setRememberAgentsPreference(true);
    }
  },
);
