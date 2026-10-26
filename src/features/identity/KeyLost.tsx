import { Button } from "../../shared/design-system/ui/Button";
import type { OwnedCommunity } from "./builderlab-account";

/**
 * Pause for a linked key the user no longer has. Starting over creates a new
 * key, unlinks this one, links the new one in its place and backs it up, with
 * no key choice between; the page spells out what the old key keeps and, as
 * Set up your key does, that Block can restore the new one.
 */
export function KeyLost({
  owned,
  onBack,
  onStartOver,
}: {
  /** The communities the old key owns; `undefined` when the list could not be loaded. */
  owned: readonly OwnedCommunity[] | undefined;
  onBack: () => void;
  onStartOver: () => void;
}) {
  return (
    <>
      <div>
        <h1 id="welcome-title" className="text-title text-primary">
          Start over with a new key
        </h1>
        <p className="mt-2 text-body text-secondary">
          A new key is a new identity. Everything the old key could reach stays
          with it: its profile, its messages and the communities it belongs to.
          Starting over unlinks the old key, then creates a new key, links it to
          this account and keeps an encrypted copy that Block can use to restore
          it.
        </p>
      </div>
      {/* Unstyled wireframe: a plain border until the panel gets a design. */}
      <div className="flex flex-col gap-2 rounded-lg border border-standard p-3">
        <h2 className="m-0 text-body text-secondary">Communities you own</h2>
        {owned === undefined ? (
          <p className="m-0 text-body text-primary">
            Couldn’t load the communities this account owns.
          </p>
        ) : owned.length === 0 ? (
          <p className="m-0 text-body text-primary">None</p>
        ) : (
          <ul
            aria-label="Communities you own"
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {owned.map(({ host, url }) => (
              <li key={url} className="truncate text-label text-primary">
                {host}
              </li>
            ))}
          </ul>
        )}
        <p className="m-0 text-body-sm text-secondary">
          Memberships in other people’s communities can’t be listed here and
          will also be lost.
        </p>
      </div>
      {/* Footer order: secondary first, primary last. */}
      <div className="flex gap-3">
        <Button onClick={onBack}>Back</Button>
        <Button variant="destructive" onClick={onStartOver}>
          Start over with a new key
        </Button>
      </div>
    </>
  );
}
