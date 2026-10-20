import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  hasIntegratedWindowControls,
  WindowControls,
} from "../../app/shell/WindowControls";
import { macTitleBarDragHandlers } from "../../app/shell/title-bar";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import type { Identity } from "./service";
import { RestoreIdentity } from "./RestoreIdentity";

export function IdentitySetup({
  identity,
  children,
}: {
  identity: Identity;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const [importing, setImporting] = useState(false);
  const [nsec, setNsec] = useState("");
  const [backupAvailable, setBackupAvailable] = useState(false);
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const missing = state.status === "missing";
  useEffect(() => {
    if (!missing) return;
    let active = true;
    void identity.backupAvailable().then(
      (available) => active && setBackupAvailable(available),
      () => active && setBackupAvailable(false),
    );
    void identity.legacyAvailable().then(
      (available) => active && setLegacyAvailable(available),
      () => active && setLegacyAvailable(false),
    );
    return () => {
      active = false;
    };
  }, [identity, missing]);
  useEffect(
    () => () => {
      void identity.cancelRecovery();
    },
    [identity],
  );
  const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
  const integratedWindowControls = hasIntegratedWindowControls();
  if (state.status === "ready") return children;
  return (
    <main className="p-8" aria-labelledby="identity-setup-title">
      {(macDesktop || integratedWindowControls) && (
        <header
          className="-mx-8 -mt-8 mb-8 flex h-14 items-center justify-end px-3"
          data-tauri-drag-region={integratedWindowControls || undefined}
          {...(macDesktop ? macTitleBarDragHandlers : {})}
        >
          <WindowControls />
        </header>
      )}
      <h1 id="identity-setup-title" className="text-heading">
        Your Buzz identity
      </h1>
      {state.status === "loading" ? (
        <p role="status">Opening your saved identity…</p>
      ) : state.status === "error" ? (
        <>
          <p role="alert">{state.error}</p>
          <Button onClick={() => void identity.retry()}>
            Retry secure storage access
          </Button>
        </>
      ) : (
        <>
          <p>
            Already use Buzz? Bring your existing private key to keep the same
            identity.
          </p>
          <p>
            Your key is stored securely on this device. No community is joined
            automatically.
          </p>
          {state.error && <p role="alert">{state.error}</p>}
          {state.recovery ? (
            <RestoreIdentity identity={identity} recovery={state.recovery} />
          ) : importing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const supplied = nsec;
                setNsec("");
                void identity.importKey(supplied);
              }}
            >
              <label htmlFor="import-nsec">Private key (nsec)</label>
              <Input
                id="import-nsec"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={nsec}
                disabled={state.busy}
                onChange={(event) => setNsec(event.target.value)}
              />
              <p>
                Copy this from Identity details in your old Buzz app. Never
                share it with anyone.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={state.busy || !nsec.trim()}
                >
                  Use this key
                </Button>
                <Button
                  type="button"
                  disabled={state.busy}
                  onClick={() => {
                    setNsec("");
                    setImporting(false);
                  }}
                >
                  Back
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-3">
              {legacyAvailable && (
                <Button
                  disabled={state.busy}
                  variant="primary"
                  onClick={() => void identity.importLegacy()}
                >
                  Continue with your Buzz identity
                </Button>
              )}
              <Button
                disabled={state.busy}
                variant={legacyAvailable ? "subtle" : "primary"}
                onClick={() => setImporting(true)}
              >
                Use an existing key
              </Button>
              <Button
                disabled={state.busy}
                onClick={() => void identity.create()}
              >
                Create a new identity
              </Button>
              {backupAvailable && (
                <Button
                  disabled={state.busy}
                  onClick={() => void identity.beginRecovery()}
                >
                  Restore from backup
                </Button>
              )}
            </div>
          )}
          {state.busy && !state.recovery && (
            <p role="status">Saving your identity securely…</p>
          )}
        </>
      )}
    </main>
  );
}
