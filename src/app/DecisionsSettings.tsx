import { useEffect, useState, useSyncExternalStore } from "react";
import type { DecisionsService } from "../features/decisions/service";
import { Field } from "../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";

/** What any provider receives. The host says it once, for every provider. */
const DISCLOSURE =
  "Your decisions provider receives the message text that plugins send it, including from private channels.";

/** Chooses the provider that answers decisions on this device and shows the
 * selected provider's own settings. Providers are plugins. One picked before
 * it is ready shows its settings, but the choice is saved only once it is
 * ready, so a working provider keeps answering until then. */
export function DecisionsSettings({
  decisions,
  active,
}: {
  decisions: Pick<
    DecisionsService,
    "backend" | "subscribe" | "setBackend" | "providers"
  >;
  active(): boolean;
}) {
  const backend = useSyncExternalStore(
    decisions.subscribe,
    decisions.backend,
    decisions.backend,
  );
  const providers = useSyncExternalStore(
    decisions.subscribe,
    decisions.providers,
    decisions.providers,
  );
  const [picked, setPicked] = useState<string>();
  const pending = providers.find((provider) => provider.key === picked);
  // Re-read on every change: a provider's status is its own.
  const pendingReady = useSyncExternalStore(
    decisions.subscribe,
    () => pending?.status() === "ready",
    () => false,
  );
  useEffect(() => {
    if (!pending || !pendingReady) return;
    setPicked(undefined);
    decisions.setBackend(pending.key);
  }, [pending, pendingReady, decisions]);
  const selected = pending && pending.key !== backend ? pending : undefined;
  const shown =
    selected ?? providers.find((provider) => provider.key === backend);
  const Settings = shown?.Settings;
  return (
    <section aria-labelledby="decisions-settings-title">
      <Header
        id="decisions-settings-title"
        title="Decisions API"
        subtitle={DISCLOSURE}
      />
      {providers.length === 0 ? (
        <p role="status" className="mt-4 text-body-sm text-secondary">
          No decision provider is turned on. Turn one on in Settings &gt;
          Plugins.
        </p>
      ) : (
        <div
          data-buzz-ui=""
          className="mt-section-gap flex flex-col items-start gap-section-gap"
        >
          {providers.length > 1 && (
            <div className="w-full max-w-md">
              <InlineHeader title="Decisions API Provider" />
              <Field
                label="Decisions API Provider"
                labelVisibility="hidden"
                nativeLabel={false}
              >
                <RadioGroup
                  aria-label="Decisions API Provider"
                  value={shown?.key ?? ""}
                  onValueChange={(value) => {
                    if (!active()) return;
                    const next = providers.find(
                      (provider) => provider.key === value,
                    );
                    if (!next) return;
                    if (next.status() === "ready" || next.key === backend) {
                      setPicked(undefined);
                      decisions.setBackend(next.key);
                    } else setPicked(next.key);
                  }}
                >
                  {providers.map((provider) => (
                    <Radio
                      key={provider.key}
                      value={provider.key}
                      variant="card"
                      label={provider.label}
                      description={provider.description}
                    />
                  ))}
                </RadioGroup>
              </Field>
            </div>
          )}
          {shown && (
            <div className="flex w-full max-w-md flex-col items-start gap-3">
              <InlineHeader title={shown.label} />
              {Settings && <Settings active={active} />}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
