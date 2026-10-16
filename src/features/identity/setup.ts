import type { FirstRunAccount, OwnedCommunity } from "./builderlab-account";
import type { Identity } from "./service";

/** A step may pick where setup rests afterwards, overriding the caller's `then`. */
export type SetupStep = Readonly<{
  label: string;
  run: () => Promise<void> | Promise<Resting | undefined>;
}>;
/**
 * Where setup rests for a decision: the key-management choice, an import, the
 * nsec reveal, or the returning-user pages (Welcome back, the backup offer
 * after an import, the start-over page for a lost key).
 */
export type SetupPause =
  | "key-choice"
  | "key-import"
  | "key-reveal"
  | "welcome-back"
  | "backup-offer"
  | "key-lost";
export type SetupSnapshot = Readonly<
  | { status: "idle" }
  | { status: "running"; label: string }
  | { status: "paused"; at: SetupPause }
  | { status: "failed"; error: string }
  | { status: "done" }
>;
type Resting = Extract<SetupSnapshot, { status: "paused" | "done" }>;

export const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `identity.create` and `importKey` report failure through the snapshot, not by throwing. */
function saved(identity: Identity) {
  const state = identity.snapshot();
  if (state.status === "ready") return;
  throw new Error(
    (state.status === "missing" && state.error) ||
      "Your key could not be saved on this device.",
  );
}

async function createKey(identity: Identity) {
  await identity.create();
  saved(identity);
}

/**
 * Stores a key the user already has through the key setup screen's native
 * import command, which takes the nsec as typed. Not a step: a refusal belongs
 * under the import page's field, not on the failed page.
 */
export async function importKey(identity: Identity, nsec: string) {
  await identity.importKey(nsec);
  saved(identity);
}

/**
 * Real: the key bound to the signed-in account picks the lane. Binding is 1:1
 * and enforced, so a linked account must never be given a second key: it rests
 * on Welcome back instead of the key choice, and later steps still run.
 */
export function checkAccount(
  account: FirstRunAccount,
  onLinked: (pubkey: string) => void,
): SetupStep {
  return {
    label: "Checking your account…",
    run: async () => {
      const pubkey = await account.linkedKey();
      if (!pubkey) return undefined;
      onLinked(pubkey);
      return { status: "paused", at: "welcome-back" };
    },
  };
}

/**
 * Real: the communities the linked account owns, for Join a community's rows
 * and the start-over page. Runs only once a key is on the device and the
 * account is linked (the list is meaningless otherwise). A failed list is
 * reported as `undefined`, not a failed setup: the pages work without it.
 */
export function findCommunities(
  account: FirstRunAccount,
  onFound: (owned: readonly OwnedCommunity[] | undefined) => void,
): SetupStep {
  return {
    label: "Finding communities…",
    run: () =>
      account.ownedCommunities().then(onFound, () => onFound(undefined)),
  };
}

/**
 * TODO(kgoose): look up a key Builderlab backed up for the signed-in account.
 * Always answers "none" until that endpoint exists: the nsec-backup record is a
 * separate opt-in table no shipped client writes, so a linked key does not mean
 * a backed-up one, and no copy must ever imply the user lost a backup. When
 * real: take the Builderlab credential (`login.credential()` in Welcome), and
 * let a found key import through `identity.importKey(nsec)` and rest past the
 * choice page by returning the resting state from `run`.
 */
export async function lookupBackedUpKey(
  delay = wait,
): Promise<{ found: false }> {
  await delay(2000);
  return { found: false };
}

/**
 * TODO(kgoose): upload the key for the signed-in account; only waits for now.
 * The real step wraps the nsec in an HPKE envelope for kgoose's nsec-backup
 * record and, for a key the account is not yet linked to, binds the pubkey
 * through the kind-24243 challenge/verify flow the hosted-communities card
 * already drives (`bind` in src/bundled/hosted-communities/native.ts:
 * `/v1/buzz/nostr-identities/challenge`, native
 * `identity_sign_builderlab_binding`, then `/verify`).
 */
export const backUpKey = (delay = wait) => delay(2000);

/**
 * TODO(kgoose): unbind the lost key from the account — `DeleteNostrIdentity`,
 * `/v1/buzz/nostr-identities/delete`, the card's `unbind` route. Only waits:
 * first run must not call the real endpoint yet.
 */
export const unlinkKey = (delay = wait) => delay(2000);

/**
 * The first-run steps `Welcome` composes into phases. `[TODO]` steps have no
 * backend yet and only wait; replace their `run` with the real call and drop
 * the marker from the label. Everything but `createKey` needs a Builderlab
 * account, so key-only setup (a community no tenant hosts) runs that alone.
 * The real account reads are `checkAccount` and `findCommunities` above.
 */
export function firstRunSteps(identity: Identity, delay = wait) {
  return {
    checkBackup: {
      label: "Checking for a backed-up key… [TODO]",
      run: async () => {
        await lookupBackedUpKey(delay);
      },
    },
    createKey: { label: "Creating keys…", run: () => createKey(identity) },
    /** A key the account is already linked to: backup only. */
    backUp: {
      label: "Backing up your key… [TODO]",
      run: () => backUpKey(delay),
    },
    /** A key created here: backup, and the binding that makes it the account's. */
    backUpAndLink: {
      label: "Backing up and linking your key… [TODO]",
      run: () => backUpKey(delay),
    },
    unlink: {
      label: "Unlinking your old key… [TODO]",
      run: () => unlinkKey(delay),
    },
  } satisfies Record<string, SetupStep>;
}

/**
 * Runs steps in order, stopping at the first failure, then rests at `then` —
 * done, or a pause the caller resumes with another `start` — unless a step
 * picked another resting state. No steps means "nothing more to do" and
 * rests at once. A failed setup may also be resumed: once a key exists, Back
 * from the failed page rests on the Join page rather than the landing.
 */
export function createSetup() {
  let state: SetupSnapshot = { status: "idle" };
  const listeners = new Set<() => void>();
  const publish = (next: SetupSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(
      steps: readonly SetupStep[],
      then: Resting = { status: "done" },
    ) {
      if (state.status === "running" || state.status === "done") return;
      let rest = then;
      for (const step of steps) {
        publish({ status: "running", label: step.label });
        try {
          const picked = await step.run();
          if (picked) rest = picked;
        } catch (error) {
          publish({
            status: "failed",
            error:
              error instanceof Error
                ? error.message
                : "Setup failed. Try again.",
          });
          return;
        }
      }
      publish(rest);
    },
    reset() {
      if (state.status === "running") return;
      publish({ status: "idle" });
    },
  };
}
export type Setup = ReturnType<typeof createSetup>;
