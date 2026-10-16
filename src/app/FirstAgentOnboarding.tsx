import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppServices } from "./services";
import { CommunityDialog } from "../features/communities/CommunityDialog";
import { communityDestination } from "../features/communities/destination";
import { Button } from "../shared/design-system/ui/Button";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { meTarget } from "../bundled/me/routes";
import {
  ONBOARDING_COMMUNITY,
  startConcierge,
} from "../bundled/mesh-compute/startConcierge";
import { writeView } from "../shared/view-state";

/** First-create intent comes from IdentitySetup, never an empty inventory. */
export function FirstAgentOnboarding({
  services,
  viewer,
  intentSaved = true,
  done,
}: {
  services: AppServices;
  viewer: string;
  intentSaved?: boolean;
  done(): void;
}) {
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const connection = useSyncExternalStore(
    services.relay.subscribe,
    services.relay.snapshot,
  );
  const [joining, setJoining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(intentSaved);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const membership = client.memberships.find(
    (item) => communityDestination(item.id).url === ONBOARDING_COMMUNITY,
  );
  const connected =
    connection.status === "ready" &&
    !connection.cached &&
    connection.viewer === viewer &&
    connection.origin === ONBOARDING_COMMUNITY;
  const finish = () => {
    if (!writeView(viewer, "first-agent:onboarding", false)) {
      setError("Your onboarding progress could not be saved. Try again.");
      return;
    }
    done();
  };
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const target = await startConcierge(
        services.agents,
        services.relay,
        lifetime.current.signal,
      );
      if (lifetime.current.signal.aborted) return;
      if (!writeView(viewer, "first-agent:onboarding", false))
        throw new Error(
          "Your conversation is ready, but onboarding progress could not be saved. Try again.",
        );
      void services.navigation.open(meTarget(target.scope, target.channelId));
      done();
    } catch (cause) {
      if (!lifetime.current.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Hi, I'm Buzz Concierge."
      onOpenChange={(open) => {
        if (!open) finish();
      }}
      preventClose={busy}
      dismissOnOutsideClick={false}
    >
      <main className="grid gap-4" aria-label="Buzz Concierge onboarding">
        <p className="m-0 text-body-md">
          Let's get your agent ready. First you'll give me a name, then connect
          me to your preferred AI in a private Solo conversation.
        </p>
        <p className="m-0 text-body-sm text-secondary">
          This prototype uses the MeshLLM community's shared compute. Join it to
          continue; your onboarding messages are sent to that community and its
          compute provider.
        </p>
        {!saved && (
          <>
            <p role="alert" className="m-0 text-body-sm text-danger">
              Your identity is ready, but onboarding progress could not be
              saved. Retry saving before continuing.
            </p>
            <Button
              onClick={() => {
                if (writeView(viewer, "first-agent:onboarding", true))
                  setSaved(true);
              }}
            >
              Retry saving onboarding
            </Button>
          </>
        )}
        {!membership ? (
          <Button
            disabled={!saved || client.status !== "ready" || busy}
            onClick={() => setJoining(true)}
          >
            Connect to MeshLLM
          </Button>
        ) : !connected ? (
          <Button
            disabled={!saved || busy}
            onClick={() => services.communities.select(membership.id)}
          >
            Open MeshLLM
          </Button>
        ) : (
          <Button
            loading={busy}
            disabled={!saved || busy}
            onClick={() => void start()}
          >
            Start in Solo
          </Button>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
        <Button disabled={busy} onClick={finish}>
          I'll do this later
        </Button>
        {joining && (
          <CommunityDialog
            communities={services.communities}
            mode="join"
            invite={{ community: ONBOARDING_COMMUNITY, code: "" }}
            close={() => setJoining(false)}
            onJoined={(id) => {
              services.communities.select(id);
              setJoining(false);
            }}
          />
        )}
      </main>
    </Dialog>
  );
}
