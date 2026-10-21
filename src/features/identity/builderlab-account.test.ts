import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "../../bundled/builderlab/oauth/browser";
import type { HostRequest } from "../host/service";
import { builderlabAccount } from "./builderlab-account";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const credential: Credential = {
  value: "private-token",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: false,
  },
};
const pubkey = "ab".repeat(32);
const answer = (status: number, body: unknown) => ({
  status,
  headers: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});
/** One request stub per call, in order; remembers what was sent. */
function kgoose(...replies: Array<ReturnType<typeof answer> | Error | string>) {
  const sent: HostRequest[] = [];
  const request = vi.fn(async (input: HostRequest) => {
    sent.push(input);
    const reply = replies.shift();
    if (reply === undefined) throw new Error("No reply scripted");
    if (reply instanceof Error || typeof reply === "string") throw reply;
    return reply;
  });
  return { request, sent };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(invoke).mockReset();
});

describe("linkedKey", () => {
  it("POSTs the card's identity route at the tenant with the session credential and reads the bound key", async () => {
    const { request, sent } = kgoose(
      answer(200, { identity: { npub: "npub1x", pubkey_hex: pubkey } }),
    );
    const account = builderlabAccount(
      credential,
      "https://tenant.example",
      request,
    );
    expect(await account.linkedKey()).toBe(pubkey);
    expect(sent).toEqual([
      {
        url: "https://tenant.example/api/goose/v1/buzz/nostr-identities/current",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BB-Session-Credential": "private-token",
          Origin: "https://tenant.example",
        },
        body: "{}",
      },
    ]);
  });

  it("uses the build URL when no tenant was chosen", async () => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example/");
    const { request, sent } = kgoose(
      answer(200, { identity: { pubkey_hex: pubkey } }),
    );
    await builderlabAccount(credential, undefined, request).linkedKey();
    expect(sent[0]?.url).toBe(
      "https://builderlab.example/api/goose/v1/buzz/nostr-identities/current",
    );
    expect(sent[0]?.headers?.Origin).toBe("https://builderlab.example");
  });

  // kgoose's `current` answers 200 with `identity` null or absent for an
  // account with no mapping; MISSING_MAPPING is the list route's shape, kept
  // for symmetry.
  it.each([
    ["a 200 with identity null", answer(200, { identity: null })],
    ["a 200 with no identity", answer(200, {})],
    [
      "a 400 MISSING_MAPPING",
      answer(400, { error: { code: "MISSING_MAPPING" } }),
    ],
    [
      "a 400 setup_needed",
      answer(400, { error: { code: "other", setup_needed: true } }),
    ],
  ])("reads %s as not linked", async (_label, reply) => {
    const { request } = kgoose(reply);
    const account = builderlabAccount(credential, "https://t.example", request);
    expect(await account.linkedKey()).toBeNull();
  });

  it.each([
    [
      "an unauthorized reply",
      answer(401, { error: { code: "unauthorized" } }),
      /can't manage Buzz identities right now/,
    ],
    [
      "a bound identity without a usable key",
      answer(200, { identity: { npub: "npub1x" } }),
      "Builderlab account check failed (HTTP 200: unusable linked key).",
    ],
    [
      "a bound identity with a malformed key",
      answer(200, { identity: { pubkey_hex: "not-hex" } }),
      "Builderlab account check failed (HTTP 200: unusable linked key).",
    ],
    [
      "a non-JSON failure",
      answer(403, "Forbidden"),
      "Builderlab account check failed (HTTP 403: not JSON).",
    ],
    [
      "an unstructured failure",
      answer(500, { message: "boom" }),
      "Builderlab account check failed (HTTP 500).",
    ],
    [
      "a malformed error code",
      answer(400, { error: { code: 42 } }),
      "Could not check this Builderlab account.",
    ],
    [
      "an oversize body",
      answer(200, `{"identity":{"pubkey_hex":"${"a".repeat(70_000)}"}}`),
      "Builderlab account check failed (HTTP 200: response too large).",
    ],
    ["a native refusal string", "host request denied", /host request denied/],
    ["a transport error", new Error("offline"), /offline/],
  ])("fails on %s instead of answering", async (_label, reply, message) => {
    const { request } = kgoose(reply);
    const account = builderlabAccount(credential, "https://t.example", request);
    await expect(account.linkedKey()).rejects.toThrow(message);
  });

  it("warns in development with the route and status, never the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { request } = kgoose(answer(403, "secret body"));
    const account = builderlabAccount(credential, "https://t.example", request);
    await expect(account.linkedKey()).rejects.toThrow(/HTTP 403/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).toBe(
      "Builderlab account check: POST /v1/buzz/nostr-identities/current answered HTTP 403 Builderlab account check failed (HTTP 403: not JSON).",
    );
    expect(warn.mock.calls[0]?.join(" ")).not.toContain("secret body");
  });
});

