import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import type { MeshStatus } from "./index";

/** Creation borrows the existing compute page's lifecycle; no setup record or runner. */
export function MeshCreateSetup({
  status,
  busy,
  disabled,
  leaseReady,
  otherCommunity,
  error,
  share,
  refresh,
}: {
  status: MeshStatus | null;
  busy: boolean;
  disabled: boolean;
  leaseReady: boolean;
  otherCommunity: boolean;
  error: string | null;
  share(): void;
  refresh(): void;
}) {
  const [choice, setChoice] = useState<"share" | "use" | null>(null);
  const confirmation = useRef<HTMLParagraphElement>(null);
  const phase = status?.lifecycle?.state;
  const sharing =
    !otherCommunity &&
    Boolean(status?.sharing) &&
    (phase === "ready" || phase === "starting");
  const failure =
    error ??
    status?.settingsError ??
    (phase === "failed"
      ? "Shared compute needs recovery. Open Settings → Shared compute."
      : null);
  const confirmed =
    choice === "use" || (choice === "share" && sharing && !failure);
  useEffect(() => {
    if (confirmed) confirmation.current?.focus();
  }, [confirmed]);
  // Existing sharing needs no setup; a choice made here keeps its confirmation.
  if (sharing && choice === null && !failure) return null;
  const canShare =
    status?.available &&
    leaseReady &&
    !otherCommunity &&
    phase !== "failed" &&
    phase !== "stopping";
  return (
    <section aria-label="Set up shared compute" className="grid gap-4">
      {confirmed ? (
        <div className="grid gap-2">
          <p
            ref={confirmation}
            tabIndex={-1}
            role="status"
            className="m-0 text-body"
          >
            {choice === "use"
              ? "Using community compute. You can create your agent now."
              : phase === "ready"
                ? "This computer is sharing. You can create your agent now."
                : "Sharing is starting. Downloads continue in the background; you can create your agent now."}
          </p>
          {choice === "use" && (
            <Button
              size="sm"
              disabled={disabled || busy}
              onClick={() => setChoice(null)}
            >
              Change
            </Button>
          )}
        </div>
      ) : (
        <>
          <InlineHeader title="How will your agent run?" />
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <SettingsGroup layout="form">
              <InlineHeader title="Use this computer" level={4} />
              <p className="m-0 text-body-sm text-secondary">
                Share compute with your community. Auto chooses a model for this
                computer.
              </p>
              <Button
                size="sm"
                variant="primary"
                disabled={disabled || busy || !canShare}
                loading={busy}
                onClick={() => {
                  setChoice("share");
                  share();
                }}
              >
                Start sharing with Auto
              </Button>
              <p className="m-0 text-body-sm text-secondary">
                Downloads a model if needed, in the background. You can create
                your agent while it starts.
              </p>
            </SettingsGroup>
            <SettingsGroup layout="form">
              <InlineHeader title="Use community compute" level={4} />
              <p className="m-0 text-body-sm text-secondary">
                No local model download. Your agent needs someone in the
                community to be sharing.
              </p>
              <Button
                size="sm"
                disabled={disabled || busy}
                onClick={() => setChoice("use")}
              >
                Continue without sharing
              </Button>
            </SettingsGroup>
          </div>
          <p role="status" className="m-0 text-body-sm text-secondary">
            {busy
              ? "Starting shared compute. You can create your agent while setup continues."
              : !status
                ? "Checking shared compute…"
                : !status.available
                  ? "Shared compute is unavailable in this build."
                  : otherCommunity
                    ? "This computer is connected to another community. Switch communities in Settings → Shared compute to share here."
                    : "You can change sharing in Settings → Shared compute."}
          </p>
        </>
      )}
      {failure && (
        <div className="grid gap-2">
          <p role="alert" className="m-0 text-body-sm text-danger">
            {failure}
          </p>
          <Button size="sm" disabled={disabled || busy} onClick={refresh}>
            Check again
          </Button>
        </div>
      )}
    </section>
  );
}
