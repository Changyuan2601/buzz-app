import { useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { Recovery } from "./builderlab-account";
import styles from "./IdentitySetup.module.css";
import { OnboardingScreen } from "./OnboardingScreen";
import { RestoreIdentity } from "./RestoreIdentity";
import { recoveryOff } from "./service";

/**
 * Pause after Welcome back's Restore from backup: native recovery's browser
 * sign-in, then the linked key's backup to install. Where recovery is
 * unavailable or refused, which no retry changes, or no backup holds the
 * linked key, the page offers Enter your private key instead of Try again.
 */
export function KeyRestore({
  recovery,
  expectedPubkey,
  onBack,
  onImport,
  onInstalled,
}: {
  recovery: Recovery;
  /** The hex key linked to the account: the only one restored. */
  expectedPubkey: string;
  /** Recovery was canceled: return to Welcome back. */
  onBack: () => void;
  /** Recovery was canceled: open the import page. */
  onImport: () => void;
  /** Installing settled, restored or not. */
  onInstalled: () => void;
}) {
  const state = useSyncExternalStore(recovery.subscribe, recovery.snapshot);
  // A recovery holds the identity busy, so leaving cancels it first.
  const leave = (then: () => void) => () =>
    recovery.cancelRecovery().then((canceled) => {
      if (canceled) then();
      return canceled;
    });
  const off = recoveryOff(state);
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <div className={styles.setup}>
          <div className={styles.setupContent}>
            <h1 id="welcome-title" className="text-heading text-primary">
              Restore from backup
            </h1>
            <p className="text-body text-secondary">
              {off
                ? "Builderlab can’t restore keys for this account. Enter your private key to continue."
                : "Your key is stored securely on this device."}
            </p>
            {off ? (
              // Footer order: secondary first, primary last.
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => void leave(onBack)()}>Back</Button>
                <Button
                  variant="primary"
                  onClick={() => void leave(onImport)()}
                >
                  Enter your private key
                </Button>
              </div>
            ) : state ? (
              <RestoreIdentity
                identity={{
                  beginRecovery: recovery.beginRecovery,
                  cancelRecovery: leave(onBack),
                  installRecovery: (handle) =>
                    recovery.installRecovery(handle).then(onInstalled),
                }}
                recovery={state}
                expectedPubkey={expectedPubkey}
                onImport={() => void leave(onImport)()}
              />
            ) : null}
          </div>
        </div>
      }
    >
      {null}
    </OnboardingScreen>
  );
}
