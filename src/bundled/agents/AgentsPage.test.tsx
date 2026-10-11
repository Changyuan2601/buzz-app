// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
  TeamChange,
} from "../../features/agents/service";
import type { PortableAgent } from "../../features/agents/native";
import type { RelayData } from "../../features/relay/service";
import { AgentsPage } from "./AgentsPage";

afterEach(cleanup);

const agent = (name: string, n: number): Agent => ({
  pubkey: String(n).repeat(64),
  name,
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
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

const portable: PortableAgent[] = [
  {
    source: "harness",
    pubkey: "a".repeat(64),
    name: "Ada",
    relay: "wss://relay.example",
  },
  {
    source: "installed",
    pubkey: "b".repeat(64),
    name: "Bea",
    picture: "https://old.example/media/b.png",
    relay: "",
  },
];

function setup(saved: Agent[], { shown = true } = {}) {
  let snapshot: AgentsSnapshot = {
    status: "ready",
    agents: saved,
    running: saved,
    teams: [],
  };
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
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    find: (pubkey: string) => snapshot.agents.find((a) => a.pubkey === pubkey),
    relay: () => undefined,
    register: vi.fn(),
    create: vi.fn(async () => {
      // `shown: false`: it was made for a community no longer selected.
      if (!shown) return created;
      snapshot = { ...snapshot, agents: [...snapshot.agents, created] };
      for (const listener of listeners) listener();
      return created;
    }),
    finish: vi.fn(async (_: string) => created),
    portable: vi.fn(async () => ({ agents: portable, warnings: [] })),
    port: vi.fn(async () => created),
    save: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    saveTeam: vi.fn(async (change: TeamChange) => {
      const team = { ...change, id: change.id ?? "team-1" };
      snapshot = {
        ...snapshot,
        teams: [...snapshot.teams.filter((t) => t.id !== team.id), team],
      };
      for (const listener of listeners) listener();
      return team;
    }),
    removeTeam: vi.fn(async (id: string) => {
      snapshot = {
        ...snapshot,
        teams: snapshot.teams.filter((t) => t.id !== id),
      };
      for (const listener of listeners) listener();
    }),
  } satisfies Agents;
  const disconnected = { status: "disconnected", generation: 0 };
  const relay = {
    snapshot: () => disconnected,
    subscribe: () => () => {},
  } as unknown as RelayData;
  render(<AgentsPage agents={agents} relay={relay} />);
  return { agents };
}

it("peeks at a selected agent beside the grid and follows the arrow keys", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1), agent("Bo", 2)]);
  const grid = screen.getByRole("listbox", { name: "Agents" });
  expect(within(grid).getByText("Ada says hi")).toBeInTheDocument();
  expect(screen.queryByText("Peek of Ada")).not.toBeInTheDocument();

  await user.click(within(grid).getByText("Ada"));
  expect(screen.getByRole("option", { name: /Ada/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByText("Peek of Ada")).toBeInTheDocument();
  expect(screen.getByText("Every hour")).toBeInTheDocument();
  expect(screen.getByText("Mentions and replies")).toBeInTheDocument();

  await user.keyboard("{ArrowRight}");
  expect(screen.getByText("Peek of Bo")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Bo/ })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(screen.queryByText("Peek of Bo")).not.toBeInTheDocument();
  expect(grid).toBeInTheDocument();
});

