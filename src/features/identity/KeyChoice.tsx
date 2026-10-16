import { Button } from "../../shared/design-system/ui/Button";

/**
 * Pause after the backed-up-key lookup found nothing: who looks after the key.
 * Both live choices create the key next; the import path has no backend yet.
 */
export function KeyChoice({
  email,
  onManaged,
  onOwn,
}: {
  /** The signed-in Builderlab account the lookup ran for. */
  email: string | undefined;
  /** Builderlab keeps a copy: create the key, then back it up. */
  onManaged: () => void;
  /** The user keeps the only copy: create the key, then show it. */
  onOwn: () => void;
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
          make one. Builderlab can keep a copy so you can sign in on other
          devices, or you can look after it yourself.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Button variant="primary" size="lg" onClick={onManaged}>
          Manage my keys for me
        </Button>
        {/* Secondary choices are deliberately smaller than the primary. */}
        <Button size="sm" onClick={onOwn}>
          I want to manage my own key
        </Button>
        {/* Import takes the key setup screen's path once a backend decides what to do with it. */}
        <Button size="sm" disabled>
          I already have a key — Coming soon
        </Button>
      </div>
    </>
  );
}