describe("ownedCommunities", () => {
  it("lists joinable hosts from the card's list route, skipping archived and unusable rows", async () => {
    const { request, sent } = kgoose(
      answer(200, {
        communities: [
          { id: "1", normalized_host: "wss://Design.Example.com" },
          { id: "2", normalized_host: "buzz.example.org:8443" },
          {
            id: "3",
            normalized_host: "old.example.org",
            archived_at: "2026-01-01T00:00:00Z",
          },
          { id: "4", normalized_host: "" },
          { id: "5", normalized_host: "bad host/with/path" },
          { id: "6" },
        ],
      }),
    );
    const account = builderlabAccount(credential, "https://t.example", request);
    expect(await account.ownedCommunities()).toEqual([
      { host: "design.example.com", url: "https://design.example.com" },
      { host: "buzz.example.org:8443", url: "https://buzz.example.org:8443" },
    ]);
    expect(sent[0]?.url).toBe(
      "https://t.example/api/goose/v1/buzz/communities/list",
    );
  });

  it("answers an unlinked account with no communities and fails on other errors", async () => {
    const unlinked = builderlabAccount(
      credential,
      "https://t.example",
      kgoose(answer(400, { error: { code: "missing_mapping" } })).request,
    );
    expect(await unlinked.ownedCommunities()).toEqual([]);
    const failing = builderlabAccount(
      credential,
      "https://t.example",
      kgoose(answer(503, { error: { code: "relay_unavailable" } })).request,
    );
    await expect(failing.ownedCommunities()).rejects.toThrow(
      /temporarily unavailable/,
    );
    const unparseable = builderlabAccount(
      credential,
      "https://t.example",
      kgoose(answer(502, "<html>bad gateway</html>")).request,
    );
    await expect(unparseable.ownedCommunities()).rejects.toThrow(
      "Builderlab community list failed (HTTP 502: not JSON).",
    );
  });
});

