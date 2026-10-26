import { Button } from "../../shared/design-system/ui/Button";
import styles from "./IdentitySetup.module.css";
import { OnboardingScreen } from "./OnboardingScreen";

/**
 * Pause on an unlinked account: create a key, which is then linked and backed
 * up, or bring an existing one. The copy discloses that Block can restore the
 * key, since choosing to create it is the backup consent.
 */
export function KeyChoice({
  email,
  backups,
  onCreate,
  onImport,
}: {
  /** The signed-in Builderlab account the lookup ran for. */
  email: string | undefined;
  /**
   * The keys the backed-up-key lookup listed; `undefined` when it was
   * unavailable or failed. Backups outlive an unlink, so an unlinked account
   * may still list some, and only an empty list says none was found.
   */
  backups: readonly string[] | undefined;
  /** Create the key, link it to the account, then back it up. */
  onCreate: () => void;
  /** The user already has a key: open the import page. */
  onImport: () => void;
}) {
  // The welcome screen's create-or-import stack, after sign-in.
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <div className={styles.importContent}>
          <h1 id="welcome-title" className="text-heading text-primary">
            Set up your key
          </h1>
          <p className="text-body text-secondary">
            Buzz signs everything you do with a private key kept on this device.
            {backups?.length === 0 &&
              ` We didn’t find a backed-up key for ${email ?? "your account"}, so let’s make one.`}{" "}
            Builderlab keeps an encrypted copy that Block can use to restore it
            on your other devices.
          </p>
        </div>
      }
    >
      <Button variant="prominent" size="lg" onClick={onCreate}>
        Create my key
      </Button>
      <Button variant="ghost" size="lg" onClick={onImport}>
        I already have a key
      </Button>
    </OnboardingScreen>
  );
}
