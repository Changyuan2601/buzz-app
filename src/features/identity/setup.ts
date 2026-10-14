import type { FoundCommunity } from "../communities/find-community";
import type { Identity } from "./service";

export type SetupStep = Readonly<{ label: string; run: () => Promise<void> }>;
export type SetupSnapshot = Readonly<
  | { status: "idle" }
  | { status: "running"; label: string }
  | { status: "failed"; error: string }
  | { status: "done" }
>;

export const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `identity.create` reports failure through its snapshot, not by throwing. */
async function createKey(identity: Identity) {
  await identity.create();
  const state = identity.snapshot();
  if (state.status === "ready") return;
  throw new Error(
    (state.status === "missing" && state.error) ||
      "Your key could not be saved on this device.",
  );
}

/**
 * First-run steps after Builderlab sign-in, in order. `[TODO]` steps have no
 * backend yet and only wait; replace their `run` with the real call and drop the
 * marker from the label. Setup started from a community URL already knows
 * which community to join, so it skips "Finding communities".
 */
export function setupSteps(
  identity: Identity,
  delay = wait,
  { findCommunities = true } = {},
): SetupStep[] {
  return [
    { label: "Downloading keys… [TODO]", run: () => delay(2000) },
    { label: "Creating keys…", run: () => createKey(identity) },
    { label: "Uploading keys… [TODO]", run: () => delay(2000) },
    ...(findCommunities
      ? [{ label: "Finding communities… [TODO]", run: () => delay(2000) }]
      : []),
  ];
}

export type Authentication = "builderlab";

/**
 * Which sign-in a community URL given before setup leads to.
 *
 * TODO: nothing a relay publishes identifies its host today (NIP-11 `self` is
 * the likeliest future signal), so every community URL is treated as
 * Builderlab-hosted.
 */
export function discoverAuthentication(_found: FoundCommunity): Authentication {
  return "builderlab";
}

/** Runs the given steps once, stopping at the first failure. */
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
    async start(steps: readonly SetupStep[]) {
      if (state.status !== "idle") return;
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
      publish({ status: "done" });
    },
    reset() {
      if (state.status === "running") return;
      publish({ status: "idle" });
    },
  };
}
export type Setup = ReturnType<typeof createSetup>;