describe("bind", () => {
  const challenge = {
    challenge_id: "550e8400-e29b-41d4-a716-446655440000",
    nonce: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi01234_-7",
    verification_code: "123456",
    origin: "https://tenant.example",
    expires_at: "2999-01-01T00:00:00Z",
  };
  const event = { id: "e".repeat(64), kind: 24243, sig: "s".repeat(128) };
  const unbound = answer(200, { identity: null });
  const bound = (key: string) => answer(200, { identity: { pubkey_hex: key } });
  const at = (origin: string) => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BB-Session-Credential": "private-token",
      Origin: origin,
    },
  });

  it("reads the bound key, then challenges at the tenant, signs natively and verifies with the signed event", async () => {
    vi.mocked(invoke).mockResolvedValue(event);
    const { request, sent } = kgoose(
      unbound,
      // Only the five challenge fields reach the native signer.
      answer(200, { ...challenge, created_at: "2026-01-01T00:00:00Z" }),
      bound(pubkey),
    );
    const account = builderlabAccount(
      credential,
      "https://tenant.example",
      request,
    );
    await account.bind(pubkey);
    const api = "https://tenant.example/api/goose/v1/buzz/nostr-identities";
    expect(sent).toEqual([
      { url: `${api}/current`, ...at("https://tenant.example"), body: "{}" },
      {
        url: `${api}/challenge`,
        ...at("https://tenant.example"),
        body: JSON.stringify({ origin: "https://tenant.example" }),
      },
      {
        url: `${api}/verify`,
        ...at("https://tenant.example"),
        body: JSON.stringify({
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          signed_payload: JSON.stringify(event),
        }),
      },
    ]);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["identity_sign_builderlab_binding", { challenge }],
    ]);
  });

  it("challenges for the build URL's origin when no tenant was chosen", async () => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example/");
    vi.mocked(invoke).mockResolvedValue(event);
    const { request, sent } = kgoose(
      unbound,
      answer(200, { ...challenge, origin: "https://builderlab.example" }),
      bound(pubkey),
    );
    await builderlabAccount(credential, undefined, request).bind(pubkey);
    expect(sent.map(({ url }) => url)).toEqual(
      ["current", "challenge", "verify"].map(
        (path) =>
          `https://builderlab.example/api/goose/v1/buzz/nostr-identities/${path}`,
      ),
    );
    expect(sent.map(({ headers }) => headers?.Origin)).toEqual(
      Array(3).fill("https://builderlab.example"),
    );
    expect(sent[1]?.body).toBe(
      JSON.stringify({ origin: "https://builderlab.example" }),
    );
  });

  it("sends nothing more when the account already holds this key", async () => {
    const { request, sent } = kgoose(bound(pubkey));
    await builderlabAccount(credential, "https://t.example", request).bind(
      pubkey,
    );
    expect(sent.map(({ url }) => url)).toEqual([
      "https://t.example/api/goose/v1/buzz/nostr-identities/current",
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a challenge for an account bound to another key",
      [answer(409, { error: { code: "identity_already_bound" } })],
      "This Builderlab account is connected to another Buzz identity.",
    ],
    [
      "a verify for a key bound to another account",
      [
        answer(200, challenge),
        answer(409, { error: { code: "pubkey_already_bound" } }),
      ],
      "This Buzz identity is connected to another Builderlab account.",
    ],
    [
      "a non-JSON challenge answer",
      [answer(502, "<html>bad gateway</html>")],
      "Builderlab account link failed (HTTP 502: not JSON).",
    ],
    [
      "a non-JSON verify answer",
      [answer(200, challenge), answer(403, "Forbidden")],
      "Builderlab account link failed (HTTP 403: not JSON).",
    ],
    [
      "a verify that confirms another key",
      [answer(200, challenge), bound("cd".repeat(32))],
      "Builderlab account link failed (HTTP 200: link not confirmed).",
    ],
    [
      "a verify that confirms no key",
      [answer(200, challenge), answer(200, {})],
      "Builderlab account link failed (HTTP 200: link not confirmed).",
    ],
  ])(
    "fails on %s with the card's or the step's copy",
    async (_label, replies, message) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(invoke).mockResolvedValue(event);
      const { request, sent } = kgoose(unbound, ...replies);
      const account = builderlabAccount(
        credential,
        "https://t.example",
        request,
      );
      await expect(account.bind(pubkey)).rejects.toThrow(message);
      expect(sent).toHaveLength(1 + replies.length);
      // A refused challenge is never signed.
      expect(invoke).toHaveBeenCalledTimes(replies.length - 1);
    },
  );

  it("surfaces the native signer's refusal and never verifies", async () => {
    vi.mocked(invoke).mockRejectedValue("Invalid Nostr identity challenge");
    const { request, sent } = kgoose(unbound, answer(200, challenge));
    const account = builderlabAccount(credential, "https://t.example", request);
    await expect(account.bind(pubkey)).rejects.toThrow(
      "Invalid Nostr identity challenge",
    );
    expect(sent).toHaveLength(2);
  });
});
