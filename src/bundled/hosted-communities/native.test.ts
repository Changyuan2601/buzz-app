import { expect, it, vi } from "vitest";
import type { Host, HostRequest } from "../../features/host/service";
import { createNativeBackend } from "./native";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const API = "https://app.builderlab.xyz/api/goose";
type Reply = { status?: number; body: unknown };

function setup(
  replies: Record<string, Reply | (() => Reply | Promise<Reply>)>,
  commands: Record<string, (input?: Record<string, unknown>) => unknown> = {},
) {
  const requests: HostRequest[] = [];
  const host: Host = {
    fetch: vi.fn(),
    runCommand: async () => null,
    request: vi.fn(async (input: HostRequest) => {
      requests.push(input);
      const entry = replies[input.url.slice(API.length)];
      if (!entry) throw "Host request failed";
      const { status = 200, body } = await (typeof entry === "function"
        ? entry()
        : entry);
      return {
        status,
        headers: {},
        body: typeof body === "string" ? body : JSON.stringify(body),
      };
    }),
  };
  const invoke = vi.fn(
    async (name: string, input?: Record<string, unknown>) => {
      const handlers: typeof commands = {
        oauth_callback_begin: () => ({ id: "attempt" }),
        oauth_callback_wait: () => ({ parameters: [["code", "one-time"]] }),
        oauth_callback_cancel: () => undefined,
        ...commands,
      };
      const handler = handlers[name];
      if (!handler) throw `Unexpected ${name}`;
      return handler(input);
    },
  );
  const native = createNativeBackend(host, {
    invoke: invoke as <T>(n: string, a?: Record<string, unknown>) => Promise<T>,
  });
  return { ...native, requests, invoke };
}
const signedIn = {
  "/v1/auth/login/exchange": {
    body: { session_credential: "token", expires_at: "2030" },
  },
  "/v1/auth/me": {
    body: {
      email: "a@example.com",
      expires_at: "2030",
      capabilities: { can_delete_buzz_communities: true },
    },
  },
};
const login = (backend: ReturnType<typeof setup>["backend"]) =>
  backend.send("login", {}, new AbortController().signal);

it("reports no account before sign-in and refuses account calls", async () => {
  const { backend, requests } = setup({});
  await expect(backend.auth()).resolves.toBeNull();
  await expect(backend.send("list")).rejects.toThrow(
    "Sign in to Builderlab first",
  );
  expect(requests).toEqual([]);
});

it("keeps the credential out of results and forwards only allowlisted fields", async () => {
  const { backend, requests } = setup({
    ...signedIn,
    "/v1/buzz/communities/archive": { body: { community: { id: "c" } } },
  });
  const { value } = await login(backend);
  expect(value).toEqual({
    auth: {
      email: "a@example.com",
      expiresAt: "2030",
      capabilities: { can_delete_buzz_communities: true },
    },
  });
  expect(JSON.stringify(value)).not.toContain("token");
  await backend.send("archive", { community_id: "c", extra: "dropped" });
  expect(requests.at(-1)).toEqual({
    url: `${API}/v1/buzz/communities/archive`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BB-Session-Credential": "token",
      Origin: "https://app.builderlab.xyz",
    },
    body: JSON.stringify({ community_id: "c" }),
  });
  await expect(backend.send("archive", {})).rejects.toThrow(
    "Missing community_id",
  );
  await expect(backend.send("unknown")).rejects.toThrow(
    "Unknown Builderlab route",
  );
});

it("rejects a code exchange whose expiry does not match the session", async () => {
  const { backend } = setup({
    ...signedIn,
    "/v1/auth/me": { body: { email: "a@example.com", expires_at: "2031" } },
  });
  await expect(login(backend)).rejects.toThrow(
    "Builderlab session expiry did not match code exchange",
  );
  await expect(backend.auth()).resolves.toBeNull();
});

