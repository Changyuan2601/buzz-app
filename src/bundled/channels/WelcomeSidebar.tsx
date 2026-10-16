import { useRef, useState } from "react";
import { welcomeTarget } from "../../features/channel-navigation/routes";
import type { Navigation } from "../../features/navigation/controller";
import {
  readWelcome,
  useWelcomeReceipt,
  WELCOME_KEY,
} from "../../features/sessions/welcome";
import { clearView } from "../../shared/view-state";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";

/** Solo's way back into an unfinished Welcome, and a dev-only restart. */
export function WelcomeSidebar({
  scope,
  navigator,
  selected,
  chats,
}: {
  scope: string;
  navigator: Navigation;
  /** The Welcome page is open. */
  selected: boolean;
  /** The owner's Solo chats in this community. */
  chats: readonly string[];
}) {
  const { receipt, error } = useWelcomeReceipt(scope);
  const [restartRevision, setRestartRevision] = useState<string>();
  const [restartError, setRestartError] = useState("");
  const restartTrigger = useRef<HTMLButtonElement>(null);
  const open = () => void navigator.open(welcomeTarget(scope));
  const restartReady =
    !error && (!receipt || !!receipt.complete || !!receipt.replyId);
  const restart = () => {
    try {
      const current = readWelcome(scope);
      if (current && JSON.stringify(current) !== restartRevision) {
        setRestartError(
          "Welcome changed. Close this confirmation and try again.",
        );
        return;
      }
      clearView(scope, WELCOME_KEY);
      setRestartRevision(undefined);
      open();
    } catch {
      setRestartError(
        "Couldn't restart Welcome. Your existing setup is kept. Try again.",
      );
    }
  };
  return (
    <>
      {!receipt?.complete &&
        (!import.meta.env.DEV || !!receipt) &&
        !chats.includes(receipt?.channelId ?? "") && (
          <NavigationItem label="Welcome" selected={selected} onClick={open} />
        )}
      {import.meta.env.DEV && (
        <NavigationItem
          ref={restartTrigger}
          label="Restart welcome"
          disabled={!restartReady}
          title={
            restartReady
              ? undefined
              : "Finish or resume the current setup before restarting"
          }
          onClick={() => {
            setRestartError("");
            if (receipt) setRestartRevision(JSON.stringify(receipt));
            else open();
          }}
        />
      )}
      {restartRevision !== undefined && (
        <AlertDialog
          title="Restart welcome?"
          description="Your existing agent and chat will stay. Continue will create a new agent and Welcome chat in this community. Your provider stays connected, and your current default stays selected until you save the new setup."
          finalFocus={restartTrigger}
          onClose={() => setRestartRevision(undefined)}
          actions={
            <>
              <Button onClick={() => setRestartRevision(undefined)}>
                Cancel
              </Button>
              <Button variant="prominent" onClick={restart}>
                Restart welcome
              </Button>
            </>
          }
        >
          {restartError && <p role="alert">{restartError}</p>}
        </AlertDialog>
      )}
    </>
  );
}
