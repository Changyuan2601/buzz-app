import { expect, it, vi } from "vitest";
import { federatedFixture } from "../../features/federated-identity/testing";
import { createBuilderlabSession } from "./session";

function fixture() {
  const federated = federatedFixture("user", "a@example.com");
  federated.request.mockResolvedValue(account(true));
  return { ...federated, session: createBuilderlabSession(federated.session) };
}
const account = (canUseRemoteAgents: unknown, status = 200) => ({
  status,
  headers: {},
  body: JSON.stringify({
    capabilities: { can_use_remote_agents: canUseRemoteAgents },
  }),
});
const access = (h: ReturnType<typeof fixture>) =>
  h.session.snapshot().account?.remoteAgents;
const signal = () => new AbortController().signal;

it("projects the native session without a token and keeps one credential per revision", async () => {
  const h = fixture();
  expect(() => h.session.credential()).toThrow("Sign in");
  await h.session.signIn();
  const credential = h.session.credential();
  expect(credential).toEqual({
    revision: "user:1",
    origin: "https://builderlab.example",
    apiBasePath: "/api/goose/",
    account: { subject: "a@example.com", email: "a@example.com" },
  });
  await vi.waitFor(() => expect(access(h)).toBe("allowed"));
  expect(h.session.snapshot()).toEqual({
    status: "signed-in",
    account: {
      subject: "a@example.com",
      email: "a@example.com",
      remoteAgents: "allowed",
    },
  });
  h.publish({ email: "a@example.com" });
  expect(h.session.credential()).toBe(credential);
  await h.session.signOut();
  expect(() => h.session.credential()).toThrow("Sign in");
});

it("joins a running login instead of starting another", async () => {
  const h = fixture();
  h.publish({ status: "signing-in" });
  const waiting = h.session.ensureSignedIn(signal());
  expect(h.service.signIn).not.toHaveBeenCalled();
  h.publish({ status: "signed-in", revision: "user:9" });
  await expect(waiting).resolves.toBeUndefined();
});

it("rejects creation waits on a failed, canceled, aborted or disposed login", async () => {
  const failed = fixture();
  vi.mocked(failed.service.signIn).mockRejectedValueOnce(
    new Error("Browser could not open."),
  );
  await expect(failed.session.ensureSignedIn(signal())).rejects.toThrow(
    "Browser could not open.",
  );

  const canceled = fixture();
  canceled.publish({ status: "signing-in" });
  const pending = canceled.session.ensureSignedIn(signal());
  await canceled.session.cancel();
  await expect(pending).rejects.toThrow("canceled");

  const aborted = fixture();
  aborted.publish({ status: "signing-in" });
  const controller = new AbortController();
  const held = aborted.session.ensureSignedIn(controller.signal);
  controller.abort(new DOMException("Stop", "AbortError"));
  await expect(held).rejects.toMatchObject({ name: "AbortError" });

  const disposed = fixture();
  disposed.publish({ status: "signing-in" });
  const closing = disposed.session.ensureSignedIn(signal());
  disposed.session.dispose();
  await expect(closing).rejects.toThrow("closed");
  expect(disposed.session.snapshot().status).toBe("signed-out");
});

it("reads the permission once per sign-in revision from /v1/auth/me", async () => {
  const h = fixture();
  h.request.mockResolvedValueOnce(account(false));
  await h.session.signIn();
  await vi.waitFor(() => expect(access(h)).toBe("denied"));
  expect(h.request).toHaveBeenCalledExactlyOnceWith({
    path: "/api/goose/v1/auth/me",
    method: "GET",
    headers: { Accept: "application/json" },
  });
  h.publish({ email: "a@example.com" });
  expect(h.request).toHaveBeenCalledTimes(1);
  await h.session.signOut();
  await h.session.signIn();
  await vi.waitFor(() => expect(access(h)).toBe("allowed"));
  expect(h.request).toHaveBeenCalledTimes(2);
});

it.each([
  ["a non-true permission", account("true")],
  ["a missing capability", { status: 200, headers: {}, body: "{}" }],
])("denies %s", async (_name, reply) => {
  const h = fixture();
  h.request.mockResolvedValueOnce(reply);
  await h.session.signIn();
  await vi.waitFor(() => expect(access(h)).toBe("denied"));
});

it.each([
  ["a 401", account(true, 401)],
  ["a 500", account(true, 500)],
  ["invalid JSON", { status: 200, headers: {}, body: "<html>" }],
])("fails closed on %s and retries on request", async (_name, reply) => {
  const h = fixture();
  h.request.mockResolvedValueOnce(reply);
  await h.session.signIn();
  await vi.waitFor(() => expect(access(h)).toBe("failed"));
  // A failed permission read never ends the native session.
  expect(h.session.snapshot().status).toBe("signed-in");
  h.session.retryRemoteAgents();
  expect(access(h)).toBe("checking");
  await vi.waitFor(() => expect(access(h)).toBe("allowed"));
});

it("ignores a permission reply that arrives after the account changed", async () => {
  const h = fixture();
  let answer: (value: ReturnType<typeof account>) => void = () => {};
  h.request.mockImplementationOnce(
    () => new Promise((resolve) => (answer = resolve)),
  );
  await h.session.signIn();
  await h.session.signOut();
  h.request.mockImplementationOnce(() => new Promise(() => {}));
  await h.session.signIn();
  answer(account(true));
  await Promise.resolve();
  expect(access(h)).toBe("checking");
});

it("denies remote agents for the refused revision only", async () => {
  const h = fixture();
  await h.session.signIn();
  await vi.waitFor(() => expect(access(h)).toBe("allowed"));
  const refused = h.session.credential();
  h.session.refuseRemoteAgents(refused);
  expect(access(h)).toBe("denied");
  await h.session.signOut();
  await h.session.signIn();
  await vi.waitFor(() => expect(access(h)).toBe("allowed"));
  // A stale refusal cannot gate the next sign-in.
  h.session.refuseRemoteAgents(refused);
  expect(access(h)).toBe("allowed");
});
