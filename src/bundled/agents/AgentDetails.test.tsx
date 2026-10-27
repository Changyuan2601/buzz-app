// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useId, useState } from "react";
import type {
  Agent,
  Agents,
  AgentViewProps,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { CommunityReader } from "../../features/communities/service";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { Input } from "../../shared/design-system/ui/Input";
import { AgentDetails } from "./AgentDetails";

afterEach(cleanup);

function Settings({ agent, save }: AgentViewProps<{ reply: string }>) {
  const form = useId();
  const [saved, setSaved] = useState(agent.config.reply);
  const [reply, setReply] = useState(saved);
  const [saving, setSaving] = useState(false);
  return (
    <form
      id={form}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await save({ reply });
          setSaved(reply);
        } finally {
          setSaving(false);
        }
      }}
    >
      <Input aria-label="Reply" value={reply} onValueChange={setReply} />
      <AgentSaveButton form={form} disabled={reply === saved} saving={saving} />
    </form>
  );
}

it("shows every affected community with unsaved shared settings and submits the portaled Save", async () => {
  const user = userEvent.setup();
  const agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    owner: "f".repeat(64),
    name: "Ada",
    type: "test/echo",
    place: "here",
    relay: "wss://current.example",
    config: { reply: "Hello" },
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: true,
  } satisfies Agent;
  const type = {
    key: agent.type,
    pluginId: "test",
    revision: "1",
    id: "echo",
    title: "Echo",
    defaults: () => ({ config: {} }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: Settings,
      },
    ],
  } as RegisteredAgentType;
  let finish!: () => void;
  const saving = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const agents = {
    save: vi.fn(() => saving),
    memberships: () => [
      { key: agent.key, origin: "https://current.example", connected: true },
      { key: "other", origin: "wss://other.example", connected: false },
      { key: "unknown", origin: "https://unknown.example", connected: true },
      {
        key: "leaving",
        origin: "https://leaving.example",
        connected: true,
        deleting: true,
      },
    ],
  } as unknown as Agents;
  let known = {
    memberships: [
      {
        id: "https://other.example",
        name: "Feedback",
        icon: "https://images.example/pollen.png",
      },
      {
        id: "https://current.example",
        name: "Current",
        icon: "https://images.example/current.png",
      },
    ],
  };
  const listeners = new Set<() => void>();
  const communities = {
    snapshot: () => known,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as CommunityReader;
  const view = render(
    <AgentDetails
      agents={agents}
      agent={agent}
      type={type}
      types={[type]}
      channels={[]}
      memories={undefined}
      communities={communities}
      onRemoved={() => {}}
      messageAction={() => null}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("Changes apply in").closest("[inert]"),
  ).toHaveAttribute("aria-hidden", "true");
  const field = screen.getByRole("textbox", { name: "Reply" });
  await user.type(field, "!");
  expect(field).toHaveFocus();
  const badge = screen.getByText("Changes apply in");
  expect(badge).toHaveTextContent("Current, Feedback, unknown.example");
  expect(badge).not.toHaveTextContent("leaving");
  expect(
    Array.from(badge.querySelectorAll("img"), (image) =>
      image.getAttribute("src"),
    ),
  ).toEqual([
    "https://images.example/current.png",
    "https://images.example/pollen.png",
  ]);
  act(() => {
    known = {
      memberships: [
        {
          id: "https://other.example",
          name: "Feedback",
          icon: "javascript:alert(1)",
        },
      ],
    };
    for (const listener of listeners) listener();
  });
  expect(badge.querySelector("img")).toBeNull();
  await user.click(badge);
  const popover = await screen.findByRole("dialog", {
    name: "Ada’s shared settings",
  });
  expect(popover).toHaveTextContent(
    "Name, type and settings, including instructions, model and workspace, are shared across communities.",
  );
  expect(popover).toHaveTextContent("Feedback");
  expect(popover).toHaveTextContent("current.example");
  expect(popover).toHaveTextContent("unknown.example");
  const memberships = vi.spyOn(agents, "memberships").mockReturnValue([
    { key: "other", origin: "wss://other.example", connected: false },
    { key: agent.key, origin: "https://current.example", connected: true },
  ]);
  act(() => {
    known = { ...known };
    for (const listener of listeners) listener();
  });
  expect(popover).toHaveTextContent(
    "Name, type and settings, including instructions, model and workspace, are shared across communities.",
  );
  expect(within(popover).getAllByRole("listitem")[0]).toHaveTextContent(
    "current.example",
  );
  await user.keyboard("{Escape}");
  try {
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(agents.save).toHaveBeenCalledWith(agent.key, {
      config: { reply: "Hello!" },
    });
    expect(screen.getByRole("button", { name: /Saving/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(badge).toBeInTheDocument();
  } finally {
    await act(async () => {
      finish();
      await saving;
    });
  }
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  // Hidden footer contents are removed from pointer and keyboard interaction.
  expect(badge.closest("[inert]")).toHaveAttribute("aria-hidden", "true");
  await user.click(screen.getByRole("tab", { name: "Memory" }));
  expect(
    screen.queryByText("Memories stay in this community."),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Changes apply in")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(
    screen.queryByText("Memories stay in this community."),
  ).not.toBeInTheDocument();
  // A single remaining community needs no shared-settings notice.
  memberships.mockReturnValue([
    { key: agent.key, origin: "https://current.example", connected: true },
    {
      key: "leaving",
      origin: "https://leaving.example",
      connected: true,
      deleting: true,
    },
  ]);
  act(() => {
    known = { ...known };
    for (const listener of listeners) listener();
  });
  await user.type(screen.getByRole("textbox", { name: "Reply" }), "?");
  expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  expect(screen.queryByText("Changes apply in")).not.toBeInTheDocument();
  view.unmount();
  expect(listeners.size).toBe(0);
});

it("retains the inline save action outside an agent pane", () => {
  const view = render(
    <AgentSaveButton form="settings" disabled saving={false} />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(
    <AgentSaveButton form="settings" disabled={false} saving={false} />,
  );
  expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
    "form",
    "settings",
  );
});
