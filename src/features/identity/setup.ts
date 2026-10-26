import type { FirstRunAccount, OwnedCommunity } from "./builderlab-account";
import type { Identity } from "./service";

/**
 * What the failed page offers in place of Back once a step fails: `run`, then
 * rest at `rest`, or carry on with the steps after the failed one.
 */
export type Fallback = Readonly<{
  label: string;
  rest?: Resting;
  /** Must not reject: the failed page has already handed its step over. */
  run?: () => Promise<void>;
}>;
/** A step may pick where setup rests afterwards, overriding the caller's `then`. */
export type SetupStep = Readonly<{
  label: string;
  run: () => Promise<void> | Promise<Resting | undefined>;
  fallback?: Fallback;
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
  | {
      status: "failed";
      error: string;
      /** The error says Try again can help, as a retryable `BackupError` does. */
      retryable: boolean;
      /** The failed step's fallback label. */
      fallback?: string;
    }
  | { status: "done" }
>;
type Resting = Extract<SetupSnapshot, { status: "paused" | "done" }>;

export const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A key created on this device that the user may not have seen: show it, where
 * leaving without a backup needs the box ticked.
 */
export const showMyKey: Fallback = {
  label: "Show my key",
  rest: { status: "paused", at: "key-reveal" },
};
/** An imported key is already held elsewhere: carry on without the failed step. */
export const notNow: Fallback = { label: "Not now" };

/** The key now on this device, which the account steps act on. */
function viewer(identity: Identity) {
  const state = identity.snapshot();
  if (state.status !== "ready")
    throw new Error("Your key could not be saved on this device.");
  return state.viewer;
}

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
 * on Welcome back instead of the key choice, and later steps still run. Whether
 * backup is offered decides which choices the pages after it show.
 */
export function checkAccount(
  account: FirstRunAccount,
  onLinked: (pubkey: string) => void,
  onOffered: (offered: boolean) => void,
): SetupStep {
  return {
    label: "Checking your account…",
    run: async () => {
      const [pubkey, offered] = await Promise.all([
        account.linkedKey(),
        account.backupOffered(),
      ]);
      onOffered(offered);
      if (!pubkey) return undefined;
      onLinked(pubkey);
      return { status: "paused", at: "welcome-back" };
    },
  };
}

/**
 * Real: binds the key now on this device to the signed-in account, so the
 * account is this key's and a backup can be accepted for it. The account sends
 * nothing more when it already holds the key, so a re-run is harmless.
 */
export function linkKey(
  identity: Identity,
  account: FirstRunAccount,
  fallback: Fallback,
): SetupStep {
  return {
    label: "Linking your key…",
    run: () => account.bind(viewer(identity)),
    fallback,
  };
}

/**
 * Real: unbinds `old`, the key the account held before starting over, so the
 * key now on this device can be linked in its place: binding is 1:1 and never
 * overwrites. Runs once that key exists, just before `linkKey`, as the hosted
 * card's switch does. The account deletes only while it still holds `old`, so
 * a re-run never removes the new key's binding, and bringing `old` back sends
 * nothing.
 */
export function unlinkKey(
  identity: Identity,
  account: FirstRunAccount,
  old: string,
  fallback: Fallback,
): SetupStep {
  return {
    label: "Unlinking your old key…",
    run: async () => {
      if (viewer(identity) !== old) await account.unbind(old);
    },
    fallback,
  };
}

/**
 * Real: backs the key now on this device up to the signed-in account and waits
 * for the native uploader's own result (`backUpWith`), which kgoose accepts
 * only for the key bound to the account: the linked lane's own, or one
 * `linkKey` bound first. Its fallback also turns automatic backup off, so a
 * later Builderlab sign-in does not upload a key the user declined to back up.
 */
export function backUp(
  identity: Identity,
  account: FirstRunAccount,
  fallback: Fallback,
): SetupStep {
  return {
    label: "Backing up your key…",
    run: () => account.backUp(viewer(identity)),
    fallback: {
      ...fallback,
      run: async () => {
        const state = identity.snapshot();
        if (state.status === "ready") await account.declineBackup(state.viewer);
      },
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
 * The first-run steps `Welcome` composes into phases. `[TODO]` steps have no
 * backend yet and only wait; replace their `run` with the real call and drop
 * the marker from the label. Everything but `createKey` needs a Builderlab
 * account, so key-only setup (a community no tenant hosts) runs that alone.
 * The real account steps are `checkAccount`, `linkKey`, `unlinkKey`, `backUp`
 * and `findCommunities` above.
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
  } satisfies Record<string, SetupStep>;
}

/**
 * Runs steps in order, stopping at the first failure, then rests at `then` —
 * done, or a pause the caller resumes with another `start` — unless a step
 * picked another resting state. No steps means "nothing more to do" and
 * rests at once. A failed setup may also be resumed: by `retry` or `fallBack`
 * from the failed step, or once a key exists, by Back from the failed page,
 * which rests on the Join page rather than the landing.
 */
export function createSetup() {
  let state: SetupSnapshot = { status: "idle" };
  // From the failed step on, with where setup would have rested. Taken once,
  // so a second click on Try again or a fallback does nothing.
  let failed:
    | Readonly<{ steps: readonly SetupStep[]; rest: Resting }>
    | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: SetupSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const tail = () => (state.status === "failed" ? failed : undefined);
  async function run(steps: readonly SetupStep[], then: Resting) {
    let rest = then;
    for (const [index, step] of steps.entries()) {
      publish({ status: "running", label: step.label });
      try {
        const picked = await step.run();
        if (picked) rest = picked;
      } catch (error) {
        failed = { steps: steps.slice(index), rest };
        publish({
          status: "failed",
          error:
            error instanceof Error ? error.message : "Setup failed. Try again.",
          retryable:
            error instanceof Error &&
            "retryable" in error &&
            error.retryable === true,
          ...(step.fallback && { fallback: step.fallback.label }),
        });
        return;
      }
    }
    publish(rest);
  }
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
      failed = undefined;
      await run(steps, then);
    },
    /** Runs the failed step again, then the rest, resting where it would have. */
    async retry() {
      const from = tail();
      if (!from) return;
      failed = undefined;
      await run(from.steps, from.rest);
    },
    /**
     * The failed step's fallback: its `run`, then its resting state, or the
     * steps after the failed one.
     */
    async fallBack() {
      const from = tail();
      const fallback = from?.steps[0]?.fallback;
      if (!from || !fallback) return;
      failed = undefined;
      await fallback.run?.();
      await run(
        fallback.rest ? [] : from.steps.slice(1),
        fallback.rest ?? from.rest,
      );
    },
    reset() {
      if (state.status === "running") return;
      failed = undefined;
      publish({ status: "idle" });
    },
  };
}
export type Setup = ReturnType<typeof createSetup>;
