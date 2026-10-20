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
  const session = createBuilderlabSession(federated.session);
  await session.signIn();
  if (!canUseRemoteAgents) session.refuseRemoteAgents(session.credential());
  return { ...federated, session };
}
