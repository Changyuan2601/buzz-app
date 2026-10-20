import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FederatedIdentityService,
  type FederatedIdentity,
  type SessionSnapshot,
} from "./service";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const signedOut: SessionSnapshot = {
  status: "signed-out",
  authority: {
    id: "test",
    identityOrigin: "https://identity.example",
    apiBasePath: "/api/",
  },
  revision: "out",
  email: null,
  failure: null,
};
const signedIn: SessionSnapshot = {
  ...signedOut,
  status: "signed-in",
  revision: "in",
};
const roots: Context[] = [];
let publish: (event: { payload: SessionSnapshot }) => void;
let unlisten: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset().mockResolvedValue(signedOut);
  unlisten = vi.fn();
  vi.mocked(listen).mockImplementation(async (_name, handler) => {
    publish = handler as typeof publish;
    return unlisten;
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllEnvs();
});
function setup() {
  const root = new Context();
  roots.push(root);
  const service = new FederatedIdentityService(root);
  return { root, service };
}
async function plugin(root: Context) {
  let service!: FederatedIdentity;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "artifact" } })
    .plugin({
      inject: ["federatedIdentity"],
      apply(ctx: Context) {
        service = ctx.federatedIdentity;
      },
    });
  await fiber;
  return { service, fiber };
}

it("keeps a native event newer than an in-flight restore and ignores delivery after disposal", async () => {
  let finish!: (snapshot: SessionSnapshot) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { root, service } = setup();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  try {
    const { snapshot, subscribe } = service;
    const changed = vi.fn();
    const release = subscribe(changed);
    publish({ payload: signedIn });
    expect(snapshot()).toBe(signedIn);
    expect(changed).toHaveBeenCalledOnce();
    release();
  } finally {
    finish(signedOut);
  }
  await vi.waitFor(() => expect(service.snapshot()).toBe(signedIn));
  await root.fiber.dispose();
  publish({ payload: signedOut });
  expect(service.snapshot()).toBe(signedIn);
  expect(unlisten).toHaveBeenCalledOnce();
  await expect(service.signIn()).rejects.toThrow("desktop");
});

it("fails closed when the native session event listener cannot be registered", async () => {
  vi.mocked(listen).mockRejectedValue(new Error("permission denied"));
  const { service } = setup();

  await vi.waitFor(() =>
    expect(service.snapshot()).toMatchObject({
      status: "unavailable",
      authority: null,
      failure: "native-unavailable",
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith("federated_identity_snapshot");
});

it("uses the caller's native grant registration, shares only public account state, and retries failed admission", async () => {
  const { root, service } = setup();
  const a = await plugin(root),
    b = await plugin(root);
  publish({ payload: signedIn });
  expect(a.service.snapshot()).toBe(service.snapshot());
  expect(b.service.snapshot()).toBe(service.snapshot());
  let rejected = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "federated_identity_register" && !rejected) {
      rejected = true;
      throw "Plugin is disabled";
    }
    if (command === "federated_identity_request")
      return { status: 200, headers: {}, body: "{}" };
  });
  const request = { path: "/api/list", method: "POST" as const, body: "{}" };
  await expect(a.service.request(request)).rejects.toThrow("disabled");
  await expect(a.service.request(request)).resolves.toMatchObject({
    status: 200,
  });
  await b.service.request(request);
  const registrations = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "federated_identity_register")
    .map(
      ([, args]) =>
        args as { id: string; revision: string; registration: string },
    );
  expect(registrations).toHaveLength(3);
  expect(new Set(registrations.map((item) => item.registration)).size).toBe(3);
  expect(
    registrations.every(
      (item) => item.id === "example.plugin" && item.revision === "artifact",
    ),
  ).toBe(true);
  await a.fiber.dispose();
  expect(invoke).toHaveBeenCalledWith("federated_identity_unregister", {
    registration: registrations[1]?.registration,
  });
  expect(b.service.snapshot().status).toBe("signed-in");
  await expect(service.request(request)).rejects.toThrow(
    "active desktop plugin",
  );
});

it("retires a registration admitted after plugin unload without forwarding the request", async () => {
  const { root } = setup();
  const a = await plugin(root);
  let finish!: () => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "federated_identity_register"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(undefined),
  );
  const request = a.service.request({ path: "/api/list" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await a.fiber.dispose();
  finish();
  await expect(request).rejects.toThrow("retired");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "federated_identity_request",
      ),
  ).toHaveLength(0);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "federated_identity_unregister",
      ),
  ).toHaveLength(2);
});
