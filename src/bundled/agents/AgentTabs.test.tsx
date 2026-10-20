// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentMemories } from "../../features/agents/memory";
import type {
  Agent,
  Agents,
  AgentViewProps,
  RegisteredAgentType,
} from "../../features/agents/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentTabs } from "./AgentTabs";

afterEach(cleanup);

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

it("lets a split type's Identity half open the Settings tab", async () => {
  const user = userEvent.setup();
  const agent: Agent = {
    pubkey: "a".repeat(64),
    name: "Ada",
    place: "hosted",
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
      type={
        {
          tabs: [
            {
              id: "settings",
              title: "Settings",
              role: "settings",
              splitSettings: true,
              component: ({
                settingsSection,
                showRuntimeSettings,
              }: AgentViewProps) =>
                settingsSection === "identity" ? (
                  <button type="button" onClick={showRuntimeSettings}>
                    Set up the provider
                  </button>
                ) : (
                  <p>Provider key</p>
                ),
            },
          ],
        } as unknown as RegisteredAgentType
      }
      channels={[]}
      memories={undefined}
      settingsHost={{}}
      settingsContent={<p>Agent settings</p>}
    />,
    { wrapper: ToastProvider },
  );
  await user.click(screen.getByRole("button", { name: "Set up the provider" }));
  const settings = screen.getByRole("tab", { name: "Settings" });
  expect(settings).toHaveAttribute("aria-selected", "true");
  expect(settings).toHaveFocus();
  expect(screen.getByText("Provider key")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Set up the provider" }),
  ).toBeNull();
});
