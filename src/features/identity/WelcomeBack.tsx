import { Button } from "../../shared/design-system/ui/Button";
import { PublicKeyPanel } from "./PublicKeyPanel";

/**
 * Pause after the account check found a key already linked to the signed-in
 * Builderlab account. Binding is 1:1, so this lane never creates a key: the
 * user brings the linked one, restores it from a backup, or starts over
 * without it.
 */
export function WelcomeBack({
  npub,
  onRestore,
  onImport,
  onLost,
}: {
  /** The linked key, as the account's npub. */
  npub: string;
  /** Restore the linked key; set only when backup status lists it. */
  onRestore?: (() => void) | undefined;
  /** Open the import page, which accepts only this key. */
  onImport: () => void;
  /** Open the start-over page. */
  onLost: () => void;
}) {
  return (
    <>
      <div>
        <h1 id="welcome-title" className="text-heading text-primary">
          Welcome back
        </h1>
        <p className="mt-2 text-body text-secondary">
          This account is already linked to a Buzz identity — the key you use on
          your other device.
          {onRestore
            ? " Restore it from your backup, or enter that key to continue."
            : " Enter that key to continue."}
        </p>
      </div>
      <PublicKeyPanel publicKey={npub} heading="Linked public key (npub)" />
      <div className="flex flex-col gap-3">
        {onRestore && (
          <Button variant="primary" size="lg" onClick={onRestore}>
            Restore from backup
          </Button>
        )}
        {/* Secondary choices are deliberately smaller than the primary. */}
        <Button
          variant={onRestore ? "subtle" : "primary"}
          size={onRestore ? "sm" : "lg"}
          onClick={onImport}
        >
          Enter your private key
        </Button>
        {/* Future entry for NIP-AB device pairing: the signed-in device hands the key over. */}
        <Button size="sm" disabled>
          Recover from another device — Coming soon
        </Button>
        {/* Quieter than the other choices: starting over loses the old identity. */}
        <Button size="sm" variant="ghost" onClick={onLost}>
          I lost this key
        </Button>
      </div>
    </>
  );
}
