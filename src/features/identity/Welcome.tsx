import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { npubEncode } from "nostr-tools/nip19";
import type { Credential } from "../../bundled/builderlab/oauth/browser";
import {
  bundledHost,
  firstRunCredential,
} from "../../bundled/builderlab/oauth/first-run";
import { createOAuthSession } from "../../bundled/builderlab/oauth/session";
import { inspectProfile } from "../communities/api";
import { FindCommunity } from "../communities/FindCommunity";
import type { FoundCommunity } from "../communities/find-community";
import type { Communities } from "../communities/service";
import { readErrorKind } from "../relay/errors";
import { Button } from "../../shared/design-system/ui/Button";
import { BackupOffer } from "./BackupOffer";
import {
  builderlabAccount,
  type FirstRunAccount,
  type OwnedCommunity,
  seededAccount,
} from "./builderlab-account";
import {
  type BuilderlabTenant,
  configuredBuilderlabTenants,
  discoverAuthentication,
} from "./builderlab-tenants";
import { CommunityUrlField } from "./CommunityUrlField";
import { parseFirstRunAccountSeed } from "./first-run-seed";
import { JoinCommunity } from "./JoinCommunity";
import { KeyChoice } from "./KeyChoice";
import { KeyImport } from "./KeyImport";
import { KeyLost } from "./KeyLost";
import { KeyReveal } from "./KeyReveal";
import { ProfileStep } from "./ProfileStep";
import { PublicKeyPanel } from "./PublicKeyPanel";
import type { Identity } from "./service";
import {
  checkAccount,
  createSetup,
  findCommunities,
  firstRunSteps,
  importKey,
  type SetupPause,
  wait,
} from "./setup";
import { SetupProgress } from "./SetupProgress";
import { SetupWindowHeader } from "./SetupWindowHeader";
import { WelcomeBack } from "./WelcomeBack";

/**
 * The signed-in account's reads: the development seed when a dev server set
 * one (production builds define it empty), else the tenant's kgoose through
 * the same bundled grant the sign-in used.
 */
const firstRunAccount = (credential: Credential, origin?: string) => {
  const seed = parseFirstRunAccountSeed(
    import.meta.env.VITE_BUZZ_FIRST_RUN_ACCOUNT,
  );
  return seed
    ? seededAccount(seed)
    : builderlabAccount(credential, origin, bundledHost.request);
};

/**
 * First-launch gate: renders children once a human key exists on this device,
 * except while first-run setup is in progress, which creates that key midway.
 */
