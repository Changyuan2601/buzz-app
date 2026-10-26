import { useSyncExternalStore } from "react";

/** inline reads a thread in a sheet over its conversation; main and side open
 * it in a tab in that pane. */
export type ThreadPlacement = "inline" | "main" | "side";
const preferenceKey = "buzz-thread-placement.v1";
const changedEvent = "buzz-thread-placement-changed";
let unsavedPreference: ThreadPlacement | undefined;

/** Device-local default for new tabs, never an instruction to move existing ones. */
export function threadPlacementPreference(): ThreadPlacement {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    const saved = localStorage.getItem(preferenceKey);
    return saved === "main" || saved === "side" ? saved : "inline";
  } catch {
    return "inline";
  }
}
/** The pane a new thread tab opens in; inline threads still open their tabs
 * beside the conversation. */
export function threadTabPane(): "main" | "side" {
  return threadPlacementPreference() === "main" ? "main" : "side";
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    unsavedPreference = undefined;
    listener();
  };
  window.addEventListener(changedEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changedEvent, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useThreadPlacementPreference() {
  const placement = useSyncExternalStore(subscribe, threadPlacementPreference);
  // Saving the same active choice changes recovery state, not its placement.
  const unsaved = useSyncExternalStore(
    subscribe,
    () => unsavedPreference !== undefined,
  );
  return { placement, unsaved };
}
export function setThreadPlacementPreference(value: ThreadPlacement): void {
  unsavedPreference = value;
  try {
    localStorage.setItem(preferenceKey, value);
    unsavedPreference = undefined;
  } catch {
    // Retain the active choice and its recovery state across settings remounts.
  }
  window.dispatchEvent(new Event(changedEvent));
}
