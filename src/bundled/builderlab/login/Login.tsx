import { useEffect, useState, useSyncExternalStore } from "react";
import { Header } from "../../../shared/design-system/ui/Header";
import { Button } from "../../../shared/design-system/ui/Button";
import type { BuilderlabSession } from "../session";

export function Login({
  session,
  available,
  active,
  showHeading = true,
  unavailableReason = "Open the Buzz desktop app to sign in with Builderlab.",
}: {
  session: BuilderlabSession;
  available: boolean;
  active(): boolean;
  showHeading?: boolean;
  unavailableReason?: string;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  const [error, setError] = useState("");
  useEffect(
    () => () => {
      if (session.snapshot().status === "pending")
        void session.cancel().catch(() => {});
    },
    [session],
  );
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      {showHeading ? (
        <Header
          title="Builderlab"
          subtitle="Connect your Builderlab account. Buzz keeps the session in your OS secure storage."
        />
      ) : (
        <p className="m-0 text-body-sm text-secondary">
          Connect your Builderlab account. Buzz keeps the session in your OS
          secure storage.
        </p>
      )}
      {!available || !session.available() ? (
        <p role="status" className="text-body-sm text-secondary">
          {unavailableReason}
        </p>
      ) : (
        <>
          <p role="status" className="text-body-sm text-secondary">
            {state.status === "pending"
              ? "Finish sign-in in your browser, then return to Buzz."
              : state.account
                ? state.account.email
                  ? `Signed in as ${state.account.email}.`
                  : "Signed in to Builderlab."
                : "Sign in securely in your browser."}
          </p>
          {(state.error || error) && (
            <p role="alert" className="text-body-sm text-danger">
              {state.error || error}
            </p>
          )}
          <Button
            variant={state.status === "signed-out" ? "prominent" : "outline"}
            onClick={() => {
              if (!active()) return;
              setError("");
              const operation =
                state.status === "pending"
                  ? session.cancel()
                  : state.status === "signed-in"
                    ? session.signOut()
                    : session.signIn();
              void operation.catch((failure: unknown) => {
                if (active())
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Sign-in failed. Try again.",
                  );
              });
            }}
          >
            {state.status === "pending"
              ? "Cancel sign-in"
              : state.status === "signed-in"
                ? "Sign out"
                : "Sign in with Builderlab"}
          </Button>
        </>
      )}
    </div>
  );
}
