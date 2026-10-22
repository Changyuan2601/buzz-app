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
  managed: false,
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
  channelType: "solo",
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

it("opens a chat this page just started before its metadata arrives", () => {
  const pending: ChannelSummary = { id: "new", name: "", pending: true };
  expect(
    state({
      chosen: pollen,
      channels: channels("loading", [pending]),
      started: "new",
    }),
  ).toMatchObject({ kind: "chat", channel: pending });
  // A started id that is not in the list yet does not strand the page.
  expect(
    state({ chosen: pollen, channels: channels("ready", []), started: "new" })
      .kind,
  ).toBe("start");
});
