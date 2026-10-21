import { useSyncExternalStore } from "react";
import type {
  KeepAwake,
  KeepAwakeSnapshot,
} from "../features/agents/keep-awake";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Button } from "../shared/design-system/ui/Button";

const unavailable: KeepAwakeSnapshot = Object.freeze({
  supported: false,
  enabled: false,
  working: false,
  active: false,
  expired: false,
  pending: false,
  saveError: null,
});
const noSubscription = () => () => {};
const noSnapshot = () => unavailable;

export function KeepAwakePreference({
  keepAwake,
  active,
}: {
  keepAwake: KeepAwake | undefined;
  active: boolean;
}) {
  const state = useSyncExternalStore(
    keepAwake?.subscribe ?? noSubscription,
    keepAwake?.snapshot ?? noSnapshot,
  );
  let description =
    "Prevent automatic sleep while local agents work on this computer. Displays can still sleep.";
  if (!state.supported)
    description = "Available in the Buzz desktop app on macOS.";
  else if (state.expired)
    description =
      "Sleep prevention paused after one hour without agent activity. It resumes when agents work again.";
  else if (state.enabled && !state.pending && !state.error)
    description += state.active
      ? " Sleep prevention is active."
      : " Waiting for local agent work.";
  return (
    <>
      <SwitchPreferenceRow
        label="Keep awake while local agents work"
        description={description}
        checked={state.enabled}
        disabled={!state.supported}
        onCheckedChange={(enabled) => keepAwake?.setEnabled(enabled)}
      />
      {active && (state.error || state.saveError) && (
        <ToastNotice
          title="Keep-awake setting needs attention"
          description={state.error ?? state.saveError ?? ""}
        >
          <Button type="button" size="sm" onClick={() => keepAwake?.retry()}>
            Retry keep-awake setting
          </Button>
        </ToastNotice>
      )}
    </>
  );
}
