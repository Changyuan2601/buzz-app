// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

// The startup `home` visit is created with its 15 s deadline before React renders.
// On a native first run `Welcome` hides `ConnectedApp`, the only presenter, until
// a human key exists; these cases open that gate before and after the deadline.
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
const viewer = "a".repeat(64);
let services: AppServices | undefined;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubEnv("VITE_BUZZ_OPEN_RELAY", "");
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
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "identity_restore") return null;
    if (command === "identity_create") return viewer;
    if (command === "deep_link_take") return [];
    if (command === "deep_link_watch") return null;
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

const notice = () => screen.queryByText("This destination couldn’t open");
async function firstRun() {
  const current = createServices();
  services = current;
  render(<App services={current} />);
  expect(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  ).toBeVisible();
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opening",
    entry: { target: { kind: "home" } },
  });
  return current;
}
async function openGate(current: AppServices) {
  await act(async () => {
    await current.identity?.create();
  });
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(notice()).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Connect with Builderlab" }),
  ).not.toBeInTheDocument();
}

it("presents the startup visit as-is when the first-run gate opens before its deadline", async () => {
  const current = await firstRun();
  const { attempt } = current.navigation.snapshot();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14_000);
  });
  expect(current.navigation.snapshot().status).toBe("opening");
  await openGate(current);
  // The same attempt completed; completion cleared its deadline.
  expect(current.navigation.snapshot().attempt.id).toBe(attempt.id);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(current.navigation.snapshot().status).toBe("opened");
  expect(notice()).not.toBeInTheDocument();
});

it("restarts a startup visit that timed out behind the first-run gate instead of showing the failure", async () => {
  const current = await firstRun();
  const { attempt } = current.navigation.snapshot();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "timeout",
    entry: { target: { kind: "home" } },
  });
  expect(notice()).not.toBeInTheDocument();
  await openGate(current);
  expect(current.navigation.snapshot().attempt.id).not.toBe(attempt.id);
});