it("surfaces a provider callback error and always releases the listener", async () => {
  const { backend, invoke } = setup(signedIn, {
    oauth_callback_wait: () => ({
      parameters: [
        ["error", "access_denied"],
        ["error_description", "Denied"],
      ],
    }),
  });
  await expect(login(backend)).rejects.toThrow("Denied");
  expect(invoke).toHaveBeenCalledWith("oauth_callback_cancel", {
    id: "attempt",
  });
});

it("cancels the native listener when sign-in is aborted", async () => {
  let release: () => void = () => {};
  const { backend, invoke } = setup(signedIn, {
    oauth_callback_wait: () =>
      new Promise((_, reject) => {
        release = () => reject("canceled");
      }),
    oauth_callback_cancel: () => release(),
  });
  const abort = new AbortController();
  const pending = backend.send("login", {}, abort.signal);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("oauth_callback_wait", {
      id: "attempt",
    }),
  );
  abort.abort();
  await expect(pending).rejects.toThrow("Builderlab authentication canceled");
  expect(invoke).toHaveBeenCalledWith("oauth_callback_cancel", {
    id: "attempt",
  });
});

it("passes structured errors through with their status and rejects others", async () => {
  let reply: Reply = {
    status: 409,
    body: { error: { code: "deletion_conflict" } },
  };
  const { backend } = setup({
    ...signedIn,
    "/v1/buzz/communities/list": () => reply,
  });
  await login(backend);
  await expect(backend.send("list")).resolves.toEqual({
    status: 409,
    value: { error: { code: "deletion_conflict" } },
  });
  reply = { status: 502, body: "<html>" };
  await expect(backend.send("list")).rejects.toThrow(
    "Builderlab returned an invalid response",
  );
  reply = { status: 500, body: {} };
  await expect(backend.send("list")).rejects.toThrow(
    "Builderlab request failed (HTTP 500).",
  );
  reply = { body: [] };
  await expect(backend.send("list")).rejects.toThrow(
    "Builderlab request failed (HTTP 200).",
  );
  reply = { body: { padding: "x".repeat(64 * 1024) } };
  await expect(backend.send("list")).rejects.toThrow(
    "Builderlab response was too large",
  );
});

it("turns a host transport rejection into an error", async () => {
  const { backend } = setup(signedIn);
  await login(backend);
  await expect(backend.send("list")).rejects.toThrow("Host request failed");
});

it("clears the session when it can no longer be verified", async () => {
  let me: Reply = signedIn["/v1/auth/me"];
  const { backend } = setup({ ...signedIn, "/v1/auth/me": () => me });
  await login(backend);
  me = { status: 401, body: {} };
  await expect(backend.auth()).rejects.toThrow(
    "Builderlab session check failed with HTTP 401",
  );
  await expect(backend.auth()).resolves.toBeNull();
});

it("forgets the credential on sign-out and plugin disposal", async () => {
  const { backend, dispose } = setup(signedIn);
  await login(backend);
  await expect(backend.send("sign-out")).resolves.toEqual({
    status: 200,
    value: {},
  });
  await expect(backend.auth()).resolves.toBeNull();
  await login(backend);
  dispose();
  await expect(backend.auth()).resolves.toBeNull();
});

it("returns a challenge error without signing", async () => {
  const sign = vi.fn();
  const { backend } = setup(
    {
      ...signedIn,
      "/v1/buzz/nostr-identities/challenge": {
        status: 403,
        body: { error: { code: "unauthorized" } },
      },
    },
    { identity_sign_builderlab_binding: sign },
  );
  await login(backend);
  await expect(backend.send("bind")).resolves.toMatchObject({
    value: { error: { code: "unauthorized" } },
  });
  expect(sign).not.toHaveBeenCalled();
});

