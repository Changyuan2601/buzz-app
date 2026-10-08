import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Credential } from "../../bundled/builderlab/oauth/browser";
import { firstRunCredential } from "../../bundled/builderlab/oauth/first-run";
import { createOAuthSession } from "../../bundled/builderlab/oauth/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type { Identity } from "./service";
import { SetupWindowHeader } from "./SetupWindowHeader";

/** First-launch gate: renders children once a human key exists on this device. */
export function Welcome({
  identity,
  children,
  connect = firstRunCredential,
}: {
  identity: Identity;
  children: ReactNode;
  connect?: (signal: AbortSignal) => Promise<Credential>;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const [login] = useState(() => createOAuthSession(connect));
  const auth = useSyncExternalStore(login.subscribe, login.snapshot);
  useEffect(
    () => () => {
      if (login.snapshot().status === "pending") login.cancel();
    },
    [login],
  );
  if (state.status === "ready") return children;
  return (
    <main className="p-8" aria-labelledby="welcome-title">
      <SetupWindowHeader />
      <div className="mx-auto flex max-w-sm flex-col gap-6">
        {state.status === "loading" ? (
          <>
            <h1 id="welcome-title" className="text-title text-primary">
              Buzz
            </h1>
            <p role="status">Opening your saved identity…</p>
          </>
        ) : state.status === "error" ? (
          <>
            <h1 id="welcome-title" className="text-title text-primary">
              Buzz
            </h1>
            <p role="alert">{state.error}</p>
            <Button onClick={() => void identity.retry()}>
              Retry secure storage access
            </Button>
          </>
        ) : auth.status === "signed-in" ? (
          <>
            <h1 id="welcome-title" className="text-title text-primary">
              Connected to Builderlab
            </h1>
            <p role="status" className="text-body text-secondary">
              {auth.account?.email
                ? `Signed in as ${auth.account.email}.`
                : "Your Builderlab account is connected."}
            </p>
          </>
        ) : auth.error ? (
          <>
            <h1 id="welcome-title" className="text-title text-primary">
              Couldn’t connect to Builderlab
            </h1>
            <p role="alert" className="text-body text-danger">
              {auth.error}
            </p>
            <div>
              <Button onClick={login.cancel}>Back</Button>
            </div>
          </>
        ) : (
          <>
            <div>
              <h1 id="welcome-title" className="text-title text-primary">
                Buzz
              </h1>
              <p className="mt-2 text-body-lg text-secondary">
                Your people, your agents, your projects — all in one place.
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <Button
                variant={auth.status === "pending" ? "outline" : "primary"}
                size="lg"
                onClick={() => {
                  if (auth.status === "pending") login.cancel();
                  else void login.signIn();
                }}
              >
                {auth.status === "pending"
                  ? "Cancel sign-in"
                  : "Connect with Builderlab"}
              </Button>
              {auth.status === "pending" && (
                <p role="status" className="text-body-sm text-secondary">
                  Finish sign-in in your browser, then return to Buzz.
                </p>
              )}
              <Field label="Community URL" disabled>
                <Input type="url" placeholder="Coming soon" disabled />
              </Field>
              <Button size="lg" disabled>
                Scan a QR code — Coming soon
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
