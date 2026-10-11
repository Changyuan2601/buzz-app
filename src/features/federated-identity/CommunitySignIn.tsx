import { useState, useSyncExternalStore } from "react";
import type { FederatedIdentity } from "./service";
import { Button } from "../../shared/design-system/ui/Button";

/** Explicit recovery from native protected-community admission; never automatic login. */
export function CommunitySignIn({
  identity,
  error,
  retry,
}: {
  identity?: FederatedIdentity | undefined;
  error?: string | undefined;
  retry: () => void;
}) {
  if (!identity) return null;
  return <Action identity={identity} error={error} retry={retry} />;
}
function Action({
  identity,
  error,
  retry,
}: {
  identity: FederatedIdentity;
  error?: string | undefined;
  retry: () => void;
}) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState("");
  const refusal = error || state.failure || "";
  if (/binding[-_]mismatch/.test(refusal))
    return (
      <p role="alert" className="text-body-sm text-danger">
        This account is linked to a different Buzz identity. Open Settings →
        Hosted Communities to review the existing identity link. Keep this key
        until you have reviewed the link.
      </p>
    );
  if (/authorization[-_]denied/.test(refusal))
    return (
      <p role="alert" className="text-body-sm text-danger">
        Your account does not have access to this community. Contact its
        administrator.
      </p>
    );
  if (
    !error ||
    !/Federated sign-in is required|reauthentication-required|Federated authorization (changed|expired)/.test(
      error,
    ) ||
    !state.authority
  )
    return null;
  if (state.status === "signed-in") return null;
  return (
    <>
      <Button
        onClick={() => {
          setFailure("");
          const operation =
            state.status === "signing-in"
              ? identity.cancelSignIn()
              : identity.signIn().then((next) => {
                  if (next.status === "signed-in") retry();
                });
          void operation.catch((error: unknown) =>
            setFailure(
              error instanceof Error ? error.message : "Sign-in unavailable",
            ),
          );
        }}
      >
        {state.status === "signing-in" ? "Cancel sign-in" : "Sign in"}
      </Button>
      {(failure || state.failure) && (
        <p role="alert" className="text-body-sm text-danger">
          {failure || `Federated identity: ${state.failure}`}
        </p>
      )}
    </>
  );
}
