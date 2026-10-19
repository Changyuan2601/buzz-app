// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { ARTIFACT_KIND } from "./agent-config-artifacts";
import type { ClassifierAvailability } from "./attention-objects";
import type {
  Agent,
  Agents,
  ConfigHistory,
  RegisteredAgentType,
} from "./service";
import { agentSections } from "./tabs";

afterEach(cleanup);
const EMPTY = {};

const agent: Agent = {
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
    configHistory: () => undefined,
    save: async () => {},
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

it("offers Restart to apply only while a conversation runs on older config, and applies it", () => {
  let outdated = true;
  const listeners = new Set<() => void>();
  const notify = () =>
    act(() => {
      for (const listener of listeners) listener();
    });
  const applied: string[] = [];
  const agents = {
    subscribe: () => () => {},
    find: () => agent,
    configHistory: () => undefined,
    save: async () => {},
  } as unknown as Agents;
  const type = {
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: () => <p>Form</p>,
      },
    ],
    restart: {
      outdated: () => outdated,
      apply: (pubkey: string) => {
        applied.push(pubkey);
        outdated = false;
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RegisteredAgentType;
  const section = agentSections({
    agents,
    agent,
    type,
    channels: [],
    memories: undefined,
  }).find((tab) => tab.value === "agent:settings");
  render(<div>{section?.render()}</div>);
  act(() => screen.getByRole("button", { name: "Restart to apply" }).click());
  expect(applied).toEqual([agent.pubkey]);
  notify();
  expect(
    screen.queryByRole("button", { name: "Restart to apply" }),
  ).not.toBeInTheDocument();
  outdated = true;
  notify();
  expect(
    screen.getByRole("button", { name: "Restart to apply" }),
  ).toBeInTheDocument();
});

it("adds History only while the agent's config syncs, and reverts through it", async () => {
  const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
  const d = "5b1d3b52-6c4e-5a0b-8e3c-1f2a3b4c5d6e";
  const event = (id: string, prev?: string) =>
    ({
      id,
      pubkey: "a".repeat(64),
      sig: "b".repeat(128),
      kind: ARTIFACT_KIND,
      created_at: 1_700_000_000,
      content: JSON.stringify({ version: 1, text: id }),
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", "buzz.agent.instructions"],
        ["title", "Agent instructions"],
        ["op", prev ? "update" : "create"],
        ...(prev ? [["prev", prev]] : []),
      ],
    }) as RelayEvent;
  const r0 = event("r0");
  const r1 = event("r1", "r0");
  let history: ConfigHistory | undefined;
  const revise = vi.fn(async () => ({ status: "accepted" as const }));
  const agents = {
    subscribe: () => () => {},
    snapshot: () => EMPTY,
    classifier: () => "available",
    configHistory: () => history,
  } as unknown as Agents;
  const sections = () =>
    agentSections({
      agents,
      agent,
      type: undefined,
      channels: [],
      memories: undefined,
    });
  expect(sections().some((tab) => tab.value === "agent:history")).toBe(false);
  history = {
    read: async () => [r1, r0],
    sides: [
      {
        side: "instructions",
        expected: { channel, d, type: "buzz.agent.instructions" },
        head: r1,
        version: 0,
      },
    ],
    revise,
  };
  const tab = sections().find((tab) => tab.value === "agent:history");
  render(<div>{tab?.render()}</div>);
  expect(
    screen.getByRole("region", { name: "Instructions history" }),
  ).toBeInTheDocument();
  fireEvent.click(await screen.findByText("Revert to this"));
  await waitFor(() =>
    expect(revise).toHaveBeenCalledWith("instructions", expect.anything()),
  );
});

it("labels settings and instructions History regions independently", () => {
  const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
  const history = {
    read: async () => [],
    revise: async () => ({ status: "accepted" }),
    sides: [
      {
        side: "settings",
        expected: { channel, d: "settings", type: "buzz.agent.settings" },
        version: 0,
      },
      {
        side: "instructions",
        expected: {
          channel,
          d: "instructions",
          type: "buzz.agent.instructions",
        },
        version: 0,
      },
    ],
  };
  const agents = {
    subscribe: () => () => {},
    snapshot: () => EMPTY,
    classifier: () => "available",
    configHistory: () => history,
  } as unknown as Agents;
  const tab = agentSections({
    agents,
    agent,
    type: undefined,
    channels: [],
    memories: undefined,
  }).find((tab) => tab.value === "agent:history");
  render(<div>{tab?.render()}</div>);
  expect(
    screen.getByRole("region", { name: "Settings history" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Instructions history" }),
  ).toBeInTheDocument();
});
