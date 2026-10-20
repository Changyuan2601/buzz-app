import { expect, it, vi } from "vitest";
import { federatedFixture } from "../../features/federated-identity/testing";
import { createBuilderlabSession } from "./session";

function fixture() {
  const federated = federatedFixture("user", "a@example.com");
  return { ...federated, session: createBuilderlabSession(federated.session) };
}
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
  expect(h.session.snapshot()).toEqual({
    status: "signed-in",
    account: {
      subject: "a@example.com",
      email: "a@example.com",
      canUseRemoteAgents: true,
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

it("gates remote agents for the refused revision only", async () => {
  const h = fixture();
  await h.session.signIn();
  const refused = h.session.credential();
  h.session.refuseRemoteAgents(refused);
  expect(h.session.snapshot().account?.canUseRemoteAgents).toBe(false);
  await h.session.signOut();
  await h.session.signIn();
  // A stale refusal cannot gate the next sign-in.
  h.session.refuseRemoteAgents(refused);
  expect(h.session.snapshot().account?.canUseRemoteAgents).toBe(true);
});