export function Welcome({
  identity,
  communities,
  children,
  connect = firstRunCredential,
  account = firstRunAccount,
  tenants = configuredBuilderlabTenants,
  delay = wait,
}: {
  identity: Identity;
  /** The live startup service: joining through it is what selects the community. */
  communities: Pick<Communities, "snapshot" | "joined" | "saveProfile">;
  children: ReactNode;
  /** `origin` is the tenant portal a community URL selected; the build default otherwise. */
  connect?: (signal: AbortSignal, origin?: string) => Promise<Credential>;
  /** The account reads for a credential `connect` returned, at the same origin. */
  account?:
    | ((credential: Credential, origin?: string) => FirstRunAccount)
    | undefined;
  tenants?: readonly BuilderlabTenant[];
  delay?: (ms: number) => Promise<void>;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  // Set by discovery before each sign-in; the session store never sees a URL.
  const loginOrigin = useRef<string | undefined>(undefined);
  const [login] = useState(() =>
    createOAuthSession((signal) => connect(signal, loginOrigin.current)),
  );
  const auth = useSyncExternalStore(login.subscribe, login.snapshot);
  const [setup] = useState(createSetup);
  const progress = useSyncExternalStore(setup.subscribe, setup.snapshot);
  // The signed-in account's reads, from sign-in until the landing is shown again.
  const reads = useRef<FirstRunAccount | undefined>(undefined);
  // The hex key the account check found bound to the account: the returning-
  // user lane. Cleared by starting over, which unlinks it, and on the landing.
  const [linked, setLinked] = useState<string>();
  // The communities that key owns; `undefined` until found, or when the list failed.
  const [owned, setOwned] = useState<readonly OwnedCommunity[]>();
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
  const steps = firstRunSteps(identity, delay);
  /**
   * Sign-in leads to the account check, which picks the lane: a linked key
   * pauses on Welcome back, otherwise the backed-up-key lookup pauses for the
   * key choice. Each choice below resumes setup with its own steps.
   */
  const signIn = async (origin?: string) => {
    loginOrigin.current = origin;
    await login.signIn();
    if (login.snapshot().status !== "signed-in") return;
    const current = account(login.credential(), origin);
    reads.current = current;
    void setup.start([checkAccount(current, setLinked), steps.checkBackup], {
      status: "paused",
      at: "key-choice",
    });
  };
  /** Between pauses nothing runs: no key exists until a choice resumes setup. */
  const pause = (at: SetupPause) =>
    void setup.start([], { status: "paused", at });
  /** How every lane ends: a linked account's owned communities feed Join a community. */
  const finish = () =>
    linked && reads.current ? [findCommunities(reads.current, setOwned)] : [];
  /** Every way back to the landing, so a kept `finding` cannot re-enter discovery. */
  const backToLanding = () => {
    setFinding(undefined);
    setLinked(undefined);
    setOwned(undefined);
    reads.current = undefined;
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
  /** The pages setup rests on. A pause this component did not reach has nothing to render. */
  const paused = (at: SetupPause) => {
    const current = reads.current;
    switch (at) {
      case "key-choice":
        return (
          <KeyChoice
            email={auth.account?.email}
            onManaged={() =>
              void setup.start([steps.createKey, steps.backUpAndLink])
            }
            onOwn={() =>
              void setup.start([steps.createKey], {
                status: "paused",
                at: "key-reveal",
              })
            }
            onImport={() => pause("key-import")}
          />
        );
      case "key-import":
        // On the linked lane only the linked key is accepted, and the backup is
        // offered rather than assumed. Otherwise an imported key is already
        // backed up wherever it came from, so it skips the backup and reveal.
        return (
          <KeyImport
            expectedPubkey={linked}
            onBack={() => pause(linked ? "welcome-back" : "key-choice")}
            onImport={async (nsec) => {
              await importKey(identity, nsec);
              if (linked) pause("backup-offer");
              else void setup.start([]);
            }}
          />
        );
      case "key-reveal":
        return (
          <KeyReveal
            identity={identity}
            onBackUp={() => void setup.start([steps.backUpAndLink])}
            onContinue={() => void setup.start([])}
          />
        );
      case "welcome-back":
        return linked && current ? (
          <WelcomeBack
            npub={npubEncode(linked)}
            onImport={() => pause("key-import")}
            onLost={() =>
              void setup.start([findCommunities(current, setOwned)], {
                status: "paused",
                at: "key-lost",
              })
            }
          />
        ) : null;
      case "backup-offer":
        return (
          <BackupOffer
            onSkip={() => void setup.start(finish())}
            onBackUp={() => void setup.start([steps.backUp, ...finish()])}
          />
        );
      case "key-lost":
        // Unlinked, the account is a new user's: the ordinary key choice follows,
        // and the old key's communities are not offered to the new one.
        return (
          <KeyLost
            owned={owned}
            onBack={() => pause("welcome-back")}
            onStartOver={() => {
              setLinked(undefined);
              setOwned(undefined);
              void setup.start([steps.unlink], {
                status: "paused",
                at: "key-choice",
              });
            }}
          />
        );
    }
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
              owned={owned}
            />
          )
        ) : progress.status === "running" ? (
          <SetupProgress label={progress.label} />
        ) : progress.status === "paused" ? (
          paused(progress.at)
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
          // a key exists. A found community says which sign-in comes next: a
          // Builderlab tenant's portal, or none, which only creates the key.
          <FindCommunity
            url={finding}
            onCancel={backToLanding}
            onFound={(found) => {
              const method = discoverAuthentication(found, tenants);
              if (method.kind === "builderlab") void signIn(method.origin);
              // Key-only: no account to look a backup up in or back up to.
              else void setup.start([steps.createKey]);
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
  return (
    <>
      <h1 id="welcome-title" className="text-title text-primary">
        {title}
      </h1>
      <p role="alert" className="text-body text-danger">
        {error}
      </p>
      {publicKey && <PublicKeyPanel publicKey={publicKey} />}
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