it("opens the build view with the type's tabs and the app's Attention tab", async () => {
  const user = userEvent.setup();
  setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("option", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
  expect(tabs).toEqual(["Reply", "Attention"]);
  expect(screen.getByText("Reply tab")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Attention" }));
  expect(screen.getByText("Default")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "All agents" }));
  expect(screen.getByRole("option", { name: /Ada/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("shows an agent's picture in the grid, peek and build view", async () => {
  const user = userEvent.setup();
  const picture = "https://old.example/media/a.png";
  setup([{ ...agent("Ada", 1), picture }]);
  const pictures = () =>
    document.querySelectorAll(`img[src="${picture}"]`).length;
  expect(pictures()).toBe(1);
  await user.click(screen.getByRole("option", { name: /Ada/ }));
  expect(pictures()).toBe(2);
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(pictures()).toBe(1);
});

it("edits the picture from the build view and shows why a save failed", async () => {
  const user = userEvent.setup();
  const picture = "https://old.example/media/a.png";
  const { agents } = setup([{ ...agent("Ada", 1), picture }]);
  await user.click(screen.getByRole("option", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  agents.save.mockRejectedValueOnce(new Error("Could not save"));
  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  await user.click(
    await screen.findByRole("button", { name: "Remove avatar" }),
  );
  expect(agents.save).toHaveBeenCalledWith("1".repeat(64), { picture: null });
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
});

it("makes a new agent in the side panel and goes straight to building it", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: "New agent" }));
  const form = screen.getByRole("form", { name: "New agent" });
  expect(within(form).getByText("Says its line.")).toBeInTheDocument();
  await user.type(within(form).getByLabelText("Name"), "Nova{Enter}");
  expect(agents.create).toHaveBeenCalledWith({
    type: "test/echo",
    name: "Nova",
  });
  expect(await screen.findByRole("tab", { name: "Attention" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Nova" })).toBeInTheDocument();
});

it("stays on the grid when the new agent belongs to a community no longer shown", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)], { shown: false });
  await user.click(screen.getByRole("button", { name: "New agent" }));
  const form = screen.getByRole("form", { name: "New agent" });
  await user.type(within(form).getByLabelText("Name"), "Nova{Enter}");
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalled());
  expect(
    await screen.findByRole("listbox", { name: "Agents" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "New agent" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Attention" })).toBeNull();
});

it("saves a rename on Enter and discards it on Escape", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("option", { name: /Ada/ }));
  await user.keyboard("{Enter}");
  const field = within(
    screen.getByRole("complementary", { name: "Ada identity" }),
  ).getByLabelText("Name");
  await user.clear(field);
  await user.type(field, "Discarded{Escape}");
  expect(agents.save).not.toHaveBeenCalled();
  expect(field).toHaveValue("Ada");
  await user.clear(field);
  await user.type(field, "Kept{Enter}");
  expect(agents.save).toHaveBeenCalledExactlyOnceWith("1".repeat(64), {
    name: "Kept",
  });
});

it("brings over an earlier agent as the chosen type and drops it from the list", async () => {
  const user = userEvent.setup();
  const { agents } = setup([agent("Ada", 1)]);
  await user.click(screen.getByRole("button", { name: "Bring over" }));
  const list = await screen.findByRole("list", {
    name: "Agents to bring over",
  });
  expect(
    within(list).getByText(/Buzz 1\.0 harness agent · npub/),
  ).toBeInTheDocument();
  expect(within(list).getByText(/Buzz 0\.X · npub/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Bring over Bea" }));
  expect(agents.port).toHaveBeenCalledWith({
    source: "installed",
    pubkey: "b".repeat(64),
    type: "test/echo",
  });
  expect(within(list).queryByText("Bea")).not.toBeInTheDocument();
  expect(within(list).getByText("Ada")).toBeInTheDocument();
});

it("shows why bringing an agent over failed and keeps it listed", async () => {
  const user = userEvent.setup();
  const { agents } = setup([]);
  agents.port.mockRejectedValueOnce(new Error("Keychain access was denied"));
  await user.click(screen.getByRole("button", { name: "Bring over" }));
  await user.click(
    await screen.findByRole("button", { name: "Bring over Ada" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Keychain access was denied",
  );
  expect(screen.getByRole("button", { name: "Bring over Ada" })).toBeEnabled();
});

it("makes a team of chosen agents and lists it with its members", async () => {
  const user = userEvent.setup();
  const ada = agent("Ada", 1);
  const { agents } = setup([ada, agent("Bo", 2), agent("Cy", 3)]);
  await user.click(screen.getByRole("button", { name: "Teams" }));
  expect(screen.getByText("No teams yet.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New team" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Ada leads.",
  );
  await user.click(screen.getByRole("checkbox", { name: "Ada" }));
  await user.click(screen.getByRole("checkbox", { name: "Cy" }));
  await user.click(screen.getByRole("button", { name: "Create team" }));

  expect(agents.saveTeam).toHaveBeenCalledWith({
    name: "Crew",
    instructions: "Ada leads.",
    members: [ada.pubkey, agent("Cy", 3).pubkey],
  });
  const list = screen.getByRole("list", { name: "Teams" });
  expect(within(list).getByText("Crew")).toBeInTheDocument();
  expect(within(list).getByText("Ada, Cy")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Edit Crew" }));
  await user.click(screen.getByRole("button", { name: "Delete team" }));
  expect(agents.removeTeam).toHaveBeenCalledWith("team-1");
  expect(screen.getByText("No teams yet.")).toBeInTheDocument();
});

it("shows an agent on another device read-only, and offers only Finish setup and Delete for an unfinished hosted one", async () => {
  const user = userEvent.setup();
  const far: Agent = {
    ...agent("Far", 3),
    place: "elsewhere",
    attention: {},
  };
  const sky: Agent = {
    ...agent("Sky", 4),
    place: "hosted",
    unfinished: true,
    attention: {},
  };
  const { agents } = setup([far, sky]);
  const grid = screen.getByRole("listbox", { name: "Agents" });
  expect(within(grid).getByText("On another device")).toBeInTheDocument();
  expect(within(grid).getByText("Setup unfinished")).toBeInTheDocument();

  await user.click(within(grid).getByText("Far"));
  expect(screen.getByText(/another of your devices/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Wakes on")).not.toBeInTheDocument();
  await user.dblClick(within(grid).getByText("Far"));
  expect(screen.getByRole("listbox")).toBeInTheDocument();

  await user.click(within(grid).getByText("Sky"));
  expect(
    screen.queryByRole("button", { name: "Open" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Delete agent" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Finish setup" }));
  expect(agents.finish).toHaveBeenCalledWith(sky.pubkey);
  await user.dblClick(within(grid).getByText("Sky"));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
});
