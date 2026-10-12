import { ProfilePanel } from "../profiles/ProfilePanel";
import { createRelaySession } from "../../features/relay/session";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { createDraftGuard } from "../../features/drafts/guard";
import { DraftProtection } from "../../features/drafts/DraftProtection";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents2,
  AgentsSnapshot,
  RegisteredAgentType,
} from "../../features/agents2/service";
import type { RelayData } from "../../features/relay/service";
import { Agents2Page } from "./Agents2Page";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((dispose) => {
    dispose();
  });
});

const agent = (name: string, n: number): Agent => ({
  pubkey: String(n).repeat(64),
  name,
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  config: { reply: `${name} says hi` },
  skipped: {},
  timers: {},
  attention: {
    "interest/default": {
      slug: "interest/default",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Help." },
    },
    "watch/hourly": {
      slug: "watch/hourly",
      modifiedAt: 1,
      value: {
        type: "timer",
        interest_id: "default",
        prompt: "Check in",
        enabled: true,
        interval_secs: 3600,
        armed_at: 1,
        max_occurrences: null,
        expires_at: null,
      },
    },
  },
});

function setup(agents: Agent[], { shown = true } = {}) {
  let snapshot: AgentsSnapshot = { status: "ready", agents };
  const listeners = new Set<() => void>();
  const type = {
    key: "test/echo",
    pluginId: "test",
    revision: "1",
    id: "echo",
    title: "Echo",
    description: "Says its line.",
    defaults: () => ({ config: { reply: "" } }),
    summary: (item: Agent) => (item.config as { reply: string }).reply,
    Peek: ({ agent }: { agent: Agent }) => <p>Peek of {agent.name}</p>,
    tabs: [{ id: "reply", title: "Reply", component: () => <p>Reply tab</p> }],
  } as unknown as RegisteredAgentType;
  const created = agent("Nova", 3);
  const types = [type];
  const agents2 = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    find: (pubkey: string) => snapshot.agents.find((a) => a.pubkey === pubkey),
    register: vi.fn(),
    create: vi.fn(async () => {
      // `shown: false`: it was made for a community no longer selected.
      if (!shown) return created;
      snapshot = { ...snapshot, agents: [...snapshot.agents, created] };
      for (const listener of listeners) listener();
      return created;
    }),
    save: vi.fn(async (key: string, change: { name?: string }) => {
      snapshot = {
        ...snapshot,
        agents: snapshot.agents.map((item) =>
          item.pubkey === key ? { ...item, ...change } : item,
        ),
      };
      for (const listener of listeners) listener();
    }),
    remove: vi.fn(async () => {}),
  } satisfies Agents2;
  const session = createRelaySession(null);
  disposals.push(session.dispose);
  const connected = {
    status: "ready" as const,
    generation: 0,
    viewer: "f".repeat(64),
    session: session.session,
  };
  const relay: RelayData = {
    snapshot: () => connected,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const panel: RegisteredPanel = {
    id: "profile",
    pluginId: "profiles",
    key: "profiles/profile",
    revision: "1",
    title: "Profile",
    matches: (target) => !!target,
    component: (props) => (
      <ProfilePanel {...props} agents2={agents2} relay={relay} />
    ),
  };
  const registered = [panel];
  const panels: Panels = {
    register() {},
    resolve: () => panel,
    snapshot: () => registered,
    subscribe: () => () => {},
  };
  const guard = createDraftGuard();
  disposals.push(guard.dispose);
  render(
    <DraftProtection guard={guard}>
      <Agents2Page agents2={agents2} relay={relay} panels={panels} />
    </DraftProtection>,
  );
  return { agents2 };
}

it("opens the canonical profile on one click and restores card focus on close", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1), agent("Bo", 2)]);
  const card = screen.getByRole("button", { name: /Ada says hi/ });
  await user.click(card);
  expect(screen.getByRole("dialog", { name: "Agent profile" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Info" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Reply" }));
  expect(screen.getByText("Reply tab")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Attention" }));
  expect(screen.getByText("Default", { exact: true })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(card).toHaveFocus();
});

it("arrow keys move focus without opening and Enter activates the focused card", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1), agent("Bo", 2)]);
  screen.getByRole("button", { name: /Ada says hi/ }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("button", { name: /Bo says hi/ })).toHaveFocus();
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog", { name: "Agent profile" })).toBeVisible();
});

it("creates in the modal and opens the newly created profile", async () => {
  const user = userEvent.setup();
  const { agents2 } = setup([]);
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Nova");
  await user.click(screen.getByRole("button", { name: "Create and set up" }));
  expect(agents2.create).toHaveBeenCalledWith({
    type: "test/echo",
    name: "Nova",
  });
  expect(
    await screen.findByRole("dialog", { name: "Agent profile" }),
  ).toBeVisible();
});

it("does not open a created identity that belongs to a retired community", async () => {
  const user = userEvent.setup();
  const { agents2 } = setup([agent("Ada", 1)], { shown: false });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Nova");
  await user.click(screen.getByRole("button", { name: "Create and set up" }));
  await vi.waitFor(() => expect(agents2.create).toHaveBeenCalled());
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("does not save on blur, preserves a name draft after canceled close, then saves explicitly", async () => {
  const user = userEvent.setup();
  const { agents2 } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: /Ada says hi/ }));
  const field = screen.getByRole("textbox", { name: "Name" });
  await user.clear(field);
  await user.type(field, "Kept");
  await user.tab();
  expect(agents2.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(field).toHaveValue("Kept");
  await user.click(screen.getByRole("button", { name: "Save name" }));
  expect(agents2.save).toHaveBeenCalledWith("1".repeat(64), { name: "Kept" });
});
