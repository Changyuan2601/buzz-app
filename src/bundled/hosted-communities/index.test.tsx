// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostService } from "../../features/host/service";
import { SettingsCardsService } from "../../features/settings/service";
import { PluginRuntime } from "../../plugins/runtime";
import * as hosted from "./index";
import manifest from "./manifest.json";
import { federatedFixture } from "../../features/federated-identity/testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

const UNSUPPORTED =
  "Hosted communities need the Buzz development broker and are unavailable in this build.";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "missing" }, { status: 404 })),
  );
});
afterEach(() => {
  cleanup();
  native.invoke.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function mountCard() {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => hosted);
  new HostService(root);
  const fi = federatedFixture();
  Object.defineProperty(fi.service, "apiAvailable", { value: false });
  root.provide("federatedIdentity", fi.service);
  const cards = new SettingsCardsService(root);
  runtime.reconcile([
    {
      manifest: { ...manifest, apiVersion: 1 },
      source: "bundled",
      revision: "bundled",
      enabled: true,
      previous: null,
      reloadable: false,
      error: null,
    },
  ]);
  await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
  const Card = cards.snapshot()[0]?.component;
  if (!Card) throw new Error("Missing Hosted communities card");
  render(<Card active={() => true} />);
  return async () => {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
  };
}

it("keeps live development on the broker", async () => {
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  const dispose = await mountCard();
  try {
    expect(await screen.findByText(UNSUPPORTED)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/builderlab/auth");
    expect(native.invoke).not.toHaveBeenCalledWith(
      "plugin_host_request",
      expect.anything(),
    );
  } finally {
    await dispose();
  }
});

it("uses shared native sign-in and keeps management unavailable without the API contract", async () => {
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  const dispose = await mountCard();
  try {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
    expect(
      screen.getByText(/Hosted community management is unavailable/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Buzz identity" }),
    ).toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await dispose();
  }
});
