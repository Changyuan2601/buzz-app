import { useState, useSyncExternalStore } from "react";
import type { Agents, AgentsSnapshot } from "../features/agents/service";
import type {
  DecisionBackend,
  DecisionsService,
} from "../features/decisions/service";
import { isApplePlatform } from "../features/shortcuts/format";
import { Button } from "../shared/design-system/ui/Button";
import { Field } from "../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { Input } from "../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";

const KEY_STATUS: Record<AgentsSnapshot["classifierKey"], string> = {
  checking: "Checking for a saved key…",
  saved: "Your TypeSafe key is saved.",
  missing: "Add your TypeSafe API key to use TypeSafe.",
  unreadable:
    "Buzz could not read your saved key. Unlock your keychain, or replace or remove the key.",
  refused:
    "TypeSafe did not accept your key. Replace it to keep using TypeSafe.",
};

const PROVIDERS: readonly {
  value: DecisionBackend;
  label: string;
  description: string;
}[] = [
  {
    value: "typesafe",
    label: "TypeSafe",
    description: "Use your own TypeSafe API key.",
  },
];

/** Chooses the provider that answers decisions on this device, and sets or
 * removes the TypeSafe key. The key goes straight to native storage and is
 * never shown again. */
export function DecisionsSettings({
  decisions,
  agents,
  active,
  apple = isApplePlatform(navigator.platform),
}: {
  decisions: Pick<DecisionsService, "backend" | "subscribe" | "setBackend">;
  agents: Pick<
    Agents,
    "snapshot" | "subscribe" | "setClassifierKey" | "clearClassifierKey"
  >;
  active(): boolean;
  /** Whether the key goes to the macOS Keychain. */
  apple?: boolean;
}) {
  const state = useSyncExternalStore(
    agents.subscribe,
    agents.snapshot,
    agents.snapshot,
  );
  const backend = useSyncExternalStore(
    decisions.subscribe,
    decisions.backend,
    decisions.backend,
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const desktop = state.status !== "unavailable";
  const keyState = state.classifierKey;
  // A key may be saved in each state but these two.
  const saved = keyState !== "missing" && keyState !== "checking";
  const run = async (action: () => Promise<void>) => {
    if (!active() || busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      setKey("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="decisions-settings-title">
      <Header
        id="decisions-settings-title"
        title="Decisions"
        subtitle="Choose the provider Buzz uses for decisions on this device."
      />
      {!desktop ? (
        <p role="status" className="mt-4 text-body-sm text-secondary">
          Open the Buzz desktop app to choose a provider.
        </p>
      ) : (
        <div
          data-buzz-ui=""
          className="mt-section-gap flex flex-col items-start gap-section-gap"
        >
          <div className="w-full max-w-md">
            <InlineHeader title="Provider" />
            <Field
              label="Provider"
              labelVisibility="hidden"
              nativeLabel={false}
            >
              <RadioGroup
                aria-label="Provider"
                value={backend}
                onValueChange={(value) => {
                  if (active()) decisions.setBackend(value as DecisionBackend);
                }}
              >
                {PROVIDERS.map((option) => (
                  <Radio
                    key={option.value}
                    value={option.value}
                    variant="card"
                    label={option.label}
                    description={option.description}
                  />
                ))}
              </RadioGroup>
            </Field>
          </div>
          {backend === "typesafe" && (
            <div className="flex w-full max-w-md flex-col items-start gap-3">
              <InlineHeader title="TypeSafe" />
              <p role="status" className="text-body-sm text-secondary">
                {KEY_STATUS[keyState]}{" "}
                {apple
                  ? "It is kept in this Mac's Keychain."
                  : "It is kept in this device's credential store."}
              </p>
              <form
                className="flex w-full flex-col items-start gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = key.trim();
                  if (value) void run(() => agents.setClassifierKey(value));
                }}
              >
                <Field label="TypeSafe API key">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={busy}
                    value={key}
                    placeholder={saved ? "Saved key unchanged" : "Paste a key"}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    variant="prominent"
                    disabled={busy || !key.trim()}
                  >
                    {saved ? "Replace key" : "Save key"}
                  </Button>
                  {saved && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() => agents.clearClassifierKey())
                      }
                    >
                      Remove key
                    </Button>
                  )}
                </div>
              </form>
              {error && (
                <p role="alert" className="text-body-sm text-danger">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
