import { Button } from "../../shared/design-system/ui/Button";
import { CommunityUrlField } from "./CommunityUrlField";

/** First-run landing after setup. Only the community URL is a live action. */
export function JoinCommunity({
  url,
  onUrlChange,
  onFind,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  /** Receives the canonical secure origin the typed address normalizes to. */
  onFind: (origin: string) => void;
}) {
  return (
    <>
      <h1 id="welcome-title" className="text-title text-primary">
        Join a community
      </h1>
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
