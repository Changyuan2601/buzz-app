import { Button } from "../../shared/design-system/ui/Button";

/**
 * Pause after the backed-up-key lookup found nothing: who looks after the key.
 * The first two choices create the key next; the third brings an existing one.
 * Without `onManaged` (this sign-in cannot back a key up) the first is not
 * offered, nor is Builderlab's copy mentioned.
 */
export function KeyChoice({
  email,
  onManaged,
  onOwn,
  onImport,
}: {
  /** The signed-in Builderlab account the lookup ran for. */
  email: string | undefined;
  /** Builderlab keeps a copy: create the key, then back it up. */
  onManaged?: (() => void) | undefined;
  /** The user keeps the only copy: create the key, then show it. */
  onOwn: () => void;
  /** The user already has a key: open the import page. */
  onImport: () => void;
}) {
  return (
    <>
      <div>
        <h1 id="welcome-title" className="text-title text-primary">
          Set up your key
        </h1>
        <p className="mt-2 text-body text-secondary">
          Buzz signs everything you do with a private key kept on this device.
          We didn’t find a backed-up key for {email ?? "your account"}, so let’s
          make one.
          {onManaged &&
            " Builderlab can keep a copy so you can sign in on other devices, or you can look after it yourself."}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {onManaged && (
          <Button variant="primary" size="lg" onClick={onManaged}>
            Manage my keys for me
          </Button>
        )}
        {/* Secondary choices are deliberately smaller than the primary. */}
        <Button size="sm" onClick={onOwn}>
          I want to manage my own key
        </Button>
        <Button size="sm" onClick={onImport}>
          I already have a key
        </Button>
      </div>
    </>
  );
}
