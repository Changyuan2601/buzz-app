// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type { ClassifierAvailability } from "./attention-objects";
import type { Agent, Agents } from "./service";
import type { CommunityReader, Membership } from "../communities/service";
import { agentSections } from "./tabs";

afterEach(cleanup);

const agent: Agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
  attention: {
    "interest/triage": {
      slug: "interest/triage",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Triage." },
    },
    "watch/asks": {
      slug: "watch/asks",
      modifiedAt: 1,
      value: {
        type: "event",
        interest_id: "triage",
        enabled: true,
        since: 1,
        channels: ["c1"],
        kinds: [9],
        classifier: {
          questions: { asks: { question: "Is this a question?" } },
        },
      },
    },
  },
} as Agent;

it("updates the classifier warning when the key changes while the agent does not", () => {
  let classifier: ClassifierAvailability = "unavailable";
  const listeners = new Set<() => void>();
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    classifier: () => classifier,
    memberships: () => [],
    save: async () => {},
    configHistory: () => undefined,
  } as unknown as Agents;
  const set = (next: ClassifierAvailability) =>
    act(() => {
      classifier = next;
      for (const listener of listeners) listener();
    });
  const section = agentSections({
    agents,
    agent,
    type: undefined,
    channels: [],
    memories: undefined,
  }).find((tab) => tab.value === "agent:attention");
  render(<div>{section?.render()}</div>);
  expect(screen.getByText(/cannot run on this device/)).toBeInTheDocument();
  set("available");
  expect(screen.queryByText(/cannot run/)).not.toBeInTheDocument();
  set("unavailable");
  expect(screen.getByText(/cannot run on this device/)).toBeInTheDocument();
});

it("shows Attention scope for the agent relay and follows community updates", async () => {
  const user = userEvent.setup();
  let memberships: Membership[] = [
    { id: "https://other.example", name: "Other" },
    {
      id: "https://relay.example",
      name: "Studio",
      icon: "https://images.example/studio.png",
    },
  ];
  let known = { memberships };
  const listeners = new Set<() => void>();
  const communities = {
    snapshot: () => known,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as CommunityReader;
  const agents = {
    subscribe: () => () => {},
    classifier: () => "available",
    memberships: () => [
      { key: agent.key, origin: agent.relay, connected: true },
      { key: "other", origin: "https://other.example", connected: false },
    ],
    configHistory: () => undefined,
  } as unknown as Agents;
  const section = agentSections({
    agents,
    agent,
    type: undefined,
    channels: [],
    memories: undefined,
    communities,
  }).find((tab) => tab.value === "agent:attention");
  const view = render(section?.render());
  const trigger = screen.getByRole("button", {
    name: "Attention scope: Studio",
  });
  expect(trigger.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/studio.png",
  );
  trigger.focus();
  await user.keyboard("{Enter}");
  const popup = await screen.findByRole("dialog", { name: "Attention scope" });
  expect(within(popup).getByText("Studio")).toBeInTheDocument();
  expect(popup).toHaveTextContent(
    "Attention is specific to this community and isn’t shared with other communities.",
  );
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  act(() => {
    memberships = [
      {
        id: "https://relay.example",
        name: "Studio",
        localName: "Renamed",
        publishedIcon: "javascript:alert(1)",
      },
    ];
    known = { memberships };
    for (const listener of listeners) listener();
  });
  expect(
    screen
      .getByRole("button", { name: "Attention scope: Renamed" })
      .querySelector("img"),
  ).toBeNull();
  act(() => {
    memberships = [];
    known = { memberships };
    for (const listener of listeners) listener();
  });
  expect(
    screen.getByRole("button", { name: "Attention scope: relay.example" }),
  ).toBeInTheDocument();
  view.unmount();
  expect(listeners.size).toBe(0);
});

it("shows each synced side's History as its own named section", () => {
  const side = (name: "settings" | "instructions") => ({
    side: name,
    expected: { channel: "c", d: name, type: `buzz.agent.${name}` },
    head: undefined,
    version: 0,
  });
  const snapshot = {};
  const history = {
    read: async () => [],
    sides: [side("settings"), side("instructions")],
    revise: async () => ({ ok: true }),
  };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    classifier: () => "available",
    save: async () => {},
    configHistory: () => history,
  } as unknown as Agents;
  const section = agentSections({
    agents,
    agent,
    type: undefined,
    channels: [],
    memories: undefined,
  }).find((tab) => tab.value === "agent:history");
  render(<div>{section?.render()}</div>);
  expect(
    screen.getByRole("region", { name: "Settings history" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Instructions history" }),
  ).toBeInTheDocument();
});
