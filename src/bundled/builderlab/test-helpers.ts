import { expect, vi } from "vitest";
import { federatedFixture } from "../../features/federated-identity/testing";
import { createBuilderlabSession } from "./session";

export function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A signed-in Builderlab session over the public federated-identity fixture. */
export async function signedInBuilderlab(
  email = "a@example.com",
  canUseRemoteAgents = true,
  identityOrigin = "https://builderlab.example",
) {
  const federated = federatedFixture("user", email);
  federated.publish({
    authority: { id: "test", identityOrigin, apiBasePath: "/api/goose/" },
  });
  federated.request.mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: JSON.stringify({
      capabilities: { can_use_remote_agents: canUseRemoteAgents },
    }),
  });
  const session = createBuilderlabSession(federated.session);
  await session.signIn();
  await vi.waitFor(() =>
    expect(session.snapshot().account?.remoteAgents).toBe(
      canUseRemoteAgents ? "allowed" : "denied",
    ),
  );
  // Callers count their own requests, not the permission read.
  federated.request.mockClear();
  return { ...federated, session };
}
