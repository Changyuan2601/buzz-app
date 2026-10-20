import { expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import {
  bindingEvent,
  builderlabResponseStatus,
  createBuilderlab,
} from "./builderlab.mjs";

const BUILDERLAB_ORIGIN = "https://hosting.example:8443";
const BUILDERLAB_URL = `${BUILDERLAB_ORIGIN}/deployment/`;
const API = `${BUILDERLAB_URL}api/goose`;

const challenge = {
  challenge_id: "0b7e3c1e-7a51-4c4a-9d3e-2f0b8a6c1d22",
  nonce: "a".repeat(43),
  verification_code: "123456",
  origin: BUILDERLAB_ORIGIN,
  expires_at: "2030-01-01T00:00:00Z",
};
const now = Date.parse("2029-12-31T23:59:00Z");

it("signs the kind 24243 binding challenge with the desktop tag set", () => {
  const key = generateSecretKey();
  const event = bindingEvent(key, challenge, BUILDERLAB_ORIGIN, now);
  expect(verifyEvent(event)).toBe(true);
  expect(event).toMatchObject({
    kind: 24243,
    content: "",
    pubkey: getPublicKey(key),
    created_at: Math.floor(now / 1000),
  });
  expect(event.tags).toEqual([
    ["challenge_id", challenge.challenge_id],
    ["nonce", challenge.nonce],
    ["verification_code", "123456"],
    ["audience", "buzz:nostr-identity"],
    ["action", "bind_nostr_identity"],
    ["protocol", "buzz-nostr-identity"],
    ["version", "1"],
    ["origin", BUILDERLAB_ORIGIN],
    ["expires_at", challenge.expires_at],
  ]);
});

it.each([
  ["challenge id", { challenge_id: "not-a-uuid" }],
  ["nonce", { nonce: "short" }],
  ["verification code", { verification_code: "12345a" }],
  ["origin", { origin: "https://evil.example" }],
  ["expiry", { expires_at: "2029-12-31T23:00:00Z" }],
])("refuses to sign a challenge with an invalid %s", (_label, patch) => {
  expect(() =>
    bindingEvent(
      generateSecretKey(),
      { ...challenge, ...patch },
      BUILDERLAB_ORIGIN,
      now,
    ),
  ).toThrow("Invalid Nostr identity challenge");
});

function account(responses = {}) {
  const requests = [];
  let opened;
  const fetch = async (url, init = {}) => {
    const path = url.slice(API.length);
    requests.push({ path, init, url });
    const reply = responses[path];
    if (reply) return reply(init);
    if (path === "/v1/auth/login/exchange")
      return Response.json({
        session_credential: "secret",
        expires_at: "2030",
      });
    if (path === "/v1/auth/me")
      return Response.json({
        email: "a@example.com",
        name: "A",
        expires_at: "2030",
      });
    return Response.json({ ok: true });
  };
  const key = generateSecretKey();
  let signs = 0;
  const builderlab = createBuilderlab({
    url: BUILDERLAB_URL,
    key: () => {
      signs += 1;
      return key;
    },
    fetch,
    open: async (url) => {
      opened = new URL(url);
    },
  });
  return {
    builderlab,
    requests,
    key,
    opened: () => opened,
    signs: () => signs,
  };
}
async function signIn(h) {
  const pending = h.builderlab.login(new AbortController().signal);
  while (!h.opened()) await new Promise((resolve) => setTimeout(resolve, 5));
  const returnTo = h.opened().searchParams.get("returnTo");
  expect(new URL(returnTo).hostname).toBe("127.0.0.1");
  await globalThis.fetch(`${returnTo}?code=one-time`);
  return pending;
}

it("completes browser sign-in through a loopback callback without exposing the credential", async () => {
  const h = account();
  const auth = await signIn(h);
  expect(auth).toEqual({
    email: "a@example.com",
    name: "A",
    expiresAt: "2030",
    capabilities: { can_delete_buzz_communities: false },
  });
  expect(JSON.stringify(auth)).not.toContain("secret");
  expect(`${h.opened().origin}${h.opened().pathname}`).toBe(
    `${API}/v1/auth/login`,
  );
  expect(h.opened().searchParams.get("product")).toBe("buzz");
  expect(JSON.parse(h.requests[0].init.body)).toEqual({ code: "one-time" });
  await h.builderlab.call("list", {});
  expect(h.requests.at(-1).url).toBe(`${API}/v1/buzz/communities/list`);
  expect(h.requests.at(-1).init.headers).toMatchObject({
    "X-BB-Session-Credential": "secret",
    Origin: BUILDERLAB_ORIGIN,
  });
  h.builderlab.signOut();
  expect(await h.builderlab.auth()).toBeNull();
  await expect(h.builderlab.call("list", {})).rejects.toThrow(
    "Sign in to Builderlab first",
  );
});

it("cancels a pending sign-in", async () => {
  const h = account();
  const abort = new AbortController();
  const pending = h.builderlab.login(abort.signal);
  while (!h.opened()) await new Promise((resolve) => setTimeout(resolve, 5));
  abort.abort();
  await expect(pending).rejects.toThrow("canceled");
});

it("forwards only allowlisted fields and ignores unknown actions", async () => {
  const h = account();
  await signIn(h);
  await h.builderlab.call("transfer", {
    communityId: "c1",
    transfereeNpub: "npub1x",
    extra: "dropped",
  });
  expect(h.requests.at(-1).path).toBe("/v1/buzz/communities/transfer");
  expect(JSON.parse(h.requests.at(-1).init.body)).toEqual({
    communityId: "c1",
    transfereeNpub: "npub1x",
  });
  await expect(h.builderlab.call("archive", {})).rejects.toThrow(
    "Missing community_id",
  );
  expect(await h.builderlab.call("toString", {})).toBeUndefined();
  expect(await h.builderlab.call("../auth/me", {})).toBeUndefined();
});

it("forwards the exact deletion tuple for both admission and same-UUID replay", async () => {
  const h = account({
    "/v1/buzz/communities/delete": () =>
      Response.json({ status: "submitted" }, { status: 202 }),
  });
  await signIn(h);
  const request = {
    community_id: "community",
    host: "North.communities.buzz.xyz",
    request_id: "11111111-1111-4111-8111-111111111111",
    acknowledgement_version: 1,
    owner_pubkey: "must-not-pass",
    extra: "dropped",
  };
  const admitted = await h.builderlab.call("delete", request);
  expect(builderlabResponseStatus(admitted)).toBe(202);
  expect(h.requests.at(-1).path).toBe("/v1/buzz/communities/delete");
  expect(JSON.parse(h.requests.at(-1).init.body)).toEqual({
    community_id: request.community_id,
    host: request.host,
    request_id: request.request_id,
    acknowledgement_version: 1,
  });
  const replay = await h.builderlab.call("delete", request);
  expect(builderlabResponseStatus(replay)).toBe(202);
  expect(h.requests.at(-1).path).toBe("/v1/buzz/communities/delete");
  expect(JSON.parse(h.requests.at(-1).init.body)).toEqual({
    community_id: request.community_id,
    host: request.host,
    request_id: request.request_id,
    acknowledgement_version: 1,
  });
  expect(
    h.requests.filter((item) => item.path === "/v1/buzz/communities/delete"),
  ).toHaveLength(2);
});

it("does not expose a removed deletion receipt action", async () => {
  const h = account({});
  expect(await h.builderlab.call("delete-receipt", {})).toBeUndefined();
  expect(h.requests).toHaveLength(0);
});

it.each([
  [true, true],
  ["true", false],
  [1, false],
  [undefined, false],
])("maps delete capability %j to literal true=%s", async (value, expected) => {
  const h = account({
    "/v1/auth/me": () =>
      Response.json({
        email: "a@example.com",
        expires_at: "2030",
        capabilities: { can_delete_buzz_communities: value },
      }),
  });
  expect((await signIn(h)).capabilities).toEqual({
    can_delete_buzz_communities: expected,
  });
});

it.each([
  ["malformed", "{"],
  ["oversize", JSON.stringify({ value: "x".repeat(70_000) })],
])("rejects a %s downstream response after dispatch", async (_label, body) => {
  const h = account({
    "/v1/buzz/communities/delete": () =>
      new Response(body, {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
  });
  await signIn(h);
  await expect(
    h.builderlab.call("delete", {
      community_id: "community",
      host: "north.communities.buzz.xyz",
      request_id: "11111111-1111-4111-8111-111111111111",
      acknowledgement_version: 1,
    }),
  ).rejects.toThrow(/invalid response|too large/);
});

it("binds the local key by verifying a signed challenge and passes structured errors through", async () => {
  const h = account({
    "/v1/buzz/nostr-identities/challenge": () =>
      Response.json({ ...challenge, expires_at: "2099-01-01T00:00:00Z" }),
    "/v1/buzz/nostr-identities/verify": () =>
      Response.json({ identity: { pubkey_hex: "ok" } }),
    "/v1/buzz/communities": () =>
      Response.json({ error: { code: "taken" } }, { status: 409 }),
  });
  await signIn(h);
  expect(await h.builderlab.bind()).toEqual({ identity: { pubkey_hex: "ok" } });
  const verify = JSON.parse(h.requests.at(-1).init.body);
  const signed = JSON.parse(verify.signed_payload);
  expect(verifyEvent(signed)).toBe(true);
  expect(signed.pubkey).toBe(getPublicKey(h.key));
  expect(await h.builderlab.call("create", { name: "north" })).toEqual({
    error: { code: "taken" },
  });
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it.each(["cancel", "sign-out"])(
  "a %s during a held code exchange never restores the session",
  async (mode) => {
    const started = deferred();
    const release = deferred();
    const h = account({
      "/v1/auth/login/exchange": async () => {
        started.resolve();
        await release.promise;
        return Response.json({
          session_credential: "late",
          expires_at: "2030",
        });
      },
    });
    const abort = new AbortController();
    const pending = h.builderlab.login(abort.signal).catch((error) => error);
    while (!h.opened()) await new Promise((resolve) => setTimeout(resolve, 5));
    await globalThis.fetch(`${h.opened().searchParams.get("returnTo")}?code=x`);
    await started.promise;
    if (mode === "cancel") abort.abort();
    else h.builderlab.signOut();
    release.resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(await h.builderlab.auth()).toBeNull();
    await expect(h.builderlab.call("list", {})).rejects.toThrow(
      "Sign in to Builderlab first",
    );
  },
);

it.each(["error", "success"])(
  "a stale account check (%s) cannot clear or describe a newer session",
  async (outcome) => {
    const started = deferred();
    const release = deferred();
    let hold = false;
    const h = account({
      "/v1/auth/login/exchange": (init) =>
        Response.json({
          session_credential: JSON.parse(init.body).code,
          expires_at: "2030",
        }),
      "/v1/auth/me": async (init) => {
        const session = init.headers["X-BB-Session-Credential"];
        if (session === "A" && hold) {
          started.resolve();
          await release.promise;
          if (outcome === "error") return Response.json({}, { status: 401 });
        }
        return Response.json({ email: session, expires_at: "2030" });
      },
    });
    const signInAs = async (code) => {
      const before = h.opened();
      const pending = h.builderlab.login(new AbortController().signal);
      while (h.opened() === before)
        await new Promise((resolve) => setTimeout(resolve, 5));
      await globalThis.fetch(
        `${h.opened().searchParams.get("returnTo")}?code=${code}`,
      );
      return pending;
    };
    await signInAs("A");
    hold = true;
    const stale = h.builderlab.auth().catch((error) => error);
    await started.promise;
    h.builderlab.signOut();
    await signInAs("B");
    release.resolve();
    expect(await stale).toBeInstanceOf(Error);
    expect(await h.builderlab.auth()).toMatchObject({ email: "B" });
  },
);

it.each(["sign-out", "new-login"])(
  "a %s during a held binding challenge never signs or verifies",
  async (mode) => {
    const started = deferred();
    const release = deferred();
    const h = account({
      "/v1/buzz/nostr-identities/challenge": async () => {
        started.resolve();
        await release.promise;
        return Response.json({
          ...challenge,
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    });
    await signIn(h);
    const pending = h.builderlab.bind().catch((error) => error);
    await started.promise;
    if (mode === "sign-out") h.builderlab.signOut();
    else h.builderlab.login(new AbortController().signal).catch(() => {});
    release.resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(h.signs()).toBe(0);
    expect(
      h.requests.some(
        ({ path }) => path === "/v1/buzz/nostr-identities/verify",
      ),
    ).toBe(false);
    h.builderlab.signOut();
  },
);

it("rejects malformed and wrong callbacks without ending the listener", async () => {
  const h = account();
  const pending = h.builderlab.login(new AbortController().signal);
  while (!h.opened()) await new Promise((resolve) => setTimeout(resolve, 5));
  const returnTo = new URL(h.opened().searchParams.get("returnTo"));
  const { request } = await import("node:http");
  const raw = (path) =>
    new Promise((resolve, reject) =>
      request({ host: "127.0.0.1", port: returnTo.port, path }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
        .on("error", reject)
        .end(),
    );
  expect(await raw("//[")).toBe(400);
  expect(await raw("/callback/wrong?code=x")).toBe(404);
  await globalThis.fetch(`${returnTo}?code=one-time`);
  expect(await pending).toMatchObject({ email: "a@example.com" });
});

it.each(["", "http://hosting.example", "https://user:secret@hosting.example"])(
  "refuses unconfigured or unsafe hosting URL %s before opening sign-in",
  async (url) => {
    const open = vi.fn();
    const fetch = vi.fn();
    const backend = createBuilderlab({
      url,
      key: generateSecretKey,
      open,
      fetch,
    });
    await expect(backend.login(new AbortController().signal)).rejects.toThrow(
      /not configured|does not support/,
    );
    expect(open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);
