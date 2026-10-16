import type { Identity } from "./service";

export type SetupStep = Readonly<{ label: string; run: () => Promise<void> }>;
/** Where setup rests for a decision: the key-management choice, an import, or the nsec reveal. */
export type SetupPause = "key-choice" | "key-import" | "key-reveal";
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
 * TODO(kgoose): look up a key Builderlab backed up for the signed-in account.
 * Always answers "none" until that endpoint exists. When real: take the
 * Builderlab credential (`login.credential()` in Welcome), and let a found key
 * import through `identity.importKey(nsec)` and skip the choice page — that
 * needs the step to pick the resting state, e.g. `run` returning `Resting | void`.
 */
export async function lookupBackedUpKey(
  delay = wait,
): Promise<{ found: false }> {
  await delay(2000);
  return { found: false };
}

/** TODO(kgoose): upload the key for the signed-in account; only waits for now. */
export const backUpKey = (delay = wait) => delay(2000);

/**
 * The first-run steps `Welcome` composes into phases. `[TODO]` steps have no
 * backend yet and only wait; replace their `run` with the real call and drop
 * the marker from the label. Everything but `createKey` needs a Builderlab
 * account, so key-only setup (a community no tenant hosts) runs that alone.
 */
export function firstRunSteps(identity: Identity, delay = wait) {
  return {
    findCommunities: {
      label: "Finding communities… [TODO]",
      run: () => delay(2000),
    },
    checkBackup: {
      label: "Checking for a backed-up key… [TODO]",
      run: () => lookupBackedUpKey(delay).then(() => {}),
    },
    createKey: { label: "Creating keys…", run: () => createKey(identity) },
    backUp: {
      label: "Backing up your key… [TODO]",
      run: () => backUpKey(delay),
    },
  } satisfies Record<string, SetupStep>;
}

/**
 * Runs steps in order, stopping at the first failure, then rests at `then`: done,
 * or a pause the caller resumes with another `start`. No steps means "nothing
 * more to do" and rests at once.
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
      if (state.status !== "idle" && state.status !== "paused") return;
      for (const step of steps) {
        publish({ status: "running", label: step.label });
        try {
          await step.run();
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
      publish(then);
    },
    reset() {
      if (state.status === "running") return;
      publish({ status: "idle" });
    },
  };
}
export type Setup = ReturnType<typeof createSetup>;
