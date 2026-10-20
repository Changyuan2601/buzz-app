import { useState, useSyncExternalStore } from "react";
import { Header } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Button } from "../../shared/design-system/ui/Button";
import type { FederatedSession } from "./session";

export function Login({
  session,
  available,
  active,
  title = "Builderlab",
  unavailableReason = "Open the Buzz desktop app to sign in with Builderlab.",
}: {
  session: FederatedSession;
  title?: string;
  available: boolean;
  active(): boolean;
  unavailableReason?: string;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  const [error, setError] = useState("");
  return (
    <div data-buzz-ui="" className="flex flex-col items-start gap-4">
      <Header
        title={title}
        subtitle="Sign in securely in your browser. Buzz keeps the shared session in your OS secure storage."
      />
      <SettingsGroup layout="form">
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
                    : `Signed in to ${title}.`
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
                void operation.catch((error: unknown) => {
                  if (active())
                    setError(
                      error instanceof Error ? error.message : "Sign-in failed",
                    );
                });
              }}
            >
              {state.status === "pending"
                ? "Cancel sign-in"
                : state.status === "signed-in"
                  ? "Sign out"
                  : "Sign in"}
            </Button>
          </>
        )}
      </SettingsGroup>
    </div>
  );
}
