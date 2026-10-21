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

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

const local = "a".repeat(64);
const API = "https://app.builderlab.xyz/api/goose";
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

it("signs in and connects the identity natively in a desktop build", async () => {
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  let bound = false;
  const event = { id: "e".repeat(64), kind: 24243 };
  const challenge = {
    challenge_id: "550e8400-e29b-41d4-a716-446655440000",
    nonce: "n".repeat(43),
    verification_code: "123456",
    origin: "https://app.builderlab.xyz",
    expires_at: "2999-01-01T00:00:00Z",
  };
  const replies: Record<string, () => unknown> = {
    "/v1/auth/login/exchange": () => ({
      session_credential: "private-token",
      expires_at: "2030",
    }),
    "/v1/auth/me": () => ({ email: "a@example.com", expires_at: "2030" }),
    "/v1/buzz/nostr-identities/current": () =>
      bound
        ? { identity: { pubkey_hex: local } }
        : { error: { code: "missing_mapping", setup_needed: true } },
    "/v1/buzz/communities/list": () => ({
      communities: [],
      quota_used: 0,
      quota_limit: 5,
      can_create: true,
    }),
    "/v1/buzz/nostr-identities/challenge": () => challenge,
    "/v1/buzz/nostr-identities/verify": () => {
      bound = true;
      return { identity: { pubkey_hex: local } };
    },
  };
  native.invoke.mockImplementation(async (command, input) => {
    if (command === "identity_restore") return local;
    if (command === "oauth_callback_begin") return { id: "attempt" };
    if (command === "oauth_callback_wait")
      return { parameters: [["code", "one-time"]] };
    if (command === "oauth_callback_cancel") return;
    if (command === "identity_sign_builderlab_binding") return event;
    if (command === "plugin_host_request") {
      const reply = replies[input.request.url.slice(API.length)];
      if (!reply) throw new Error(`Unexpected ${input.request.url}`);
      const status =
        bound || !input.request.url.endsWith("/current") ? 200 : 404;
      return { status, headers: {}, body: JSON.stringify(reply()) };
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const dispose = await mountCard();
  try {
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Sign in with Builderlab" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Connect Buzz identity" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Connect Buzz identity" }),
      ).toBeNull(),
    );
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(document.body).not.toHaveTextContent("private-token");
    expect(fetch).not.toHaveBeenCalled();

    const begin = native.invoke.mock.calls.find(
      ([command]) => command === "oauth_callback_begin",
    )?.[1];
    const login = new URL(begin.authorizationUrl);
    expect(`${login.origin}${login.pathname}`).toBe(`${API}/v1/auth/login`);
    expect([...login.searchParams]).toEqual([
      ["type", "cli"],
      ["product", "buzz"],
    ]);
    expect(begin).toMatchObject({ useState: true });
    expect(native.invoke).toHaveBeenCalledWith("oauth_callback_cancel", {
      id: "attempt",
    });
    expect(native.invoke).toHaveBeenCalledWith(
      "identity_sign_builderlab_binding",
      { challenge },
    );
    const requests = native.invoke.mock.calls
      .filter(([command]) => command === "plugin_host_request")
      .map(([, input]) => input);
    for (const input of requests)
      expect(input).toMatchObject({
        id: "block.hosted-communities",
        revision: "bundled",
      });
    const verify = requests.find(({ request }) =>
      request.url.endsWith("/verify"),
    )?.request;
    expect(verify.headers).toEqual({
      "Content-Type": "application/json",
      "X-BB-Session-Credential": "private-token",
      Origin: "https://app.builderlab.xyz",
    });
    expect(JSON.parse(verify.body)).toEqual({
      challenge_id: challenge.challenge_id,
      nonce: challenge.nonce,
      signed_payload: JSON.stringify(event),
    });
  } finally {
    await dispose();
  }
});
