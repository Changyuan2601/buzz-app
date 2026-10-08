import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

/**
 * Wireframe examples. A relay publishes only its NIP-11 icon before admission
 * and hard-codes `name: "Buzz Relay"`, so rows show the hostname (the client's
 * existing fallback) and nothing else.
 */
const EXAMPLE_INVITES = [
  "buzz.block.builderlab.xyz",
  "design.builderlab.xyz",
  "buzz.example.org",
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
        {EXAMPLE_INVITES.map((host) => (
          <li
            key={host}
            className="flex items-center gap-3 rounded-lg border border-standard p-3"
          >
            <Avatar alt="" fallback={host} />
            <p className="m-0 min-w-0 flex-1 truncate text-label text-primary">
              {host}
            </p>
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
