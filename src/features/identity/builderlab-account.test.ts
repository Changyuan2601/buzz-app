import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "../../bundled/builderlab/oauth/browser";
import type { HostRequest } from "../host/service";
import { builderlabAccount } from "./builderlab-account";

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
