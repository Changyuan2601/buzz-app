// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { StrictMode } from "react";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import { matchesEvent } from "../features/relay/projection";
import type { ReadFilter } from "../features/relay/events";
import { composerDOMFixture } from "../features/messages/composer-testing";

composerDOMFixture();

// jsdom has no IndexedDB; this flow keeps its message unsent.
vi.mock("../features/relay/outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.channels", name: "Channels", apiVersion: 1 },
      module: await import("../bundled/channels"),
    },
    {
      manifest: { id: "buzz.repos", name: "Repositories", apiVersion: 1 },
      module: await import("../bundled/repos"),
    },
    {
      manifest: { id: "buzz.profiles", name: "Profiles", apiVersion: 1 },
      module: await import("../bundled/profiles"),
    },
  ],
}));
const key = new Uint8Array(32).fill(6),
  viewer = getPublicKey(key),
  origin = "https://community.example";
const profile = finalizeEvent(
  {
    kind: 0,
    created_at: 1,
    content: JSON.stringify({ name: "Community name" }),
    tags: [],
  },
  key,
);
const recipient = finalizeEvent(
  {
    kind: 0,
    created_at: 1,
    content: JSON.stringify({ name: "Draft recipient" }),
    tags: [],
  },
  new Uint8Array(32).fill(7),
);
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

async function setup(connectionError = false) {
  // jsdom has no media queries; responsive shell geometry is covered in browsers.
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
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Local name", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: origin,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session")) {
        if (connectionError) return new Response(null, { status: 502 });
        return Response.json({
          viewer,
          relayAuthor: viewer,
          relayUrl: origin,
          writeKinds: [9],
          directMessages: true,
        });
      }
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body)) as ReadFilter[];
        return Response.json(
          [profile, recipient].filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        );
      }
      return Response.json({});
    }),
  );
  const user = userEvent.setup();
  services = createServices();
  const current = services;
  render(
    <StrictMode>
      <App services={current} />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(current.relay.snapshot().status).toBe(
      connectionError ? "error" : "ready",
    ),
  );
  return user;
}

it("opens profile settings from the account menu header", async () => {
  const user = await setup();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  const menu = await screen.findByRole("menu", { name: "Community name" });
  await user.click(
    within(menu).getByRole("menuitem", {
      name: "Community name, edit profile",
    }),
  );
  await waitFor(() => expect(menu).not.toBeInTheDocument());
  const settings = await screen.findByRole("region", { name: "Settings" });
  expect(
    await within(settings).findByText(
      "Update this community’s profile. Other community profiles stay unchanged.",
    ),
  ).toBeVisible();
});

it("opens Plugins from the account menu and switches back to profile settings", async () => {
  const user = await setup();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  await user.click(await screen.findByRole("menuitem", { name: "Plugins" }));
  const settings = await screen.findByRole("region", { name: "Settings" });
  expect(
    await within(settings).findByRole("region", {
      name: "Plugins",
    }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  await user.click(
    await screen.findByRole("menuitem", {
      name: "Community name, edit profile",
    }),
  );
  expect(
    await within(settings).findByRole("region", {
      name: "Profile",
    }),
  ).toBeVisible();
});
