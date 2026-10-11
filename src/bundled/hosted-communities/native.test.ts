import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { AuthenticatedRequest } from "../../features/federated-identity/service";
import { federatedFixture } from "../../features/federated-identity/testing";
import { createNativeBackend } from "./native";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Reply = { status?: number; body: unknown };
function setup(
  replies: Record<string, Reply | (() => Reply | Promise<Reply>)>,
  commands: Record<string, (input?: Record<string, unknown>) => unknown> = {},
) {
  const h = federatedFixture();
  const requests: AuthenticatedRequest[] = [];
  h.request.mockImplementation(async (input) => {
    requests.push(input);
    const entry = replies[input.path.slice("/api/goose".length)];
    if (!entry) throw new Error("Host request failed");
    const { status = 200, body } = await (typeof entry === "function"
      ? entry()
      : entry);
    return {
      status,
      headers: {},
      body: typeof body === "string" ? body : JSON.stringify(body),
    };
  });
  const nativeInvoke = vi.mocked(invoke);
  nativeInvoke.mockImplementation(async (name, input) => {
    const handler = commands[name];
    if (!handler) throw new Error(`Unexpected ${name}`);
    return handler(input as Record<string, unknown> | undefined);
  });
  return {
    ...createNativeBackend(h.service),
    ...h,
    requests,
    invoke: nativeInvoke,
  };
}
const signedIn = {};
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
    },
  });
  expect(JSON.stringify(value)).not.toContain("token");
  await backend.send("archive", { community_id: "c", extra: "dropped" });
  expect(requests.at(-1)).toEqual({
    path: "/api/goose/v1/buzz/communities/archive",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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

it("sign-out delegates to the shared owner", async () => {
  const { backend, service } = setup({});
  await login(backend);
  await backend.send("sign-out");
  expect(service.signOut).toHaveBeenCalledOnce();
  expect(await backend.auth()).toBeNull();
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
    expect(requests.at(-1)?.path).toBe(
      "/api/goose/v1/buzz/nostr-identities/challenge",
    ),
  );
  await backend.send("sign-out");
  issue({ body: { challenge_id: "x" } });
  await expect(binding).rejects.toThrow("Federated session changed");
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
  expect(requests.some(({ path }) => path.endsWith("/verify"))).toBe(false);
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
    native.requests.filter(({ path }) => path.endsWith("/verify"));
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
  expect(native.invoke).toHaveBeenCalledWith("nsec_backup_retry", {
    source: "hosted",
  });
  expect(verified()[0]).toMatchObject({
    headers: { "Content-Type": "application/json" },
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
])("does not verify a signature completed after %s", async (_, end) => {
  const native = bindingWithHeldSignature();
  const { binding, release } = await native.start();
  await end(native);
  release();
  await expect(binding).rejects.toThrow("Federated session changed");
  expect(native.verified()).toEqual([]);
});
