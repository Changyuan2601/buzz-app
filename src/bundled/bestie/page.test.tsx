// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { createAgentChoices } from "../../features/agents/choices";
import { createAgentLibrary } from "../../features/agents/library";
import { localAgentsFixture } from "../../features/agents/local-testing";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { RelayData } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  message,
  summary,
  bounds,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import type { RelayEvent } from "../../features/relay/events";
import { setDefaultAgent } from "../../features/solo/default-agent";
import { readView, writeView } from "../../shared/view-state";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { BestiePage } from "./page";

// jsdom has no virtualized layout. Keep the real rows, thread reader and React
// lifecycle; model only Virtua's imperative layout boundary, not scroll behavior.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children }: { children: ReactNode },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
        scrollTo() {},
        scrollToIndex() {},
      }));
      return <div>{children}</div>;
    }),
  };
});

composerDOMFixture();
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const pollen = "b".repeat(64),
  fizz = "c".repeat(64),
  libraryOnly = "e".repeat(64);
const pollenDM = "11111111-1111-4111-8111-111111111111";
const fizzDM = "22222222-2222-4222-8222-222222222222";
const empty: readonly never[] = [];
const contribution = { snapshot: () => empty, subscribe: () => () => {} };
const extensions = { tools: contribution, inline: contribution };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture({
  failed = false,
  localFailed = false,
  hold = false,
  existing = false,
  badRoster = false,
  withReply = false,
} = {}) {
  // The timeline waits for a measurable host before mounting its virtualizer.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair(),
    relayKey = keypair();
  const scope = `https://test.example:${viewer.pubkey}`;
  const discovery = new Map<string, RelayEvent[]>();
  function dm(agent: string, id = agent === pollen ? pollenDM : fizzDM) {
    discovery.set(id, [
      metadata(relayKey, id, agent === pollen ? "Pollen" : "Fizz", undefined, [
        ["t", "dm"],
      ]),
      roster(relayKey, id, [viewer.pubkey, badRoster ? libraryOnly : agent]),
    ]);
    return id;
  }
  const root = message(viewer, pollenDM, "Are you there?", 1_700_000_000);
  const response = message(
    keypair(),
    pollenDM,
    "Yep, here. What’s up?",
    1_700_000_001,
    [["e", root.id, "", "reply"]],
  );
  const gate = deferred();
  if (existing) dm(pollen);
  const open = vi.fn(async (keys: readonly string[], _signal: AbortSignal) => {
    if (hold && keys[0] === pollen) await gate.promise;
    const key = keys[0];
    if (!key) throw new Error("Fixture needs an exact recipient");
    return dm(key);
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: "https://test.example",
      media: () => undefined,
      query: async (filters) => {
        if (
          filters.some((f) =>
            f.kinds?.some((kind) => kind === 39000 || kind === 39002),
          )
        )
          return [...discovery.values()].flat();
        if (withReply && filters.some((f) => f.top_level))
          return [
            root,
            summary(relayKey, pollenDM, root.id, {
              reply_count: 1,
              participants: [response.pubkey],
            }),
            bounds(relayKey, pollenDM, "head", {
              has_more: false,
              next_cursor: null,
            }),
          ];
        if (
          withReply &&
          filters.some(
            (f) => f.ids?.includes(root.id) || f["#e"]?.includes(root.id),
          )
        )
          return [root, response];
        return [];
      },
      openDirectMessage: open,
      writer: {
        kinds: [9, 9000],
        sign: async (event) => signed(viewer, event),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  let unavailable = failed;
  const read = vi.fn(async () => {
    if (unavailable) throw new Error("Fixture inventory unavailable");
    return {
      definitions: [],
      identities: [{ pubkey: libraryOnly, name: "Library only" }],
    };
  });
  const library = createAgentLibrary(read);
  const native = localAgentsFixture(
    [
      {
        pubkey: pollen,
        name: "Pollen",
        owner: viewer.pubkey,
        relayUrl: "wss://test.example",
      },
      {
        pubkey: fizz,
        name: "Fizz",
        owner: viewer.pubkey,
        relayUrl: "wss://test.example",
      },
    ],
    localFailed ? "error" : "ready",
  );
  if (localFailed)
    native.set({ status: "error", error: "Local agents unavailable" });
  const lifetime = new AbortController();
  const choices = createAgentChoices({
    scope,
    library: library.queries,
    native,
    signal: lifetime.signal,
  });
  await choices.refresh();
  native.onRefresh(() => native.set({ status: "ready" }));
  disposals.push(() => {
    lifetime.abort();
    library.dispose();
    owner.dispose();
  });
  const send = vi.fn<typeof owner.session.messages.send>(() => "d".repeat(64));
  const session = {
    ...owner.session,
    agentChoices: choices,
    messages: { ...owner.session.messages, send },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const host = {
    relay,
    panels: {
      snapshot: () => empty,
      subscribe: () => () => {},
      resolve: () => undefined,
    },
    navigation: { open: vi.fn() },
  } as unknown as ConversationHostServices;
  return {
    scope,
    session,
    send,
    read,
    open,
    gate,
    native,
    recover: () => {
      unavailable = false;
    },
    choose: (pubkey: string | null) => setDefaultAgent(scope, pubkey),
    mount: () =>
      render(
        <ToastProvider>
          <BestiePage relay={relay} host={host} extensions={extensions} />
        </ToastProvider>,
        { reactStrictMode: true },
      ),
  };
}

it("opens the actual verified DM and sends plain text without a seeded removable mention", async () => {
  const f = await fixture();
  f.choose(pollen);
  const user = userEvent.setup();
  f.mount();
  const input = await screen.findByRole("textbox", { name: "Message Pollen" });
  expect(f.open).toHaveBeenCalledWith([pollen], expect.any(AbortSignal));
  expect(
    f.session.channels.list().channels.find((c) => c.id === pollenDM),
  ).toMatchObject({
    channelType: "dm",
    members: expect.arrayContaining([pollen]),
  });
  expect(input).not.toHaveTextContent("@Pollen");
  expect(
    screen.queryByRole("button", { name: /Remove mention/ }),
  ).not.toBeInTheDocument();
  await user.type(input, "Morning");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(f.send).toHaveBeenCalledWith(pollenDM, "Morning", [], []),
  );
  expect(input).not.toHaveTextContent("@Pollen");
  expect(
    screen.queryByRole("button", { name: /Remove mention/ }),
  ).not.toBeInTheDocument();
});

it("reuses an existing DM and its ordinary draft after leaving and reopening Bestie", async () => {
  const f = await fixture({ existing: true });
  writeView(f.scope, `draft:${pollenDM}`, "Existing DM draft");
  f.choose(pollen);
  const view = f.mount();
  expect(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
  ).toHaveTextContent("Existing DM draft");
  expect(f.open).not.toHaveBeenCalled();
  view.unmount();
  f.mount();
  expect(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
  ).toHaveTextContent("Existing DM draft");
  expect(f.open).not.toHaveBeenCalled();
});

it("switches DMs without carrying the old agent's draft or modifying the Solo draft", async () => {
  const f = await fixture();
  const user = userEvent.setup();
  writeView(f.scope, "solo:new-draft", "Untouched Solo notes");
  f.choose(pollen);
  f.mount();
  await user.type(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
    "Keep these notes",
  );
  await user.click(screen.getByRole("button", { name: "Change your Bestie" }));
  await user.click(await screen.findByRole("menuitemradio", { name: /Fizz/ }));
  await user.click(await screen.findByRole("button", { name: "Make Bestie" }));
  expect(
    await screen.findByRole("textbox", { name: "Message Fizz" }),
  ).not.toHaveTextContent("Keep these notes");
  act(() => {
    f.choose(pollen);
  });
  expect(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
  ).toHaveTextContent("Keep these notes");
  expect(readView(f.scope, "solo:new-draft", "")).toBe("Untouched Solo notes");
});

it("does not display a stale open after the selection changes, and aborts it on unmount", async () => {
  const f = await fixture({ hold: true });
  f.choose(pollen);
  const view = f.mount();
  await waitFor(() => expect(f.open).toHaveBeenCalled());
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  act(() => {
    f.choose(fizz);
  });
  await screen.findByRole("textbox", { name: "Message Fizz" });
  await act(async () => {
    f.gate.resolve();
  });
  expect(
    screen.queryByRole("textbox", { name: "Message Pollen" }),
  ).not.toBeInTheDocument();
  expect(
    f.open.mock.calls
      .filter(([keys]) => keys[0] === pollen)
      .every(([, signal]) => signal.aborted),
  ).toBe(true);
  view.unmount();
});

it("reports an open failure and retries through the same DM owner", async () => {
  const f = await fixture();
  f.open.mockRejectedValueOnce(new Error("DM temporarily unavailable"));
  // StrictMode abandons its initial effect; both initial opens must fail.
  f.open.mockRejectedValueOnce(new Error("DM temporarily unavailable"));
  f.choose(pollen);
  f.mount();
  await screen.findByText("DM temporarily unavailable");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("textbox", { name: "Message Pollen" });
});

it("never renders a DM whose signed membership does not match the chosen agent", async () => {
  const f = await fixture({ badRoster: true });
  f.choose(pollen);
  f.mount();
  await screen.findByText(
    "The conversation’s participants could not be confirmed. Try again.",
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("offers managed agents from a successful source, with recovery for the failed source", async () => {
  const f = await fixture({ failed: true });
  expect(f.session.agentChoices.snapshot()).toMatchObject({
    status: "ready",
    complete: false,
    error: expect.any(String),
  });
  f.recover();
  f.mount();
  await screen.findByText(/Could not read agent inventory/);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      screen.queryByText(/Could not read agent inventory/),
    ).not.toBeInTheDocument(),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Choose your Bestie" }),
  );
  expect(
    await screen.findByRole("menuitemradio", { name: /Pollen/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitemradio", { name: /Library only/ }),
  ).not.toBeInTheDocument();
});

it("recovers failed managed-agent discovery instead of offering library-only agents", async () => {
  const f = await fixture({ localFailed: true });
  f.mount();
  // A ready library cannot establish local DM eligibility.
  await screen.findByText("Your agents are unavailable");
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: "Choose your Bestie" });
});

it("removal returns to the chooser without deleting the DM or its draft", async () => {
  const f = await fixture();
  f.choose(pollen);
  f.mount();
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
    "Saved DM notes",
  );
  act(() => {
    f.choose(null);
  });
  await screen.findByRole("button", { name: "Choose your Bestie" });
  expect(
    f.session.channels.list().channels.some((c) => c.id === pollenDM),
  ).toBe(true);
  act(() => {
    f.choose(pollen);
  });
  expect(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
  ).toHaveTextContent("Saved DM notes");
});

it("opens an agent's thread reply from the DM timeline and returns to the main composer", async () => {
  const f = await fixture({ existing: true, withReply: true });
  f.choose(pollen);
  f.mount();
  const user = userEvent.setup();
  await user.type(
    await screen.findByRole("textbox", { name: "Message Pollen" }),
    "Keep my DM draft",
  );
  const thread = await screen.findByRole("button", {
    name: /View thread: 1 reply/,
  });
  await user.click(thread);
  await screen.findByText("Yep, here. What’s up?");
  expect(screen.getByRole("button", { name: "Close thread" })).toHaveFocus();
  await user.type(
    await screen.findByRole("textbox", { name: "Reply to thread" }),
    "Keep my thread draft",
  );
  await user.click(screen.getByRole("button", { name: "Close thread" }));
  const composer = await screen.findByRole("textbox", {
    name: "Message Pollen",
  });
  expect(composer).toHaveTextContent("Keep my DM draft");
  await waitFor(() => expect(composer).toHaveFocus());
  await user.click(
    await screen.findByRole("button", { name: /View thread: 1 reply/ }),
  );
  expect(
    await screen.findByRole("textbox", { name: "Reply to thread" }),
  ).toHaveTextContent("Keep my thread draft");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Message Pollen" }),
    ).toHaveFocus(),
  );
});