it("does not sign a challenge issued to a session that has since ended", async () => {
  let issue: (reply: Reply) => void = () => {};
  const sign = vi.fn();
  const { backend, requests } = setup(
    {
      ...signedIn,
      "/v1/buzz/nostr-identities/challenge": () =>
        new Promise<Reply>((resolve) => {
          issue = resolve;
        }),
    },
    { identity_sign_builderlab_binding: sign },
  );
  await login(backend);
  const binding = backend.send("bind");
  await vi.waitFor(() =>
    expect(requests.at(-1)?.url).toBe(
      `${API}/v1/buzz/nostr-identities/challenge`,
    ),
  );
  await backend.send("sign-out");
  issue({ body: { challenge_id: "x" } });
  await expect(binding).rejects.toThrow("Builderlab session changed");
  expect(sign).not.toHaveBeenCalled();
});

it("forwards a native signing refusal as an error", async () => {
  const { backend, requests } = setup(
    {
      ...signedIn,
      "/v1/buzz/nostr-identities/challenge": {
        body: { challenge_id: "x", origin: "https://example.com" },
      },
    },
    {
      identity_sign_builderlab_binding: () => {
        throw "Invalid Nostr identity challenge";
      },
    },
  );
  await login(backend);
  await expect(backend.send("bind")).rejects.toThrow(
    "Invalid Nostr identity challenge",
  );
  expect(requests.some(({ url }) => url.endsWith("/verify"))).toBe(false);
});

it("reads this device's key from the native identity", async () => {
  const key = "A".repeat(64);
  await expect(
    setup({}, { identity_restore: () => key }).backend.localKey(),
  ).resolves.toBe("a".repeat(64));
  await expect(
    setup({}, { identity_restore: () => null }).backend.localKey(),
  ).resolves.toBeNull();
  await expect(
    setup(
      {},
      {
        identity_restore: () => {
          throw "locked";
        },
      },
    ).backend.localKey(),
  ).resolves.toBeNull();
});

const challenge = {
  challenge_id: "x",
  nonce: "n",
  verification_code: "123456",
  origin: "https://app.builderlab.xyz",
  expires_at: "2030",
};

function bindingWithHeldSignature() {
  let sign: (event: object) => void = () => {};
  const native = setup(
    {
      ...signedIn,
      "/v1/buzz/nostr-identities/challenge": { body: challenge },
      "/v1/buzz/nostr-identities/verify": { body: { identity: {} } },
    },
    {
      identity_sign_builderlab_binding: () =>
        new Promise((resolve) => {
          sign = resolve;
        }),
    },
  );
  const start = async () => {
    await login(native.backend);
    const binding = native.backend.send("bind");
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        "identity_sign_builderlab_binding",
        { challenge },
      ),
    );
    return { binding, release: () => sign({ id: "event" }) };
  };
  const verified = () =>
    native.requests.filter(({ url }) => url.endsWith("/verify"));
  return { ...native, start, verified };
}

it("verifies a signed binding with the session that requested it", async () => {
  const { start, verified } = bindingWithHeldSignature();
  const { binding, release } = await start();
  release();
  await expect(binding).resolves.toEqual({
    status: 200,
    value: { identity: {} },
  });
  expect(verified()).toHaveLength(1);
  expect(verified()[0]).toMatchObject({
    headers: { "X-BB-Session-Credential": "token" },
    body: JSON.stringify({
      challenge_id: "x",
      nonce: "n",
      signed_payload: JSON.stringify({ id: "event" }),
    }),
  });
});

it.each([
  [
    "sign-out",
    (native: ReturnType<typeof bindingWithHeldSignature>) =>
      native.backend.send("sign-out"),
  ],
  [
    "a replacement sign-in",
    (native: ReturnType<typeof bindingWithHeldSignature>) =>
      login(native.backend),
  ],
  [
    "plugin disposal",
    (native: ReturnType<typeof bindingWithHeldSignature>) => native.dispose(),
  ],
])("does not verify a signature completed after %s", async (_, end) => {
  const native = bindingWithHeldSignature();
  const { binding, release } = await native.start();
  await end(native);
  release();
  await expect(binding).rejects.toThrow("Builderlab session changed");
  expect(native.verified()).toEqual([]);
});
