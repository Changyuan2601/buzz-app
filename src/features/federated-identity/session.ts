import type { FederatedIdentity, SessionSnapshot } from "./service";

export type LoginSnapshot = Readonly<{
  status: "signed-out" | "pending" | "signed-in";
  account?: Readonly<{ revision: string; email?: string }>;
  error?: string;
}>;
/** A public projection of the shared owner; no plugin credential or login cache. */
export function createFederatedSession(service: FederatedIdentity) {
  let source: SessionSnapshot | undefined;
  let projection: LoginSnapshot = { status: "signed-out" };
  let identity:
    | Readonly<{ revision: string; origin: string; apiBasePath: string }>
    | undefined;
  const snapshot = () => {
    const next = service.snapshot();
    if (next !== source) {
      if (next.revision !== source?.revision || !identity)
        identity = next.authority
          ? Object.freeze({
              revision: next.revision,
              origin: next.authority.identityOrigin,
              apiBasePath: next.authority.apiBasePath,
            })
          : undefined;
      source = next;
      projection = Object.freeze({
        status:
          next.status === "signed-in"
            ? "signed-in"
            : ["signing-in", "restoring"].includes(next.status)
              ? "pending"
              : "signed-out",
        ...(next.status === "signed-in"
          ? {
              account: Object.freeze({
                revision: next.revision,
                ...(next.email ? { email: next.email } : {}),
              }),
            }
          : {}),
        ...(next.failure
          ? { error: `Federated identity: ${next.failure}` }
          : {}),
      });
    }
    return projection;
  };
  return {
    available: () => service.snapshot().authority !== null,
    snapshot,
    subscribe: (listener: () => void) => service.subscribe(listener),
    identity() {
      if (snapshot().status !== "signed-in" || !identity)
        throw new Error("Sign in first");
      return identity;
    },
    request: service.request.bind(service),
    signIn: () => service.signIn(),
    cancel: () => service.cancelSignIn(),
    signOut: () => service.signOut(),
  };
}
export type FederatedSession = ReturnType<typeof createFederatedSession>;
