import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

/**
 * Wireframe examples. A relay publishes only its NIP-11 icon and join policy
 * before admission; it hard-codes `name: "Buzz Relay"` and exposes no counts, so
 * rows show the hostname (the client's existing fallback) and policy hints only.
 */
const EXAMPLE_INVITES: ReadonlyArray<{ host: string; hints: string[] }> = [
  { host: "buzz.block.builderlab.xyz", hints: ["Terms required", "18+"] },
  { host: "design.builderlab.xyz", hints: ["Terms required"] },
  { host: "buzz.example.org", hints: [] },
];

/** First-run landing after setup. Every action is a disabled placeholder. */
export function JoinCommunity() {
  return (
    <>
      <h1 id="welcome-title" className="text-title text-primary">
        Join a community
      </h1>
      <ul
        aria-label="Pending invites"
        className="m-0 flex list-none flex-col gap-3 p-0"
      >
        {EXAMPLE_INVITES.map(({ host, hints }) => (
          <li
            key={host}
            className="flex items-center gap-3 rounded-lg border border-standard p-3"
          >
            <Avatar alt="" fallback={host} />
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-label text-primary">{host}</p>
              <p className="m-0 text-caption text-secondary">
                {hints.map((hint) => (
                  <span key={hint}>{hint} · </span>
                ))}
                <span>Coming soon</span>
              </p>
            </div>
            <Button disabled>Join</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3">
        <Field label="Community URL" disabled>
          <Input type="url" placeholder="Coming soon" disabled />
        </Field>
        <Button size="lg" disabled>
          Try joining — Coming soon
        </Button>
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
