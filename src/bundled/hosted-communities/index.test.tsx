// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostService } from "../../features/host/service";
import { SettingsCardsService } from "../../features/settings/service";
import { PluginRuntime } from "../../plugins/runtime";
import * as hosted from "./index";
import manifest from "./manifest.json";
import { federatedFixture } from "../../features/federated-identity/testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

const local = "a".repeat(64);
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

async function mountCard(fi = federatedFixture()) {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => hosted);
  new HostService(root);
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

it("signs in and connects the identity through the shared native session", async () => {
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  let bound = false;
  const event = { id: "e".repeat(64), kind: 24243 };
  const challenge = {
    challenge_id: "550e8400-e29b-41d4-a716-446655440000",
    nonce: "n".repeat(43),
    verification_code: "123456",
    origin: "https://builderlab.example",
    expires_at: "2999-01-01T00:00:00Z",
  };
  const replies: Record<string, () => unknown> = {
    "v1/buzz/nostr-identities/current": () =>
      bound
        ? { identity: { pubkey_hex: local } }
        : { error: { code: "missing_mapping", setup_needed: true } },
    "v1/buzz/communities/list": () => ({
      communities: [],
      quota_used: 0,
      quota_limit: 5,
      can_create: true,
    }),
    "v1/buzz/nostr-identities/challenge": () => challenge,
    "v1/buzz/nostr-identities/verify": () => {
      bound = true;
      return { identity: { pubkey_hex: local } };
    },
  };
  const fi = federatedFixture();
  fi.request.mockImplementation(async ({ path }) => {
    const reply = replies[path.slice("/api/goose/".length)];
    if (!reply) throw new Error(`Unexpected ${path}`);
    const status = bound || !path.endsWith("/current") ? 200 : 404;
    return { status, headers: {}, body: JSON.stringify(reply()) };
  });
  native.invoke.mockImplementation(async (command) => {
    if (command === "identity_restore") return local;
    if (command === "identity_sign_builderlab_binding") return event;
    if (command === "nsec_backup_retry") return;
    throw new Error(`Unexpected command ${command}`);
  });
  const dispose = await mountCard(fi);
  try {
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Sign in with Builderlab" }),
    );
    expect(fi.service.signIn).toHaveBeenCalledOnce();
    await user.click(
      await screen.findByRole("button", { name: "Connect Buzz identity" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Connect Buzz identity" }),
      ).toBeNull(),
    );
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalledWith(
      "plugin_host_request",
      expect.anything(),
    );
    expect(native.invoke).toHaveBeenCalledWith(
      "identity_sign_builderlab_binding",
      { challenge },
    );
    expect(native.invoke).toHaveBeenCalledWith("nsec_backup_retry", {
      source: "hosted",
    });
    const verify = fi.request.mock.calls.find(([{ path }]) =>
      path.endsWith("/verify"),
    )?.[0];
    // The native host adds the Bearer session; the plugin sends no credential.
    expect(verify?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(verify?.body))).toEqual({
      challenge_id: challenge.challenge_id,
      nonce: challenge.nonce,
      signed_payload: JSON.stringify(event),
    });
  } finally {
    await dispose();
  }
});

it("starts the card over when the shared session signs out elsewhere", async () => {
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  const fi = federatedFixture();
  await fi.service.signIn();
  fi.request.mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({ identity: { pubkey_hex: local } }),
  });
  native.invoke.mockResolvedValue(local);
  const dispose = await mountCard(fi);
  try {
    expect(
      await screen.findByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    await act(() => fi.service.signOut());
    expect(
      await screen.findByRole("button", { name: "Sign in with Builderlab" }),
    ).toBeInTheDocument();
  } finally {
    await dispose();
  }
});
