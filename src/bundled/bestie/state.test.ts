import { expect, it } from "vitest";
import type { AgentChoicesSnapshot } from "../../features/agents/choices";
import type {
  ChannelList,
  ChannelSummary,
} from "../../features/relay/contracts";
import { bestieState } from "./state";

const viewer = "a".repeat(64),
  pollen = "b".repeat(64),
  fizz = "c".repeat(64);
const agent = (pubkey: string, name: string) => ({
  pubkey,
  name,
  managed: true,
});

function choices({
  status = "ready" as AgentChoicesSnapshot["status"],
  selectable = [agent(pollen, "Pollen"), agent(fizz, "Fizz")],
  identities = selectable,
  complete = status === "ready",
  archives = "ready" as AgentChoicesSnapshot["archives"]["status"],
  error,
}: Partial<{
  status: AgentChoicesSnapshot["status"];
  selectable: AgentChoicesSnapshot["selectable"];
  identities: AgentChoicesSnapshot["identities"];
  complete: boolean;
  archives: AgentChoicesSnapshot["archives"]["status"];
  error: string;
}> = {}): AgentChoicesSnapshot {
  return {
    status,
    selectable,
    identities,
    complete,
    pending: status === "loading",
    archives: { status: archives, archived: [] },
    templates: { status, identities: [], complete, pending: false },
    definitions: [],
    ...(error ? { error } : {}),
  };
}
const channels = (
  status: ChannelList["status"],
  list: readonly ChannelSummary[] = [],
  error?: string,
): ChannelList => ({ status, channels: list, ...(error ? { error } : {}) });
const chat: ChannelSummary = {
  id: "chat",
  name: "Pollen",
  channelType: "dm",
  creator: viewer,
  members: [viewer, pollen],
  lastActivityAt: 4,
};
const state = (over: Partial<Parameters<typeof bestieState>[0]> = {}) =>
  bestieState({
    chosen: undefined,
    choices: choices(),
    channels: channels("ready"),
    viewer,
    ...over,
  });

it("waits for complete evidence before saying there is no Bestie", () => {
  expect(state({ choices: choices({ status: "loading" }) }).kind).toBe(
    "loading",
  );
  expect(state({ choices: choices({ archives: "loading" }) }).kind).toBe(
    "loading",
  );
  expect(
    state({ choices: choices({ status: "ready", complete: false }) }).kind,
  ).toBe("loading");
  expect(state().kind).toBe("choose");
});

it("reports an unreadable roster instead of an empty chooser", () => {
  expect(
    state({
      choices: choices({
        status: "error",
        selectable: [],
        error: "Relay unreachable.",
      }),
    }),
  ).toEqual({
    kind: "unavailable",
    source: "agents",
    error: "Relay unreachable.",
  });
  expect(
    state({ choices: choices({ status: "unavailable", selectable: [] }) }),
  ).toEqual({
    kind: "unavailable",
    source: "agents",
  });
});

it("offers the agents a failed read did return, and says the list may be short", () => {
  const partial = state({
    choices: choices({
      status: "error",
      selectable: [agent(pollen, "Pollen")],
      error: "Some reads failed.",
    }),
  });
  expect(partial).toMatchObject({
    kind: "choose",
    partial: "Some reads failed.",
  });
  expect(
    partial.kind === "choose" && partial.agents.map(({ name }) => name),
  ).toEqual(["Pollen"]);
});

it("treats one failed source among ready ones as a short list, not as loading", () => {
  // The shape createAgentChoices produces when a source fails and another
  // succeeds: ready, with that source's error and incomplete evidence.
  const source = {
    status: "ready" as const,
    complete: false,
    error: "Buzz couldn’t read one agent source.",
  };
  expect(
    state({
      choices: choices({ ...source, selectable: [agent(pollen, "Pollen")] }),
    }),
  ).toMatchObject({ kind: "choose", partial: source.error });
  // A chosen agent missing from the source that did answer is still named,
  // rather than waiting on evidence that has already failed.
  expect(
    state({
      chosen: fizz,
      choices: choices({ ...source, selectable: [agent(pollen, "Pollen")] }),
    }),
  ).toMatchObject({ kind: "choose", missing: expect.stringMatching(/^npub…/) });
  // With nothing to offer, the failure is reported instead of an empty chooser.
  expect(state({ choices: choices({ ...source, selectable: [] }) })).toEqual({
    kind: "unavailable",
    source: "agents",
    error: source.error,
  });
});

it("honors an explicit choice as soon as its agent is present", () => {
  const early = state({
    chosen: pollen,
    choices: choices({
      status: "loading",
      complete: false,
      archives: "loading",
    }),
    channels: channels("ready", [chat]),
  });
  expect(early).toMatchObject({ kind: "chat", channel: chat });
  expect(early.kind === "chat" && early.bestie.name).toBe("Pollen");
});

it("names the agent a chosen Bestie used to be, and keeps choosing possible", () => {
  const gone = "d".repeat(64);
  expect(
    state({
      chosen: gone,
      choices: choices({
        identities: [...choices().selectable, agent(gone, "Honey")],
      }),
    }),
  ).toMatchObject({ kind: "choose", missing: "Honey" });
  // An agent nothing knows about is still named by its key, never "undefined".
  expect(state({ chosen: gone })).toMatchObject({
    kind: "choose",
    missing: expect.stringMatching(/^npub…/),
  });
  // While evidence is incomplete, a stored choice is not yet reported as gone.
  expect(
    state({ chosen: gone, choices: choices({ status: "loading" }) }).kind,
  ).toBe("loading");
});

it("starts the first chat only once the chat list is known", () => {
  expect(state({ chosen: pollen }).kind).toBe("start");
  expect(state({ chosen: pollen, channels: channels("loading") }).kind).toBe(
    "loading",
  );
  expect(
    state({
      chosen: pollen,
      channels: channels("error", [], "Roster read failed."),
    }),
  ).toEqual({
    kind: "unavailable",
    source: "chats",
    error: "Roster read failed.",
  });
  expect(state({ chosen: pollen, channels: channels("unavailable") })).toEqual({
    kind: "unavailable",
    source: "chats",
  });
});

it("offers library-only agents and resolves their existing verified DM", () => {
  const libraryOnly = { ...agent(pollen, "Pollen"), managed: false };
  expect(
    state({
      chosen: pollen,
      choices: choices({
        selectable: [libraryOnly],
        identities: [libraryOnly],
      }),
      channels: channels("ready", [chat]),
    }),
  ).toMatchObject({ kind: "chat", bestie: libraryOnly, channel: chat });
  expect(
    state({ choices: choices({ selectable: [libraryOnly] }) }),
  ).toMatchObject({ kind: "choose", agents: [libraryOnly] });
});

it("does not resolve a saved agent excluded from selectable even with a verified DM", () => {
  expect(
    state({
      chosen: pollen,
      choices: choices({
        selectable: [agent(fizz, "Fizz")],
        identities: [agent(pollen, "Pollen"), agent(fizz, "Fizz")],
      }),
      channels: channels("ready", [chat]),
    }),
  ).toMatchObject({
    kind: "choose",
    missing: "Pollen",
    agents: [agent(fizz, "Fizz")],
  });
});
