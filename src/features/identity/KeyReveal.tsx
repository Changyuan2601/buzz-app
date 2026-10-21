import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { PrivateKey } from "./PrivateKey";
import type { Identity } from "./service";

/**
 * Pause after "Creating keys…" when the user keeps their own copy, or after
 * its link or backup failed: the nsec, visible on arrival, with Copy. Leaving
 * without a backup needs the box ticked; without `onBackUp` (this sign-in
 * cannot back a key up) a backup is not offered.
 * No save-to-file: the webview has no save dialog and no file plugin, so a
 * key file would have to be written natively, which is deferred.
 */
export function KeyReveal({
  identity,
  onBackUp,
  onContinue,
}: {
  identity: Identity;
  /** Builderlab keeps a copy after all. */
  onBackUp?: (() => void) | undefined;
  /** The user has the only copy. */
  onContinue: () => void;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <>
      <div>
        <h1 id="welcome-title" className="text-title text-primary">
          Your private identity key
        </h1>
        <p className="mt-2 text-body text-secondary">
          This key is how you sign in to Buzz. Don’t share it — anyone who has
          it can access your account. Because only you control it, nobody — not
          Buzz, not Builderlab — can reset or recover it if it’s lost. Copy it
          into a password manager like 1Password now.
        </p>
      </div>
      {/* Unstyled wireframe: a plain border until the key panel gets a design. */}
      <div className="rounded-lg border border-standard p-3">
        <PrivateKey identity={identity} initiallyRevealed />
      </div>
      <Checkbox
        label="I’ve saved my private key somewhere safe"
        checked={saved}
        onCheckedChange={setSaved}
      />
      {/* Footer order: secondary first, primary last. */}
      <div className="flex gap-3">
        <Button onClick={onContinue} disabled={!saved}>
          Continue without backing up
        </Button>
        {onBackUp && (
          <Button variant="primary" onClick={onBackUp}>
            Please back this up for me
          </Button>
        )}
      </div>
    </>
  );
}
