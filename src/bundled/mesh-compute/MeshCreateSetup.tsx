import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
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
  const [choice, setChoice] = useState("use");
  const phase = status?.lifecycle?.state;
  // A saved preference alone does not prove that sharing actually started.
  if (
    !otherCommunity &&
    status?.sharing &&
    (phase === "ready" || phase === "starting")
  )
    return null;
  const failure =
    error ??
    status?.settingsError ??
    (phase === "failed"
      ? "Shared compute needs recovery. Open Settings → Shared compute."
      : null);
  const canShare =
    status?.available &&
    leaseReady &&
    !otherCommunity &&
    phase !== "failed" &&
    phase !== "stopping";
  return (
    <section aria-label="Set up shared compute" className="grid gap-4">
      <Field label="How will your agent run?" nativeLabel={false}>
        <RadioGroup
          value={choice}
          onValueChange={setChoice}
          disabled={disabled || busy}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid content-start gap-3">
              <Radio
                variant="card"
                value="share"
                label="Use this computer"
                description="Share compute with your community. Auto chooses a model for this computer."
                disabled={!canShare}
              />
              {choice === "share" && (
                <>
                  <Button
                    variant="primary"
                    disabled={disabled || busy || !canShare}
                    loading={busy}
                    onClick={share}
                  >
                    Start sharing with Auto
                  </Button>
                  <p className="m-0 text-body-sm text-secondary">
                    Downloads a model if needed, in the background. You can
                    create your agent while it starts.
                  </p>
                </>
              )}
            </div>
            <Radio
              variant="card"
              value="use"
              label="Use community compute"
              description="No local model download. Your agent needs someone in the community to be sharing."
            />
          </div>
        </RadioGroup>
      </Field>
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
