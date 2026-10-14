import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { npubEncode } from "nostr-tools/nip19";
import type { Credential } from "../../bundled/builderlab/oauth/browser";
import { firstRunCredential } from "../../bundled/builderlab/oauth/first-run";
import { createOAuthSession } from "../../bundled/builderlab/oauth/session";
import { inspectProfile } from "../communities/api";
import { FindCommunity } from "../communities/FindCommunity";
import type { FoundCommunity } from "../communities/find-community";
import type { Communities } from "../communities/service";
import { readErrorKind } from "../relay/errors";
import {
  CircleNotchIcon,
  CopyIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { CommunityUrlField } from "./CommunityUrlField";
import { JoinCommunity } from "./JoinCommunity";
import { ProfileStep } from "./ProfileStep";
import type { Identity } from "./service";
import { createSetup, discoverAuthentication, setupSteps, wait } from "./setup";
import { SetupWindowHeader } from "./SetupWindowHeader";

/**
 * First-launch gate: renders children once a human key exists on this device,
 * except while first-run setup is in progress, which creates that key midway.
 */
export function Welcome({
  identity,
  communities,
  children,
  connect = firstRunCredential,
  delay = wait,
}: {
  identity: Identity;
  /** The live startup service: joining through it is what selects the community. */
  communities: Pick<Communities, "snapshot" | "joined" | "saveProfile">;
  children: ReactNode;
  connect?: (signal: AbortSignal) => Promise<Credential>;
  delay?: (ms: number) => Promise<void>;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const [login] = useState(() => createOAuthSession(connect));
  const auth = useSyncExternalStore(login.subscribe, login.snapshot);
  const [setup] = useState(createSetup);
  const progress = useSyncExternalStore(setup.subscribe, setup.snapshot);
  // The typed address survives a round trip to the find page and back.
  const [entered, setEntered] = useState("");
  // The canonical origin the user asked to join: before sign-in it drives the
  // discovery lookup; after setup, the Join Community page. Cleared on every
  // return to the landing or choices page.
  const [finding, setFinding] = useState<string>();
  const [joinError, setJoinError] = useState<{
    title: string;
    error: string;
    /** Set when the relay refused the key: the page offers Try again for it. */
    denied?: FoundCommunity;
  }>();
  const [retrying, setRetrying] = useState(false);
  // Set once the user's first membership is saved; the gate lifts when it exits.
  const [profileStep, setProfileStep] = useState<{
    found: FoundCommunity;
    read: Awaited<ReturnType<typeof inspectProfile>>;
  }>();
  useEffect(
    () => () => {
      if (login.snapshot().status === "pending") login.cancel();
    },
    [login],
  );
  if (state.status === "ready" && progress.status === "idle") return children;
  /** `findCommunities` is false when a landing-page URL already names the community. */
  const signIn = async (findCommunities: boolean) => {
    await login.signIn();
    if (login.snapshot().status === "signed-in")
      void setup.start(setupSteps(identity, delay, { findCommunities }));
  };
  /** Every way back to the landing, so a kept `finding` cannot re-enter discovery. */
  const backToLanding = () => {
    setFinding(undefined);
    setup.reset();
    login.cancel();
  };
  /**
   * The same join the Add-a-community dialog performs without an invite code:
   * a signed profile read proves admission, then the membership is saved
   * through the live Communities service, which selects it, so the app opens
   * on that community when the gate lifts. The join itself publishes nothing;
   * a first community continues to the profile step, which may.
   */
  const join = async (found: FoundCommunity) => {
    const fail = (error: string, title = "Couldn’t join community") =>
      setJoinError({ title, error });
    const client = communities.snapshot();
    if (client.status !== "ready")
      return fail(client.error ?? "Your saved communities aren’t ready yet.");
    // Read before `joined` adds this one: a device record restored with the key
    // (or a development seed) means this is not the user's first community.
    const first = client.memberships.length === 0;
    let read: Awaited<ReturnType<typeof inspectProfile>>;
    try {
      read = await inspectProfile(found.url);
    } catch (error) {
      return readErrorKind(error) === "denied"
        ? setJoinError({
            title: "This community needs an invite",
            error: `${found.host} admits members by invite, and this key has none yet. Send your public key to a community administrator so they can add you, then try again.`,
            denied: found,
          })
        : fail(
            "Could not reach the relay. Check your connection and try again.",
          );
    }
    try {
      communities.joined(
        {
          id: found.url,
          name: found.host,
          ...(found.icon ? { icon: found.icon } : {}),
        },
        read.exists ? read.profile : client.profile,
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (first) setProfileStep({ found, read });
    else setup.reset();
  };
  const finishProfile = () => {
    setProfileStep(undefined);
    setup.reset();
  };
  const retry = async (found: FoundCommunity) => {
    setRetrying(true);
    try {
      await join(found);
    } finally {
      setRetrying(false);
    }
  };
  const denied = joinError?.denied;
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
          profileStep ? (
            <ProfileStep
              found={profileStep.found}
              read={profileStep.read}
              defaultName={auth.account?.email.split("@")[0] ?? ""}
              communities={communities}
              onDone={finishProfile}
            />
          ) : joinError ? (
            // Back returns to the find page, which looks the community up again.
            <Failure
              title={joinError.title}
              error={joinError.error}
              onBack={() => setJoinError(undefined)}
              publicKey={denied ? npubOf(state) : undefined}
              onRetry={denied && (() => void retry(denied))}
              busy={retrying}
            />
          ) : finding ? (
            <FindCommunity
              url={finding}
              onCancel={() => setFinding(undefined)}
              onJoin={join}
              titleId="welcome-title"
            />
          ) : (
            <JoinCommunity
              url={entered}
              onUrlChange={setEntered}
              onFind={setFinding}
            />
          )
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
            onBack={backToLanding}
          />
        ) : auth.error ? (
          <Failure
            title="Couldn’t connect to Builderlab"
            error={auth.error}
            onBack={backToLanding}
          />
        ) : finding && auth.status === "signed-out" ? (
          // Discovery: the same unauthenticated lookup Join Community runs
          // after setup, so a bad address fails here, before sign-in and before
          // a key exists. A found community says which sign-in comes next.
          <FindCommunity
            url={finding}
            onCancel={backToLanding}
            onFound={(found) => {
              if (discoverAuthentication(found) === "builderlab")
                void signIn(false);
            }}
            titleId="welcome-title"
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
                  if (auth.status === "pending") backToLanding();
                  else void signIn(true);
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
              <CommunityUrlField
                url={entered}
                onUrlChange={setEntered}
                onSubmit={setFinding}
                disabled={auth.status === "pending"}
              />
              {/* A scanner's text takes the field's path: enteredRelayOrigin → setFinding. */}
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

/**
 * Admins admit people by npub, so the denied page shows the key to send them.
 * Full npub only: the service validates the viewer as 64-hex, so encoding fails
 * only on a snapshot that is not ready, and no key block is shown then.
 */
function npubOf(state: ReturnType<Identity["snapshot"]>) {
  if (state.status !== "ready") return undefined;
  try {
    return npubEncode(state.viewer);
  } catch {
    return undefined;
  }
}

function Failure({
  title,
  error,
  onBack,
  publicKey,
  onRetry,
  busy = false,
}: {
  title: string;
  error: string;
  onBack: () => void;
  /** Shown as the user's shareable identity, with Copy, when set. */
  publicKey?: string | undefined;
  /** Offers Try again, disabled while `busy`. */
  onRetry?: (() => void) | undefined;
  busy?: boolean;
}) {
  // Copy feedback is inline: this page renders outside ToastProvider.
  const [copyStatus, setCopyStatus] = useState("");
  return (
    <>
      <h1 id="welcome-title" className="text-title text-primary">
        {title}
      </h1>
      <p role="alert" className="text-body text-danger">
        {error}
      </p>
      {publicKey && (
        // Unstyled wireframe: a plain border until the key panel gets a design.
        <div className="flex flex-col gap-2 rounded-lg border border-standard p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="m-0 text-body text-secondary">
              Your public key (npub)
            </h2>
            <Button
              size="compact"
              variant="ghost"
              aria-label="Copy npub"
              onClick={() => {
                setCopyStatus("");
                void Promise.resolve()
                  .then(() => navigator.clipboard.writeText(publicKey))
                  .then(
                    () => setCopyStatus("Public key copied."),
                    () =>
                      setCopyStatus(
                        "Could not copy. Select the key above to copy it.",
                      ),
                  );
              }}
            >
              <CopyIcon size={16} aria-hidden="true" />
              Copy
            </Button>
          </div>
          <code className="block select-text break-all font-mono text-mono">
            {publicKey}
          </code>
          <p className="m-0 text-body-sm text-secondary">
            This is your public identity — it’s safe to share.
          </p>
          <span role="status" className="text-body-sm text-secondary">
            {copyStatus}
          </span>
        </div>
      )}
      {/* Footer order: secondary first, primary last. */}
      <div className="flex gap-3">
        <Button onClick={onBack} disabled={busy}>
          Back
        </Button>
        {onRetry && (
          <Button variant="primary" onClick={onRetry} disabled={busy}>
            {busy ? "Trying again…" : "Try again"}
          </Button>
        )}
      </div>
    </>
  );
}
