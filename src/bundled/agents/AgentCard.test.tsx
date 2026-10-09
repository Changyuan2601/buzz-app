// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { npubEncode } from "nostr-tools/nip19";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { PresenceStatus } from "../../features/presence/presence";
import type { AgentView } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { AgentCard } from "./AgentCard";

afterEach(cleanup);

it("badges a single agent only while live presence is known", () => {
  const pubkey = "a".repeat(64);
  let status: PresenceStatus = "unknown";
  let changed = () => {};
  const session = {
    presence: {
      status: () => status,
      limited: () => false,
      subscribe: (_key: string, listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
  } as unknown as RelaySession;
  render(
    <AgentCard
      name="Agent"
      avatar="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5qV8AAAAASUVORK5CYII="
      identities={[{ pubkey, name: "Agent" }]}
      session={session}
    />,
  );
  const artwork = screen.getByRole("img", { name: "Agent" });
  expect(artwork.querySelector("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  const image = artwork.querySelector("img");
  expect(image).toBeTruthy();
  fireEvent.load(image as HTMLImageElement);
  expect(image).toHaveAttribute("data-loaded", "true");
  expect(artwork.querySelector(".buzz-avatar-status")).not.toHaveAttribute(
    "data-status",
  );
  for (const next of ["online", "away", "offline", "unknown"] as const) {
    act(() => {
      status = next;
      changed();
    });
    const updated = screen.getByRole("img", {
      name:
        next === "unknown"
          ? "Agent"
          : `Agent, ${next === "online" ? "available" : next}`,
    });
    const badge = updated.querySelector(".buzz-avatar-status");
    expect(updated).toBe(artwork);
    expect(updated.querySelector("img")).toBe(image);
    expect(image).toHaveAttribute("data-loaded", "true");
    if (next === "unknown") {
      expect(badge).not.toHaveAttribute("data-status");
      expect(badge?.querySelector(".buzz-avatar-status-dot")).toBeNull();
    } else if (next === "online") {
      expect(updated.querySelector(".badge-pill-ink")).toHaveStyle({
        visibility: "visible",
      });
    } else {
      expect(badge).toHaveAttribute("data-status", next);
    }
  }
});

it("re-reads presence after native start or stop until the badge agrees, within a bound", () => {
  vi.useFakeTimers();
  try {
    const agent = controlFixture().agent;
    let status: PresenceStatus = "offline";
    let changed = () => {};
    const refresh = vi.fn();
    const session = {
      presence: {
        status: () => status,
        limited: () => false,
        refresh,
        subscribe: (_key: string, listener: () => void) => {
          changed = listener;
          return () => {};
        },
      },
    } as unknown as RelaySession;
    const card = (next: AgentView) => (
      <AgentCard
        name="Agent"
        identities={[next]}
        editable={[next]}
        session={session}
        onEdit={() => {}}
      >
        <p>{next.status}</p>
      </AgentCard>
    );
    const view = render(card({ ...agent, status: "stopped" }));
    expect(refresh).not.toHaveBeenCalled();
    view.rerender(card({ ...agent, status: "running" }));
    expect(refresh).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(30000));
    expect(refresh).toHaveBeenCalledTimes(7);
    act(() => vi.advanceTimersByTime(60000));
    expect(refresh).toHaveBeenCalledTimes(7);

    view.rerender(card({ ...agent, status: "stopped" }));
    view.rerender(card({ ...agent, status: "running" }));
    expect(refresh).toHaveBeenCalledTimes(8);
    act(() => {
      status = "online";
      changed();
    });
    act(() => vi.advanceTimersByTime(30000));
    expect(refresh).toHaveBeenCalledTimes(8);

    view.rerender(card({ ...agent, status: "stopped" }));
    expect(refresh).toHaveBeenCalledTimes(9);
    act(() => {
      status = "offline";
      changed();
    });
    act(() => vi.advanceTimersByTime(30000));
    expect(refresh).toHaveBeenCalledTimes(9);
  } finally {
    vi.useRealTimers();
  }
});

it("reserves card-header space for a profile-only menu", () => {
  render(
    <AgentCard
      layout="row"
      name="A very long relay-only identity name"
      identities={[{ pubkey: "ab".repeat(32), name: "Agent" }]}
      onViewProfile={() => {}}
    >
      <p>Relay-only identity</p>
    </AgentCard>,
  );

  expect(
    screen.getByRole("heading", { level: 3 }).parentElement?.parentElement,
  ).toHaveClass("pr-6");
});

it("hands focus from the menu to the opened profile", async () => {
  render(
    <AgentCard
      name="Agent"
      identities={[{ pubkey: "ab".repeat(32), name: "Agent" }]}
      onViewProfile={() => {
        const panelButton = document.createElement("button");
        panelButton.textContent = "Profile action";
        document.body.append(panelButton);
        panelButton.focus();
      }}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Actions for Agent" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "View profile" }),
  );

  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Profile action" }),
    ).toHaveFocus(),
  );
});

it("opens identities in a popover and returns focus on Escape", async () => {
  const user = userEvent.setup();
  const pubkey = "ab".repeat(32);
  render(<AgentCard name="Agent" identities={[{ pubkey, name: "Agent" }]} />);
  const trigger = screen.getByRole("button", { name: "Actions for Agent" });
  expect(screen.queryByText(npubEncode(pubkey))).toBeNull();
  const card = screen.getByRole("article");
  await user.click(trigger);
  const popup = await screen.findByRole("dialog", {
    name: "Agent identity details",
  });
  expect(card).not.toContainElement(popup);
  expect(screen.getByText(npubEncode(pubkey))).toBeVisible();
  expect(document.body.textContent).not.toContain(pubkey);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});

it("keeps the exact identity label and row heading in the final card shell", () => {
  render(
    <AgentCard name="Solo" identities={[]} layout="row" headingLevel={4} />,
  );
  expect(screen.getByRole("article", { name: "Agent Solo" })).toHaveClass(
    "agent-inventory-row",
  );
  expect(screen.getByRole("heading", { level: 4, name: "Solo" })).toBeVisible();
});

it("keeps archive feedback visible and management outside the tile", async () => {
  const user = userEvent.setup();
  render(
    <AgentCard
      name="Agent"
      identities={[{ pubkey: "ab".repeat(32), name: "Agent" }]}
      archived
      archive={{ archived: true, pending: false, onSelect() {} }}
      feedback={<p role="alert">Archive failed</p>}
    >
      <button type="button">Stop</button>
    </AgentCard>,
  );
  expect(screen.getByText("Archived")).toBeVisible();
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  const card = screen.getByRole("article");
  expect(card.querySelector("details")).toBeNull();
  const trigger = screen.getByRole("button", { name: "Manage Agent" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Manage Agent" });
  expect(card).not.toContainElement(dialog);
  expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});

it("opens the profile from the tile without opening its separate management controls", async () => {
  const user = userEvent.setup();
  const profile = vi.fn();
  render(
    <AgentCard
      name="Agent"
      identities={[{ pubkey: "ab".repeat(32), name: "Agent" }]}
      onViewProfile={profile}
    >
      <button type="button">Stop</button>
    </AgentCard>,
  );
  const tile = screen.getByRole("button", { name: "View profile for Agent" });
  await user.click(tile);
  expect(profile).toHaveBeenLastCalledWith(tile);
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.keyboard("{Enter}");
  await user.keyboard(" ");
  expect(profile).toHaveBeenCalledTimes(3);
  await user.click(screen.getByRole("button", { name: "Actions for Agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Manage agent" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Manage Agent" }),
  ).toBeVisible();
  expect(profile).toHaveBeenCalledTimes(3);
  await user.keyboard("{Escape}");
  expect(
    screen.getByRole("button", { name: "Actions for Agent" }),
  ).toHaveFocus();
});

it("returns to persistent Actions when Review disappears while Manage is open", async () => {
  const user = userEvent.setup();
  const card = (revealControls: boolean) => (
    <AgentCard name="Agent" identities={[]} revealControls={revealControls}>
      <button type="button">Start</button>
    </AgentCard>
  );
  const view = render(card(true));
  const review = screen.getByRole("button", { name: "Review agent status" });
  await user.click(review);
  await screen.findByRole("dialog", { name: "Manage Agent" });
  view.rerender(card(false));
  expect(review).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(
    screen.getByRole("button", { name: "Actions for Agent" }),
  ).toHaveFocus();
});

it.each(["tile", "row"] as const)(
  "focuses a persistent %s surface on import, not on later updates",
  async (layout) => {
    const card = (imported: boolean) => (
      <AgentCard
        name="Agent"
        identities={[]}
        layout={layout}
        imported={imported}
        revealControls={imported}
        onEdit={() => {}}
      >
        <button type="button">Start</button>
      </AgentCard>
    );
    const view = render(card(false));
    const scroll = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      view.rerender(card(true));
      const target = screen.getByRole("button", {
        name: layout === "tile" ? "Review agent status" : "Actions for Agent",
      });
      expect(target).toHaveFocus();
      expect(scroll).toHaveBeenCalledOnce();
      target.blur();
      view.rerender(card(true));
      expect(target).not.toHaveFocus();
      expect(scroll).toHaveBeenCalledOnce();
    } finally {
      HTMLElement.prototype.scrollIntoView = previous;
    }
  },
);

it("routes a managed card Share directly from its menu without a separate Export", async () => {
  const agent = controlFixture().agent;
  const share = vi.fn();
  render(
    <AgentCard
      name="Managed"
      identities={[agent]}
      editable={[agent]}
      onEdit={() => {}}
      onShare={share}
    >
      <p>Native controls</p>
    </AgentCard>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Actions for Managed" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: "Export" })).toBeNull();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Share" }));
  expect(share).toHaveBeenCalledExactlyOnceWith(agent);
  expect(screen.queryByRole("dialog", { name: "Manage Managed" })).toBeNull();
});
