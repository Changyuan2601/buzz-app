import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import type { OwnedCommunity } from "./builderlab-account";
import { CommunityUrlField } from "./CommunityUrlField";

/**
 * First-run landing after setup. The community URL is the live action; a
 * linked account's owned communities are offered as rows that take the same
 * path with their address.
 */
export function JoinCommunity({
  url,
  onUrlChange,
  onFind,
  owned = [],
}: {
  url: string;
  onUrlChange: (url: string) => void;
  /** Receives the canonical secure origin, and an invite link's code when one was pasted. */
  onFind: (origin: string, code?: string) => void;
  owned?: readonly OwnedCommunity[] | undefined;
}) {
  return (
    <>
      <h1 id="welcome-title" className="text-heading text-primary">
        Join a community
      </h1>
      {owned.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="m-0 text-body text-secondary">Communities you own</h2>
          <ul
            aria-label="Communities you own"
            className="m-0 flex list-none flex-col gap-3 p-0"
          >
            {owned.map(({ host, url: origin }) => (
              <li
                key={origin}
                className="flex items-center gap-3 rounded-lg border border-standard p-3"
              >
                <Avatar alt="" fallback={host} />
                <p className="m-0 min-w-0 flex-1 truncate text-label text-primary">
                  {host}
                </p>
                <Button onClick={() => onFind(origin)}>Join</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col gap-3">
        <CommunityUrlField
          url={url}
          onUrlChange={onUrlChange}
          onSubmit={onFind}
        />
        <Button size="lg" disabled>
          Scan a QR code — Coming soon
        </Button>
        <Button size="lg" disabled>
          Create a community — Coming soon
        </Button>
      </div>
    </>
  );
}
