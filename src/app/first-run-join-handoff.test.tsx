// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import type { RelayEvent } from "../features/relay/events";
import { keypair, profile, signed } from "../features/relay/testing";

// A first run whose Builderlab account saved one community and whose landing
// named another: the real gate lifts on the restored community and the rail's
// Add-a-community dialog takes the typed address over. Setup outlasts the
// startup visit's 15 s deadline, as a real sign-in does.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
  Channel: class {
    id = 1;
    onmessage = () => {};
  },
}));
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
  ],
}));
// The browser sign-in, which the seeded account below never sends anywhere.
vi.mock("../bundled/builderlab/oauth/first-run", () => ({
  bundledHost: { request: vi.fn() },
  firstRunCredential: vi.fn(async () => ({
    value: "private-token",
    account: {
      subject: "user",
      email: "a@example.com",
      canUseRemoteAgents: false,
    },
  })),
}));
// jsdom has no IndexedDB.
vi.mock("../features/relay/outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));

const member = keypair();
const relayA = "https://relay-a.example";
const relayB = "https://relay-b.example";
/** Both relays admit the key; only relay-a holds its profile. */
let relays: Record<string, { self: string; profile?: RelayEvent }>;
let services: AppServices | undefined;
beforeEach(() => {
  relays = {
    [relayA]: {
      self: keypair().pubkey,
      profile: profile(member, { name: "Ada", picture: "" }),
    },
    [relayB]: { self: keypair().pubkey },
  };
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubEnv("VITE_BUZZ_OPEN_RELAY", "");
  vi.stubEnv(
    "VITE_BUZZ_FIRST_RUN_ACCOUNT",
    JSON.stringify({ known: ["relay-a.example"] }),
  );
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.mocked(isTauri).mockReturnValue(true);
  let created = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return created ? member.pubkey : null;
    if (command === "identity_create") {
      created = true;
      return member.pubkey;
    }
    if (command === "get_os_idle_seconds") return 0;
    if (command === "deep_link_take") return [];
    if (command === "deep_link_watch") return null;
    if (command === "relay_sign")
      return signed(member, (args as { event: EventTemplate }).event);
    if (command === "relay_http") return relayAnswer(args);
    if (command === "plugin_catalog")
      return {
        status: "ready",
        externalPluginsPaused: false,
        catalog: {
          profile: "fixture",
          location: "fixture",
          plugins: [
            {
              manifest: {
                id: "buzz.channels",
                name: "Channels",
                apiVersion: 1,
              },
              source: "bundled",
              revision: "bundled",
              enabled: true,
              previous: null,
              reloadable: false,
              error: null,
            },
          ],
        },
      };
    // Other native owners may initialize, but no actual native operations run.
    throw new Error(`Fixture native capability unavailable: ${command}`);
  });
});
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** Each relay answers discovery, its kind-0 reads and a kind-0 publish; nothing else is held. */
function relayAnswer(args: unknown) {
  const request = args as { community: string; path: string; body: string };
  const answer = (status: number, value?: unknown) => ({
    status,
    headers: {},
    body: value === undefined ? "" : JSON.stringify(value),
  });
  const relay = relays[request.community];
  if (!relay) return answer(404);
  if (request.path === "/")
    return answer(200, {
      name: "Buzz Relay",
      self: relay.self,
      icon: "https://cdn.example.com/icon.png",
    });
  if (request.path === "/query") {
    const filters = JSON.parse(request.body) as Array<{ kinds?: number[] }>;
    const reads = filters.some((filter) => filter.kinds?.includes(0));
    return answer(200, reads && relay.profile ? [relay.profile] : []);
  }
  if (request.path === "/events") {
    const event = JSON.parse(request.body) as RelayEvent;
    if (event.kind === 0) relay.profile = event;
    return answer(200, { accepted: true, event_id: event.id });
  }
  return answer(404);
}

const notice = () => screen.queryByText("This destination couldn’t open");
const joinDialog = () =>
  screen.queryByRole("dialog", { name: "Join a community" });
/** Landing address → Connect from the choice → Create my key → the restore lifts the gate. */
async function firstRunWithAddress(user: ReturnType<typeof userEvent.setup>) {
  const current = createServices();
  services = current;
  render(<App services={current} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  await user.type(
    await screen.findByRole("textbox", { name: "Community URL" }),
    "relay-b.example{Enter}",
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Create my key" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Join a community",
  });
  // Entered on the restored community, behind the timed-out startup visit's
  // notice, with the typed address prefilled.
  expect(notice()).toBeInTheDocument();
  expect(current.communities.snapshot()).toMatchObject({
    memberships: [{ id: relayA }],
    selected: relayA,
  });
  expect(within(dialog).getByLabelText("Community URL")).toHaveValue(relayB);
  expect(current.invites.snapshot()).toMatchObject({
    community: relayB,
    code: "",
    viewer: member.pubkey,
  });
  return { current, dialog };
}

it("hands a typed address the restore did not admit to the Add-a-community dialog, which joins and opens it", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const { current, dialog } = await firstRunWithAddress(user);
  await user.click(within(dialog).getByRole("button", { name: "Continue" }));
  await user.click(
    await within(dialog).findByRole("button", { name: "Continue" }),
  );
  // The profile starts from the local default the restore adopted.
  expect(
    await within(dialog).findByRole("textbox", { name: "Display name" }),
  ).toHaveValue("Ada");
  await user.click(
    within(dialog).getByRole("button", { name: "Publish profile & open" }),
  );
  await waitFor(() =>
    expect(current.communities.snapshot()).toMatchObject({
      memberships: [{ id: relayA }, { id: relayB }],
      selected: relayB,
    }),
  );
  expect(current.invites.snapshot()).toBeUndefined();
  expect(joinDialog()).toBeNull();
  // Opening the joined community replaces the timed-out startup visit.
  await waitFor(() => expect(notice()).toBeNull());
  expect(current.navigation.snapshot().entry.target).toMatchObject({
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
  });
});

it("closing the handed-off dialog clears the intent and stays on the restored community", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const { current, dialog } = await firstRunWithAddress(user);
  await user.click(within(dialog).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(joinDialog()).toBeNull());
  expect(current.invites.snapshot()).toBeUndefined();
  expect(current.communities.snapshot()).toMatchObject({
    memberships: [{ id: relayA }],
    selected: relayA,
  });
  // The timed-out startup visit stays as on every first run: kept for retry.
  expect(notice()).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Retry navigation" }),
  ).toBeVisible();
});
