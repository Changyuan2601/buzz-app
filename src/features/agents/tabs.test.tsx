// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Agent, Agents, RegisteredAgentType } from "./service";
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

it("puts the device runtime control in Settings without a separate Attention tab", () => {
  const agents = {
    save: async () => {},
    configHistory: () => undefined,
  } as unknown as Agents;
  const sections = agentSections({
    agents,
    agent,
    type: undefined,
    memories: undefined,
  });
  expect(sections.some((tab) => tab.value === "agent:attention")).toBe(false);
  const section = sections.find((tab) => tab.value === "agent:settings");
  render(<div>{section?.render()}</div>);
  expect(
    screen.getByRole("switch", { name: "Attention on this device" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Triage.")).not.toBeInTheDocument();
});

it("supplies the local control once to provider Settings", () => {
  const sections = agentSections({
    agents: {
      save: async () => {},
      configHistory: () => undefined,
    } as unknown as Agents,
    agent,
    type: {
      tabs: [
        {
          id: "settings",
          title: "Settings",
          role: "settings",
          component: ({
            settingsContent,
          }: {
            settingsContent: React.ReactNode;
          }) => <div>{settingsContent}</div>,
        },
      ],
    } as unknown as RegisteredAgentType,
    memories: undefined,
  });
  expect(sections.filter((tab) => tab.value === "agent:settings")).toHaveLength(
    1,
  );
  render(sections.find((tab) => tab.value === "agent:settings")?.render());
  expect(
    screen.getAllByRole("switch", { name: "Attention on this device" }),
  ).toHaveLength(1);
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
