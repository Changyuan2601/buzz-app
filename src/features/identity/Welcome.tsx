import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Credential } from "../../bundled/builderlab/oauth/browser";
import { firstRunCredential } from "../../bundled/builderlab/oauth/first-run";
import { createOAuthSession } from "../../bundled/builderlab/oauth/session";
import { CircleNotchIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { JoinCommunity } from "./JoinCommunity";
import type { Identity } from "./service";
import { createSetup, setupSteps, wait } from "./setup";
import { SetupWindowHeader } from "./SetupWindowHeader";

/**
 * First-launch gate: renders children once a human key exists on this device,
 * except while first-run setup is in progress, which creates that key midway.
 */
export function Welcome({
  identity,
  children,
  connect = firstRunCredential,
  delay = wait,
}: {
  identity: Identity;
  children: ReactNode;
  connect?: (signal: AbortSignal) => Promise<Credential>;
  delay?: (ms: number) => Promise<void>;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const [login] = useState(() => createOAuthSession(connect));
  const auth = useSyncExternalStore(login.subscribe, login.snapshot);
  const [setup] = useState(() => createSetup(setupSteps(identity, delay)));
  const progress = useSyncExternalStore(setup.subscribe, setup.snapshot);
  useEffect(
    () => () => {
      if (login.snapshot().status === "pending") login.cancel();
    },
    [login],
  );
  if (state.status === "ready" && progress.status === "idle") return children;
  const signIn = async () => {
    await login.signIn();
    if (login.snapshot().status === "signed-in") void setup.start();
  };
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
        ) : progress.status === "done" ? (
          <JoinCommunity />
        ) : progress.status === "running" ? (
          <>
            <h1 id="welcome-title" className="text-title text-primary">
              Setting up Buzz
            </h1>
            <p
              role="status"
              className="flex items-center gap-2 text-body text-secondary"
            >
              <CircleNotchIcon
                size={18}
                aria-hidden="true"
                className="motion-safe:animate-spin"
              />
              {progress.label}
            </p>
          </>
        ) : progress.status === "failed" ? (
          <Failure
            title="Couldn’t finish setup"
            error={progress.error}
            onBack={() => {
              setup.reset();
              login.cancel();
            }}
          />
        ) : auth.error ? (
          <Failure
            title="Couldn’t connect to Builderlab"
            error={auth.error}
            onBack={login.cancel}
          />
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
                  else void signIn();
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

function Failure({
  title,
  error,
  onBack,
}: {
  title: string;
  error: string;
  onBack: () => void;
}) {
  return (
    <>
      <h1 id="welcome-title" className="text-title text-primary">
        {title}
      </h1>
      <p role="alert" className="text-body text-danger">
        {error}
      </p>
      <div>
        <Button onClick={onBack}>Back</Button>
      </div>
    </>
  );
}
