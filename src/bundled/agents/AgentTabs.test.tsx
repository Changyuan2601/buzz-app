// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentMemories } from "../../features/agents/memory";
import type {
  Agent,
  Agents,
  AgentViewProps,
  RegisteredAgentType,
} from "../../features/agents/service";
import { useId, useState } from "react";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentTabs } from "./AgentTabs";
import { useAgentSettingsHost } from "./AgentSettingsHost";

afterEach(cleanup);

function DraftSettings({
  agent,
  save,
  settingsSection,
  settingsHost,
}: AgentViewProps<{ reply: string }>) {
  const form = useId();
  const [value, setValue] = useState(agent.config.reply);
  const [saved, setSaved] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      id={form}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          await save({ reply: value });
          setSaved(value);
        } catch {
          setError("Save failed");
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        {settingsSection === "runtime" ? "Workspace" : "Instructions"}
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <AgentSaveButton
        form={form}
        disabled={
          value === "Invalid" || (value === saved && !settingsHost?.pendingSave)
        }
        dirty={value !== saved || Boolean(settingsHost?.pendingSave)}
        saving={saving}
      />
    </form>
  );
}

function editingFixture(split: boolean, save = vi.fn(async () => {})) {
  const agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    name: "Ada",
    place: "here",
    type: "test",
    owner: "c".repeat(64),
    relay: "wss://example.com",
    config: { reply: "Saved" },
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  } satisfies Agent;
  const type = {
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: split,
        component: DraftSettings,
      },
    ],
  } as unknown as RegisteredAgentType;
  const props = {
    agents: {
      save,
      subscribe: () => () => {},
      classifier: () => "unavailable",
    } as unknown as Agents,
    agent,
    type,
    channels: [],
    settingsHost: {},
    memories: undefined,
    settingsContent: <p>Agent settings</p>,
  };
  return { props, save };
}

it.each([false, true])(
  "confirms before discarding a section draft (split %s)",
  async (split) => {
    const user = userEvent.setup();
    const { props, save } = editingFixture(split);
    const discard = vi.fn();
    render(<AgentTabs {...props} onDiscard={discard} />);
    await user.type(
      screen.getByRole("textbox", { name: "Instructions" }),
      " draft",
    );
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "unsaved changes will be lost",
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("textbox")).toHaveValue("Saved draft");
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("textbox")).toHaveValue("Saved draft");
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(discard).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.getByRole("textbox")).toHaveValue("Saved");
    if (split) {
      await user.type(screen.getByRole("textbox"), " again");
      await user.click(screen.getByRole("tab", { name: "Settings" }));
      await user.click(screen.getByRole("button", { name: "Discard changes" }));
      expect(screen.getByRole("textbox", { name: "Workspace" })).toHaveValue(
        "Saved",
      );
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    }
  },
);

it("warns before discarding edits even when validation disables Save", async () => {
  const user = userEvent.setup();
  const { props } = editingFixture(true);
  render(<AgentTabs {...props} />);
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "Invalid");
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("textbox")).toHaveValue("Invalid");
});

it("keeps a saving section mounted, then permits discarding after a failed save", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const { props } = editingFixture(
    true,
    vi.fn(() => pending),
  );
  render(<AgentTabs {...props} />);
  await user.type(screen.getByRole("textbox"), " draft");
  await user.click(screen.getByRole("button", { name: "Save" }));
  try {
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    expect(screen.getByRole("textbox")).toHaveValue("Saved draft");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  } finally {
    await act(async () => {
      reject(new Error("Save failed"));
    });
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
});

it.each(["switch", "remove"])(
  "keeps Attention mounted when a %s save rejects",
  async (action) => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const { props, save } = editingFixture(
      false,
      vi.fn(() => pending),
    );
    render(
      <AgentTabs
        {...props}
        agent={{
          ...props.agent,
          skipped: {
            "watch/bad": {
              slug: "watch/bad",
              value: {},
              modifiedAt: 1,
              problem: "Unreadable object",
            },
          },
        }}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Attention" }));
    await user.click(
      action === "switch"
        ? screen.getByRole("switch", { name: "Attention on" })
        : screen.getByRole("button", { name: "Remove watch/bad" }),
    );
    expect(save).toHaveBeenCalledOnce();
    try {
      expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await user.click(screen.getByRole("tab", { name: "Memory" }));
      expect(screen.getByRole("tab", { name: "Attention" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    } finally {
      await act(async () => reject(new Error("Attention save failed")));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Attention save failed",
    );
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  },
);

it("discards a staged harness change together with the section draft", async () => {
  const user = userEvent.setup();
  const { props } = editingFixture(false);
  const type = { ...props.type, key: "test", title: "Original" };
  // The source form exposes the host's harness selector alongside its draft.
  type.tabs = [
    {
      id: "settings",
      title: "Settings",
      role: "settings",
      component: ({ settingsHost }) => (
        <>{settingsHost?.typeControl?.(false)}</>
      ),
    },
  ];
  const next = { ...type, key: "next", title: "Next" };
  const retype = vi.fn();
  const agents = {
    ...props.agents,
    retype,
    previewRetype: () => ({ config: {}, moved: [], dropped: [], settings: [] }),
  } as unknown as Agents;
  function Host() {
    const settings = useAgentSettingsHost({
      agents,
      agent: props.agent,
      type,
      types: [type, next],
    });
    return (
      <AgentTabs
        {...props}
        agents={agents}
        agent={settings.agent}
        type={settings.type}
        settingsHost={settings.settingsHost}
        onDiscard={settings.discard}
      />
    );
  }
  render(<Host />);
  await user.click(
    screen.getByRole("button", { name: "Change harness from Original" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    screen.getByRole("button", { name: "Change harness from Next" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(
    screen.getByRole("button", { name: "Change harness from Next" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(
    screen.getByRole("button", { name: "Change harness from Original" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(retype).not.toHaveBeenCalled();
});

it.each(["here", "hosted"] as const)(
  "releases Memory on leaving and reads fresh memories on return for agents %s",
  async (place) => {
    const user = userEvent.setup();
    let body = "Original memory";
    const read = vi.fn(async () => ({
      entries: [{ slug: "core", body, eventId: "b".repeat(64), createdAt: 1 }],
      partial: false,
    }));
    const owner = createAgentMemories(read, "c".repeat(64), () => true);
    const agent: Agent = {
      key: "a".repeat(64),
      pubkey: "a".repeat(64),
      name: "Ada",
      place,
      type: "test",
      owner: "c".repeat(64),
      relay: "wss://example.com",
      config: {},
      attention: {},
      skipped: {},
      timers: {},
      attentionEnabled: true,
    };
    render(
      <AgentTabs
        agents={{ save: vi.fn() } as unknown as Agents}
        agent={agent}
        type={undefined}
        channels={[]}
        memories={owner.capability}
        settingsHost={{ typeControl: () => <p>Provider</p> }}
        settingsContent={<p>Agent settings</p>}
      />,
      { wrapper: ToastProvider },
    );
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Attention" }) !== null).toBe(
      place === "here",
    );
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    expect(await screen.findByText("Original memory")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.queryByText("Original memory")).not.toBeInTheDocument();
    // All four session slots are available again while Memory is inactive.
    const otherViews = [];
    try {
      for (let index = 0; index < 4; index++) {
        otherViews.push(owner.capability.open(agent.pubkey));
      }
      expect(otherViews).toHaveLength(4);
    } finally {
      for (const view of otherViews) view.dispose();
    }
    body = "Updated memory";
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    expect(await screen.findByText("Updated memory")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Original memory")).not.toBeInTheDocument();
  },
);
