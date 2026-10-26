import { Button } from "../../shared/design-system/ui/Button";

/**
 * Pause after the backed-up-key lookup found nothing: create a key, which is
 * then linked and backed up, or bring an existing one. The copy discloses that
 * Block can restore the key, since choosing to create it is the backup consent.
 */
export function KeyChoice({
  email,
  onCreate,
  onImport,
}: {
  /** The signed-in Builderlab account the lookup ran for. */
  email: string | undefined;
  /** Create the key, link it to the account, then back it up. */
  onCreate: () => void;
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
          make one. Builderlab keeps an encrypted copy that Block can use to
          restore it on your other devices.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Button variant="primary" size="lg" onClick={onCreate}>
          Create my key
        </Button>
        {/* The secondary choice is deliberately smaller than the primary. */}
        <Button size="sm" onClick={onImport}>
          I already have a key
        </Button>
      </div>
    </>
  );
}
